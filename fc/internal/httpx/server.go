package httpx

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/fc/internal/auth"
	"github.com/mdk/digitaltwin2026/fc/internal/draft"
	"github.com/mdk/digitaltwin2026/fc/internal/logapi"
	"github.com/mdk/digitaltwin2026/fc/internal/query"
	"github.com/mdk/digitaltwin2026/fc/internal/record"
	"github.com/mdk/digitaltwin2026/fc/internal/tags"
	"github.com/mdk/digitaltwin2026/fc/internal/telegram"
)

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
	return withCORS(s.withAuth(mux))
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
		isAdmin := strings.HasPrefix(r.URL.Path, "/api/admin/")
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

func writeInternalError(w http.ResponseWriter, err error) {
	msg := "Internal server error"
	if os.Getenv("EXPOSE_ERRORS") == "1" && err != nil {
		msg = err.Error()
	}
	writeError(w, 500, msg)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readBody(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(io.LimitReader(r.Body, 1<<20))
}

func (s *Server) handleLogNumber(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		writeError(w, 400, "Invalid JSON body")
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
	// 仅 INSERT 成功后 best-effort 通知
	s.telegram().NotifyRecordInserted(rec)
	writeJSON(w, status, map[string]any{"success": true, "record": rec})
}

func (s *Server) handleLogText(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		writeError(w, 400, "Invalid JSON body")
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
	s.telegram().NotifyRecordInserted(rec)
	writeJSON(w, status, map[string]any{"success": true, "record": rec})
}

func (s *Server) handleLogTransaction(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		writeError(w, 400, "Invalid JSON body")
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
	s.telegram().NotifyTransactionBatchInserted(recs)
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
		if strings.Contains(err.Error(), "tz") {
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
	raw, err := readBody(r)
	if err != nil {
		writeError(w, 400, "Invalid JSON body")
		return
	}
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		writeError(w, 400, "Invalid JSON body")
		return
	}
	from := strings.TrimSpace(body.From)
	to := strings.TrimSpace(body.To)
	if from == "" || to == "" {
		writeError(w, 400, "Missing required fields: from, to")
		return
	}
	if !tags.IsValidTag(from) || !tags.IsValidTag(to) {
		writeError(w, 400, "from and to must be valid tag names")
		return
	}
	if tags.IsReservedTag(from) || tags.IsReservedTag(to) {
		bad := from
		if tags.IsReservedTag(to) && !tags.IsReservedTag(from) {
			bad = to
		}
		writeError(w, 400, tags.ReservedTagError(bad))
		return
	}
	if from == to {
		writeError(w, 400, "from and to must be different")
		return
	}

	updated, err := renameTags(r.Context(), s.Pool, from, to)
	if err != nil {
		log.Printf("Error renaming tags: %v", err)
		writeInternalError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "updated": updated})
}

func renameTags(ctx context.Context, pool *pgxpool.Pool, from, to string) (int, error) {
	rows, err := pool.Query(ctx, `SELECT id, tags FROM records`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type row struct {
		id   string
		tags string
	}
	var list []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.tags); err != nil {
			return 0, err
		}
		list = append(list, r)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	updated := 0
	for _, r := range list {
		next, ok, err := tags.RenameTagInTagsJSON(r.tags, from, to)
		if err != nil {
			return 0, err
		}
		if !ok {
			continue
		}
		if _, err := pool.Exec(ctx, `UPDATE records SET tags = $1 WHERE id = $2`, next, r.id); err != nil {
			return 0, err
		}
		updated++
	}
	return updated, nil
}

func (s *Server) handlePatchRecord(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, 400, "Missing record id")
		return
	}
	raw, err := readBody(r)
	if err != nil {
		writeError(w, 400, "Invalid JSON body")
		return
	}
	parsed, err := draft.ParseRecordDraftJSON(raw)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	tagsJSON, err := record.TagsJSON(parsed.Tags)
	if err != nil {
		writeError(w, 500, "Internal server error")
		return
	}

	var (
		outID, outTags, outObj   string
		outHappened              time.Time
		outNum, outText, outSubj *string
	)
	err = s.Pool.QueryRow(r.Context(), `
UPDATE records SET
  happened_at = $1,
  value_number = $2,
  value_text = $3,
  tags = $4,
  objective_context = $5,
  subjective_interpretation = $6
WHERE id = $7
RETURNING id, happened_at, value_number, value_text, tags, objective_context, subjective_interpretation
`, parsed.HappenedAt, parsed.ValueNumber, parsed.ValueText, tagsJSON, parsed.ObjectiveContext, parsed.SubjectiveInterpretation, id).Scan(
		&outID, &outHappened, &outNum, &outText, &outTags, &outObj, &outSubj,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeError(w, 404, "Record not found")
			return
		}
		log.Printf("Error patching record: %v", err)
		writeInternalError(w, err)
		return
	}
	rec := record.FromDB(outID, outHappened, outNum, outText, outTags, outObj, outSubj)
	writeJSON(w, 200, map[string]any{"success": true, "record": rec})
}
