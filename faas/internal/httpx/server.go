package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/auth"
	"github.com/mdk/digitaltwin2026/faas/internal/dbprobe"
	"github.com/mdk/digitaltwin2026/faas/internal/exportapi"
	"github.com/mdk/digitaltwin2026/faas/internal/importapi"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/logapi"
	"github.com/mdk/digitaltwin2026/faas/internal/notify"
	"github.com/mdk/digitaltwin2026/faas/internal/qqbot"
	"github.com/mdk/digitaltwin2026/faas/internal/query"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
	"github.com/mdk/digitaltwin2026/faas/internal/timeutil"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
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
	Qqbot    *qqbot.Sender
	Notify   *notify.Notifier
	// TransitionTodo 可选；nil → logapi.TransitionTodo（单测注入成功/域错误结果，无需真实数据库）。
	TransitionTodo func(ctx context.Context, pool *pgxpool.Pool, raw []byte) (logapi.TransitionResult, int, error)
	// NotifyUser 可选；非 nil 时同步调用（单测 spy）；nil → go notify().NotifyUser（生产路径）。
	NotifyUser func(text string)
	// FetchExportRecords 可选；nil → exportapi.FetchExportRecords（单测注入空页，无需真实数据库）。
	FetchExportRecords func(ctx context.Context, pool *pgxpool.Pool, p *exportapi.ParsedExport) ([]record.Record, int, error)
}

func NewServer(pool *pgxpool.Pool, tokens auth.Tokens) *Server {
	return &Server{
		Pool:     pool,
		Tokens:   tokens,
		Now:      time.Now,
		Telegram: telegram.Default,
		Qqbot:    qqbot.Default,
		Notify:   notify.Default,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/log/numbers", s.handleLogNumbers)
	mux.HandleFunc("POST /api/log/body/weight", s.handleLogBodyWeight)
	mux.HandleFunc("POST /api/log/todo", s.handleLogTodo)
	mux.HandleFunc("POST /api/log/todo/transition", s.handleLogTodoTransition)
	mux.HandleFunc("POST /api/log/text", s.handleLogText)
	mux.HandleFunc("POST /api/log/review", s.handleLogReview)
	mux.HandleFunc("POST /api/log/transactions", s.handleLogTransactions)
	mux.HandleFunc("POST /api/telegram/probe", s.handleTelegramProbe)
	mux.HandleFunc("POST /api/qqbot/probe", s.handleQqbotProbe)
	mux.HandleFunc("POST /api/db/probe", s.handleDbProbe)
	mux.HandleFunc("GET /api/query", s.handleQuery)
	mux.HandleFunc("GET /api/time", s.handleTime)
	mux.HandleFunc("GET /api/query/tags", s.handleTags)
	mux.HandleFunc("GET /api/query/transactions/summary", s.handleTransactionsSummary)
	mux.HandleFunc("GET /api/admin/records/stats", s.handleSummary)
	mux.HandleFunc("POST /api/admin/tags/rename", s.handleRenameTags)
	mux.HandleFunc("POST /api/admin/import/records", s.handleImportRecords)
	mux.HandleFunc("GET /api/export/records", s.handleExportRecords)
	// 404/405 → {error} JSON。Next 仍用框架默认（见 api-layering §1.1）；业务 4xx 两端已对齐。
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
		// 仅改写框架 404（无路由，通常 text/plain）；业务 404（application/json，如 to-do not found）原样透传。
		if code == http.StatusNotFound {
			ct := buf.Header().Get("Content-Type")
			if !strings.Contains(ct, "application/json") {
				writeError(w, http.StatusNotFound, "Not found")
				return
			}
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

// withCORS：国内 Accelerate 跨域预检。OPTIONS → 204 且不鉴权。
// Next 同源无此中间件（见 api-layering §1.1）；勿要求两端 OPTIONS 行为字节级一致。
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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
			writeJSON(w, http.StatusUnauthorized, ErrorResponse{Error: auth.UnauthorizedMessage})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false) // 与 Next JSON.stringify 对齐，不把 <> & 编成 \u003c 等
	_ = enc.Encode(body)
}

func writeInternalError(w http.ResponseWriter, _ error) {
	// 与 Next 对齐：500 恒为固定英文；细节只由调用方 log，禁止 EXPOSE_ERRORS 回传客户端
	writeError(w, http.StatusInternalServerError, "Internal server error")
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, ErrorResponse{Error: msg})
}

