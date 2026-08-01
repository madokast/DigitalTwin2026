package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/fc/internal/auth"
	"github.com/mdk/digitaltwin2026/fc/internal/draft"
	"github.com/mdk/digitaltwin2026/fc/internal/logapi"
	"github.com/mdk/digitaltwin2026/fc/internal/query"
	"github.com/mdk/digitaltwin2026/fc/internal/record"
	"github.com/mdk/digitaltwin2026/fc/internal/tags"
	"github.com/mdk/digitaltwin2026/fc/internal/telegram"
)

// MaxBodyBytes 与 Next MAX_HTTP_BODY_BYTES（256 KiB）对齐。
const MaxBodyBytes = 256 * 1024

// ErrBodyTooLarge / BodyTooLargeMessage 与 Next REQUEST_BODY_TOO_LARGE 同文案。
var ErrBodyTooLarge = errors.New("Request body too large")

const BodyTooLargeMessage = "Request body too large"

type Server struct {
	Pool     *pgxpool.Pool
	Tokens   auth.Tokens
	Now      func() time.Time
	Telegram *telegram.Sender
}

func NewServer(pool *pgxpool.Pool, tokens auth.Tokens) *Server {
	return &Server{
		Pool:     pool,
		Tokens:   tokens,
		Now:      time.Now,
		Telegram: telegram.Default,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/log/number", s.handleLogNumber)
	mux.HandleFunc("POST /api/log/text", s.handleLogText)
	mux.HandleFunc("POST /api/log/transaction", s.handleLogTransaction)
	mux.HandleFunc("POST /api/telegram/probe", s.handleTelegramProbe)
	mux.HandleFunc("GET /api/query", s.handleQuery)
	mux.HandleFunc("GET /api/query/summary", s.handleSummary)
	mux.HandleFunc("GET /api/query/tags", s.handleTags)
	mux.HandleFunc("POST /api/admin/tags/rename", s.handleRenameTags)
	mux.HandleFunc("PATCH /api/admin/records/{id}", s.handlePatchRecord)
	// 404/405 收成 {error} JSON（ServeMux 默认是 text/plain）
	return withCORS(s.withAuth(withJSONErrorPages(mux)))
}

// bufferResponse 暂存下游写入，便于将 404/405 改写成 JSON。
type bufferResponse struct {
	header http.Header
	code   int
	body   bytes.Buffer
}

func (b *bufferResponse) Header() http.Header {
	if b.header == nil {
		b.header = make(http.Header)
	}
	return b.header
}

func (b *bufferResponse) Write(p []byte) (int, error) {
	if b.code == 0 {
		b.code = http.StatusOK
	}
	return b.body.Write(p)
}

func (b *bufferResponse) WriteHeader(statusCode int) {
	b.code = statusCode
}

func withJSONErrorPages(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := &bufferResponse{}
		next.ServeHTTP(buf, r)
		code := buf.code
		if code == 0 {
			code = http.StatusOK
		}
		if code == http.StatusNotFound {
			writeError(w, http.StatusNotFound, "Not found")
			return
		}
		if code == http.StatusMethodNotAllowed {
			if allow := buf.Header().Get("Allow"); allow != "" {
				w.Header().Set("Allow", allow)
			}
			writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
		for k, vs := range buf.Header() {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(code)
		_, _ = w.Write(buf.body.Bytes())
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		isAdmin := r.URL.Path == "/api/admin" || strings.HasPrefix(r.URL.Path, "/api/admin/")
		ok := false
		if isAdmin {
			ok = s.Tokens.VerifyAdminAccess(r)
		} else {
			ok = s.Tokens.VerifyAPIAccess(r)
		}
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": auth.UnauthorizedMessage})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeInternalError(w http.ResponseWriter, _ error) {
	// 与 Next 对齐：500 恒为固定英文；细节只由调用方 log，禁止 EXPOSE_ERRORS 回传客户端
	writeError(w, 500, "Internal server error")
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readBody(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	// 多读 1 字节以区分「恰好上限」与「超限」；禁止静默截断后当残缺 JSON。
	raw, err := io.ReadAll(io.LimitReader(r.Body, int64(MaxBodyBytes)+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > MaxBodyBytes {
		return nil, ErrBodyTooLarge
	}
	return raw, nil
}

// readBodyOrError 读 body；失败时已写 JSON error，调用方应直接 return。
func readBodyOrError(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	raw, err := readBody(r)
	if err != nil {
		if errors.Is(err, ErrBodyTooLarge) {
			writeError(w, 413, BodyTooLargeMessage)
			return nil, false
		}
		writeError(w, 400, "Invalid JSON body")
		return nil, false
	}
	return raw, true
}

func (s *Server) handleLogNumber(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	rec, status, err := logapi.CreateNumber(r.Context(), s.Pool, raw)
	if err != nil {
		if status >= 500 {
			log.Printf("Error creating number record: %v", err)
			writeInternalError(w, err)
			return
		}
		writeError(w, status, err.Error())
		return
	}
	// INSERT 成功后异步 best-effort 通知，不阻塞写响应（HTTP 客户端仍有 15s 超时）
	go s.telegram().NotifyRecordInserted(rec)
	writeJSON(w, status, map[string]any{"success": true, "record": rec})
}

func (s *Server) handleLogText(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	rec, status, err := logapi.CreateText(r.Context(), s.Pool, raw)
	if err != nil {
		if status >= 500 {
			log.Printf("Error creating text record: %v", err)
			writeInternalError(w, err)
			return
		}
		writeError(w, status, err.Error())
		return
	}
	go s.telegram().NotifyRecordInserted(rec)
	writeJSON(w, status, map[string]any{"success": true, "record": rec})
}

func (s *Server) handleLogTransaction(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	inserted, recs, status, err := logapi.CreateTransactionBatch(r.Context(), s.Pool, raw)
	if err != nil {
		if status >= 500 {
			log.Printf("Error creating transaction records: %v", err)
			writeInternalError(w, err)
			return
		}
		writeError(w, status, err.Error())
		return
	}
	go s.telegram().NotifyTransactionBatchInserted(recs)
	writeJSON(w, status, map[string]any{"success": true, "inserted": inserted})
}

func (s *Server) handleTelegramProbe(w http.ResponseWriter, r *http.Request) {
	cfg := telegram.LoadConfig(s.telegram().Getenv)
	if !cfg.Configured() {
		writeError(w, 400, telegram.ConfigError(cfg))
		return
	}

	text := "DigitalTwin2026 probe"
	raw, err := readBody(r)
	if errors.Is(err, ErrBodyTooLarge) {
		writeError(w, 413, BodyTooLargeMessage)
		return
	}
	if err == nil && len(raw) > 0 {
		var body struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &body) == nil {
			if t := strings.TrimSpace(body.Text); t != "" {
				text = t
			}
		}
	}

	if err := s.telegram().SendMessage(text); err != nil {
		writeError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

func (s *Server) telegram() *telegram.Sender {
	if s.Telegram != nil {
		return s.Telegram
	}
	return telegram.Default
}

func (s *Server) handleQuery(w http.ResponseWriter, r *http.Request) {
	parsed, err := query.ParseRecordQueryParams(r.URL.Query())
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	result, err := query.FetchFilteredRecords(r.Context(), s.Pool, parsed)
	if err != nil {
		log.Printf("Error querying records: %v", err)
		writeInternalError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{
		"success":  true,
		"count":    result.Total,
		"page":     result.Page,
		"pageSize": result.PageSize,
		"records":  result.Records,
	})
}

func (s *Server) handleSummary(w http.ResponseWriter, r *http.Request) {
	tz := r.URL.Query().Get("tz")
	result, err := query.FetchSummary(r.Context(), s.Pool, tz, s.Now())
	if err != nil {
		if errors.Is(err, query.ErrInvalidTZ) {
			writeError(w, 400, err.Error())
			return
		}
		log.Printf("Error querying summary: %v", err)
		writeInternalError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{
		"success": true,
		"total":   result.Total,
		"today":   result.Today,
		"tz":      result.TZ,
	})
}

func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	counts, err := query.FetchTagCounts(r.Context(), s.Pool)
	if err != nil {
		log.Printf("Error aggregating tags: %v", err)
		writeInternalError(w, err)
		return
	}
	if counts == nil {
		counts = map[string]int{}
	}
	writeJSON(w, 200, map[string]any{"success": true, "tags": counts})
}

func (s *Server) handleRenameTags(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	// any 字段：与 Next 对齐，非 string from/to 走 validateRename，而非 Invalid JSON body
	var body struct {
		From any `json:"from"`
		To   any `json:"to"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		writeError(w, 400, "Invalid JSON body")
		return
	}
	from := ""
	if s, ok := body.From.(string); ok {
		from = strings.TrimSpace(s)
	}
	to := ""
	if s, ok := body.To.(string); ok {
		to = strings.TrimSpace(s)
	}
	if vr := tags.ValidateRename(from, to); !vr.Valid {
		writeError(w, 400, vr.Error)
		return
	}

	updated, err := tags.RenameAcrossRecords(r.Context(), s.Pool, from, to)
	if err != nil {
		log.Printf("Error renaming tags: %v", err)
		writeInternalError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "updated": updated})
}

func (s *Server) handlePatchRecord(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, 400, "Missing record id")
		return
	}
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	parsed, err := draft.ParseRecordDraftJSON(raw)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	rec, status, err := record.Update(r.Context(), s.Pool, id, parsed)
	if err != nil {
		if status >= 500 {
			log.Printf("Error patching record: %v", err)
			writeInternalError(w, err)
			return
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, status, map[string]any{"success": true, "record": rec})
}