// writeLogOrError 契约错误（<500）直接 writeError；内部错误（>=500）记日志 + writeInternalError。
// 日志前缀 logMsg 为英文（AGENTS.md），逐字保持现状（如 "Error creating number records"）。
func writeLogOrError(w http.ResponseWriter, status int, err error, logMsg string) {
	if status >= http.StatusInternalServerError {
		log.Printf("%s: %v", logMsg, err)
		writeInternalError(w, err)
		return
	}
	writeError(w, status, err.Error())
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
			writeError(w, http.StatusRequestEntityTooLarge, BodyTooLargeMessage)
			return nil, false
		}
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return nil, false
	}
	return raw, true
}

func (s *Server) handleLogNumbers(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	inserted, recs, status, err := logapi.CreateNumberBatch(r.Context(), s.Pool, raw)
	if err != nil {
		writeLogOrError(w, status, err, "Error creating number records")
		return
	}
	// INSERT 成功后异步 best-effort notify（整批一条摘要），不阻塞写响应。
	// 刻意允许的双端差异（docs/20260801-api-layering.md §1.1 / §7）：
	// Go 用 go 协程；Next 用 after()。语义同为成功后不阻塞的扇出。
	go s.notify().NotifyNumberBatchInserted(recs)
	writeJSON(w, status, NumberBatchSuccess{Success: true, Inserted: inserted, Atomic: true})
}

func (s *Server) handleLogBodyWeight(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	rec, status, err := logapi.CreateBodyWeight(r.Context(), s.Pool, raw)
	if err != nil {
		writeLogOrError(w, status, err, "Error creating body weight record")
		return
	}
	go s.notify().NotifyRecordInserted(rec)
	writeJSON(w, status, RecordSuccess{Success: true, Record: rec})
}

func (s *Server) handleLogTodo(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	rec, status, err := logapi.CreateTodo(r.Context(), s.Pool, raw)
	if err != nil {
		writeLogOrError(w, status, err, "Error creating to-do record")
		return
	}
	go s.notify().NotifyRecordInserted(rec)
	writeJSON(w, status, TodoRecordSuccess{Success: true, Record: tododraft.ToTodoRecordJSON(rec)})
}

func (s *Server) handleLogTodoTransition(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	var (
		result logapi.TransitionResult
		status int
		err    error
	)
	if s.TransitionTodo != nil {
		result, status, err = s.TransitionTodo(r.Context(), s.Pool, raw)
	} else {
		result, status, err = logapi.TransitionTodo(r.Context(), s.Pool, raw)
	}
	if err != nil {
		writeLogOrError(w, status, err, "Error transitioning to-do")
		return
	}
	// D6：恰好一次 notify，正文 = objective_context 句 + ": " + 原文
	if s.NotifyUser != nil {
		s.NotifyUser(result.TodoAuditNotifyText)
	} else {
		go s.notify().NotifyUser(result.TodoAuditNotifyText)
	}
	writeJSON(w, status, TransitionSuccess{
		Success: true,
		ID:      result.ID,
		Transition: TransitionInfo{
			From: result.From,
			To:   result.To,
		},
	})
}

func (s *Server) handleLogReview(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	rec, status, err := logapi.CreateReview(r.Context(), s.Pool, raw)
	if err != nil {
		writeLogOrError(w, status, err, "Error creating review record")
		return
	}
	go s.notify().NotifyRecordInserted(rec)
	writeJSON(w, status, RecordSuccess{Success: true, Record: rec})
}

func (s *Server) handleLogText(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	rec, status, err := logapi.CreateText(r.Context(), s.Pool, raw)
	if err != nil {
		writeLogOrError(w, status, err, "Error creating text record")
		return
	}
	go s.notify().NotifyRecordInserted(rec)
	writeJSON(w, status, RecordSuccess{Success: true, Record: rec})
}

func (s *Server) handleLogTransactions(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	inserted, batchType, sum, recs, status, err := logapi.CreateTransactionBatch(r.Context(), s.Pool, raw)
	if err != nil {
		writeLogOrError(w, status, err, "Error creating transaction records")
		return
	}
	go s.notify().NotifyTransactionBatchInserted(recs)
	writeJSON(w, status, TransactionBatchSuccess{
		Success:  true,
		Inserted: inserted,
		Type:     batchType,
		Sum:      sum,
		Atomic:   true,
	})
}

func (s *Server) handleTelegramProbe(w http.ResponseWriter, r *http.Request) {
	cfg := telegram.LoadConfig(s.telegram().Getenv)
	if !cfg.Configured() {
		writeError(w, http.StatusBadRequest, telegram.ConfigError(cfg))
		return
	}

	text := "DigitalTwin2026 probe"
	raw, err := readBody(r)
	if errors.Is(err, ErrBodyTooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, BodyTooLargeMessage)
		return
	}
	if err == nil && len(raw) > 0 {
		if err := jsonutil.RejectUnknownObjectKeys(raw, []string{"text"}); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
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
	writeJSON(w, http.StatusOK, SuccessOnly{Success: true})
}

func (s *Server) handleQqbotProbe(w http.ResponseWriter, r *http.Request) {
	cfg := qqbot.LoadConfig(s.qqbot().Getenv)
	if !cfg.Configured() {
		writeError(w, http.StatusBadRequest, qqbot.ConfigError(cfg))
		return
	}

	text := "DigitalTwin2026 probe"
	raw, err := readBody(r)
	if errors.Is(err, ErrBodyTooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, BodyTooLargeMessage)
		return
	}
	if err == nil && len(raw) > 0 {
		if err := jsonutil.RejectUnknownObjectKeys(raw, []string{"text"}); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		var body struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &body) == nil {
			if t := strings.TrimSpace(body.Text); t != "" {
				text = t
			}
		}
	}

	if err := s.qqbot().SendMessage(text); err != nil {
		writeError(w, 502, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, SuccessOnly{Success: true})
}

func (s *Server) handleDbProbe(w http.ResponseWriter, r *http.Request) {
	result, status, errMsg := dbprobe.Probe(r.Context(), nil)
	if status != 200 {
		writeError(w, status, errMsg)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) telegram() *telegram.Sender {
	if s.Telegram != nil {
		return s.Telegram
	}
	return telegram.Default
}

func (s *Server) qqbot() *qqbot.Sender {
	if s.Qqbot != nil {
		return s.Qqbot
	}
	return qqbot.Default
}

func (s *Server) notify() *notify.Notifier {
	if s.Notify != nil {
		return s.Notify
	}
	return &notify.Notifier{
		Telegram: s.telegram(),
		Qqbot:    s.qqbot(),
	}
}

func (s *Server) handleQuery(w http.ResponseWriter, r *http.Request) {
	parsed, err := query.ParseRecordQueryParams(r.URL.Query())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := query.FetchFilteredRecords(r.Context(), s.Pool, parsed)
	if err != nil {
		log.Printf("Error querying records: %v", err)
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, QuerySuccess{
		Success:   true,
		Count:     result.Total,
		Page:      result.Page,
		PageSize:  result.PageSize,
		SortBy:    parsed.SortBy,
		SortOrder: parsed.SortOrder,
		Records:   query.RecordsForResponse(result.Records),
		Hint:      parsed.Hint,
	})
}

func (s *Server) handleSummary(w http.ResponseWriter, r *http.Request) {
	tz := r.URL.Query().Get("tz")
	result, err := query.FetchSummary(r.Context(), s.Pool, tz, s.Now())
	if err != nil {
		if errors.Is(err, query.ErrInvalidTZ) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		log.Printf("Error querying summary: %v", err)
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, SummarySuccess{
		Success: true,
		Total:   result.Total,
		Today:   result.Today,
		TZ:      result.TZ,
	})
}

func (s *Server) handleTime(w http.ResponseWriter, r *http.Request) {
	tz := r.URL.Query().Get("tz")
	// 与 Next /api/time 一致：?tz= 空串显式传入 → 400；缺省 → UTC
	if tz == "" && r.URL.Query().Has("tz") {
		writeError(w, http.StatusBadRequest, query.ErrInvalidTZ.Error())
		return
	}
	if tz == "" {
		tz = "UTC"
	}
	now, err := timeutil.FormatNowInZone(s.Now(), tz)
	if err != nil {
		writeError(w, http.StatusBadRequest, query.ErrInvalidTZ.Error())
		return
	}
	writeJSON(w, http.StatusOK, TimeSuccess{Success: true, Now: now, TZ: tz})
}

func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	prefix := r.URL.Query().Get("prefix")
	counts, err := query.FetchTagCounts(r.Context(), s.Pool, prefix)
	if err != nil {
		log.Printf("Error aggregating tags: %v", err)
		writeInternalError(w, err)
		return
	}
	if counts == nil {
		counts = []tags.TagCount{}
	}
	writeJSON(w, http.StatusOK, TagsSuccess{Success: true, Tags: counts})
}

func (s *Server) handleTransactionsSummary(w http.ResponseWriter, r *http.Request) {
	parsed, err := query.ParseTransactionsSummaryParams(r.URL.Query())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := query.FetchTransactionsSummary(
		r.Context(), s.Pool, parsed.From, parsed.To, parsed.FromRaw, parsed.ToRaw,
	)
	if err != nil {
		log.Printf("Error querying transaction summary: %v", err)
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleRenameTags(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	if err := jsonutil.RejectUnknownObjectKeys(raw, []string{"from", "to"}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// any 字段：与 Next 对齐，非 string from/to 走 validateRename，而非 Invalid JSON body
	var body struct {
		From any `json:"from"`
		To   any `json:"to"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
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
		writeError(w, http.StatusBadRequest, vr.Error)
		return
	}

	updated, err := tags.RenameAcrossRecords(r.Context(), s.Pool, from, to)
	if err != nil {
		log.Printf("Error renaming tags: %v", err)
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, RenameTagsSuccess{Success: true, Updated: updated})
}

func (s *Server) handleExportRecords(w http.ResponseWriter, r *http.Request) {
	parsed, err := exportapi.ParseExportRecordsParams(r.URL.Query())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var recs []record.Record
	var status int
	if s.FetchExportRecords != nil {
		recs, status, err = s.FetchExportRecords(r.Context(), s.Pool, parsed)
	} else {
		recs, status, err = exportapi.FetchExportRecords(r.Context(), s.Pool, parsed)
	}
	if err != nil {
		writeLogOrError(w, status, err, "Error exporting records")
		return
	}
	body, err := exportapi.BuildExportNdjson(recs)
	if err != nil {
		log.Printf("Error serializing export NDJSON: %v", err)
		writeInternalError(w, err)
		return
	}
	now := s.Now()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", exportapi.ExportContentDisposition(parsed.From, parsed.Limit, now))
	w.WriteHeader(200)
	// §4.5：响应体写出成功后再 Notify；Write 失败不视为成功备份。
	if _, err := w.Write([]byte(body)); err != nil {
		log.Printf("Error writing export body: %v", err)
		return
	}
	msg := exportapi.FormatExportNotifyMessage(len(recs), parsed.From, parsed.Limit)
	if s.NotifyUser != nil {
		s.NotifyUser(msg)
	} else {
		go s.notify().NotifyUser(msg)
	}
}

// handleImportRecords：勿走 readBody（MaxBodyBytes）；MultipartReader 取 file part（≤4MiB）。
func (s *Server) handleImportRecords(w http.ResponseWriter, r *http.Request) {
	ct := r.Header.Get("Content-Type")
	mediatype, params, err := mime.ParseMediaType(ct)
	if err != nil || !strings.EqualFold(mediatype, "multipart/form-data") {
		writeError(w, http.StatusBadRequest, importapi.ErrMultipartContentType.Error())
		return
	}
	boundary := params["boundary"]
	if boundary == "" {
		writeError(w, http.StatusBadRequest, importapi.ErrMultipartContentType.Error())
		return
	}

	mr := multipart.NewReader(r.Body, boundary)
	var (
		fileRaw   []byte
		filename  string
		partCT    string
		fileCount int
	)
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, importapi.ErrMultipartContentType.Error())
			return
		}
		if part.FormName() != "file" {
			// 非 file part 丢弃也加上限，避免恶意大字段占满内存。
			n, copyErr := io.Copy(io.Discard, io.LimitReader(part, int64(importapi.MaxImportFileBytes)+1))
			_ = part.Close()
			if copyErr != nil {
				writeError(w, http.StatusBadRequest, importapi.ErrMultipartContentType.Error())
				return
			}
			if n > int64(importapi.MaxImportFileBytes) {
				writeError(w, http.StatusBadRequest, importapi.ErrMultipartPartTooLarge.Error())
				return
			}
			continue
		}
		fileCount++
		if fileCount > 1 {
			_ = part.Close()
			writeError(w, http.StatusBadRequest, importapi.ErrMultipartMultipleFile.Error())
			return
		}
		filename = filepath.Base(part.FileName())
		partCT = part.Header.Get("Content-Type")
		// +1 字节以区分恰好上限与超限
		fileRaw, err = io.ReadAll(io.LimitReader(part, int64(importapi.MaxImportFileBytes)+1))
		_ = part.Close()
		if err != nil {
			writeError(w, http.StatusBadRequest, importapi.ErrMultipartContentType.Error())
			return
		}
	}
	if fileCount == 0 {
		writeError(w, http.StatusBadRequest, importapi.ErrMultipartRequired.Error())
		return
	}
	if !importapi.IsAcceptedImportFilePart(partCT, filename) {
		writeError(w, http.StatusBadRequest, importapi.ErrUnsupportedFileContentType.Error())
		return
	}
	if len(fileRaw) > importapi.MaxImportFileBytes {
		writeError(w, http.StatusBadRequest, importapi.ImportLimitsError.Error())
		return
	}

	counts, err := importapi.ImportRecordsJSONL(r.Context(), s.Pool, strings.NewReader(string(fileRaw)))
	if err != nil {
		if st := importapi.StatusOf(err); st > 0 && st < 500 {
			writeError(w, st, err.Error())
			return
		}
		log.Printf("Error importing records: %v", err)
		writeInternalError(w, err)
		return
	}

	// commit 已成功：先写出 200 JSON，Encode 成功后再 Notify（与导出 §4.5 对齐）。
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(ImportRecordsSuccess{
		Success:  true,
		Inserted: counts.Inserted,
		Updated:  counts.Updated,
		Total:    counts.Total,
		Atomic:   true,
	}); err != nil {
		log.Printf("Error writing import success body: %v", err)
		return
	}
	msg := importapi.FormatImportNotifyMessage(counts)
	if s.NotifyUser != nil {
		s.NotifyUser(msg)
	} else {
		go s.notify().NotifyUser(msg)
	}
}
