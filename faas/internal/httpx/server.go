package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/auth"
	"github.com/mdk/digitaltwin2026/faas/internal/bodyweightdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/dbprobe"
	"github.com/mdk/digitaltwin2026/faas/internal/exportapi"
	"github.com/mdk/digitaltwin2026/faas/internal/importapi"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/logapi"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/numberdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/qqbot"
	"github.com/mdk/digitaltwin2026/faas/internal/query"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/reviewdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
	"github.com/mdk/digitaltwin2026/faas/internal/timeutil"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
	"github.com/mdk/digitaltwin2026/faas/internal/transactiondraft"
)

// MaxBodyBytes 与 Next MAX_HTTP_BODY_BYTES（256 KiB）对齐。
const MaxBodyBytes = 256 * 1024

// ErrBodyTooLarge / BodyTooLargeMessage 与 Next REQUEST_BODY_TOO_LARGE 同文案。
var ErrBodyTooLarge = errors.New("request body too large")

const BodyTooLargeMessage = "request body too large"

// 各业务接口（消费方定义，业务包实现——§10b 步骤 4：构造必填、无 nil 约定）。
type LogService interface {
	CreateText(ctx context.Context, body logapi.TextBody) (record.Record, *myerr.MyError)
	CreateTodo(ctx context.Context, parsed tododraft.NormalizedTodo) (record.Record, *myerr.MyError)
	CreateBodyWeight(ctx context.Context, parsed bodyweightdraft.NormalizedBodyWeight) (record.Record, *myerr.MyError)
	CreateReview(ctx context.Context, parsed reviewdraft.NormalizedReview) (record.Record, *myerr.MyError)
	CreateNumberBatch(ctx context.Context, batch numberdraft.NormalizedNumberBatch) (int, []record.Record, *myerr.MyError)
	CreateTransactionBatch(ctx context.Context, batch transactiondraft.NormalizedTransactionBatch) (int, string, string, []record.Record, *myerr.MyError)
	TransitionTodo(ctx context.Context, parsed tododraft.NormalizedTodoTransition) (logapi.TransitionResult, *myerr.MyError)
}

type ImportService interface {
	ImportRecordsJSONL(ctx context.Context, r io.Reader) (record.ImportCounts, *myerr.MyError)
}

type ExportService interface {
	FetchExportRecords(ctx context.Context, p *exportapi.ParsedExport) ([]record.Record, *myerr.MyError)
}

type QueryService interface {
	FetchFilteredRecords(ctx context.Context, p *query.ParsedQuery) (*query.FetchResult, *myerr.MyError)
	FetchSummary(ctx context.Context, tz string, now time.Time) (*query.SummaryResult, *myerr.MyError)
	FetchTagCounts(ctx context.Context, prefix string) ([]tags.TagCount, *myerr.MyError)
	FetchTransactionsSummary(ctx context.Context, from, to time.Time, fromRaw, toRaw string) (*query.TransactionsSummaryResult, *myerr.MyError)
}

type TagsService interface {
	RenameAcrossRecords(ctx context.Context, from, to string) (int, *myerr.MyError)
}

// Notifier 通知边界（handler 行为；notify.Notifier 实现）。
type Notifier interface {
	NotifyUser(text string)
	NotifyRecordInserted(rec record.Record)
	NotifyNumberBatchInserted(recs []record.Record)
	NotifyTransactionBatchInserted(rows []record.Record)
}

// Server 装配：构造必填接口注入（无 nil 回落；测试注入 fake struct）。
type Server struct {
	Pool      *pgxpool.Pool // dbprobe 专用（基础设施健康检查，不进 Service）
	Tokens    auth.Tokens
	Now       func() time.Time
	LogSvc    LogService
	ImportSvc ImportService
	ExportSvc ExportService
	QuerySvc  QueryService
	TagsSvc   TagsService
	Notifier  Notifier
	Telegram  *telegram.Sender
	Qqbot     *qqbot.Sender
}

// NewServer 构造（业务 Service 由调用方构造传入；pool 供 dbprobe）。
func NewServer(pool *pgxpool.Pool, tokens auth.Tokens, logSvc LogService, importSvc ImportService, exportSvc ExportService, querySvc QueryService, tagsSvc TagsService, notifier Notifier) *Server {
	return &Server{
		Pool:      pool,
		Tokens:    tokens,
		Now:       time.Now,
		LogSvc:    logSvc,
		ImportSvc: importSvc,
		ExportSvc: exportSvc,
		QuerySvc:  querySvc,
		TagsSvc:   tagsSvc,
		Notifier:  notifier,
	}
}

func (s *Server) Handler() http.Handler {
	rt := &router{}
	rt.HandleFunc(http.MethodPost, "/api/log/numbers", s.handleLogNumbers)
	rt.HandleFunc(http.MethodPost, "/api/log/body/weight", s.handleLogBodyWeight)
	rt.HandleFunc(http.MethodPost, "/api/log/todo", s.handleLogTodo)
	rt.HandleFunc(http.MethodPost, "/api/log/todo/transition", s.handleLogTodoTransition)
	rt.HandleFunc(http.MethodPost, "/api/log/text", s.handleLogText)
	rt.HandleFunc(http.MethodPost, "/api/log/review", s.handleLogReview)
	rt.HandleFunc(http.MethodPost, "/api/log/transactions", s.handleLogTransactions)
	rt.HandleFunc(http.MethodPost, "/api/telegram/probe", s.handleTelegramProbe)
	rt.HandleFunc(http.MethodPost, "/api/qqbot/probe", s.handleQqbotProbe)
	rt.HandleFunc(http.MethodPost, "/api/db/probe", s.handleDbProbe)
	rt.HandleFunc(http.MethodGet, "/api/query", s.handleQuery)
	rt.HandleFunc(http.MethodGet, "/api/time", s.handleTime)
	rt.HandleFunc(http.MethodGet, "/api/query/tags", s.handleTags)
	rt.HandleFunc(http.MethodGet, "/api/query/transactions/summary", s.handleTransactionsSummary)
	rt.HandleFunc(http.MethodGet, "/api/admin/records/stats", s.handleSummary)
	rt.HandleFunc(http.MethodPost, "/api/admin/tags/rename", s.handleRenameTags)
	rt.HandleFunc(http.MethodPost, "/api/admin/import/records", s.handleImportRecords)
	rt.HandleFunc(http.MethodGet, "/api/export/records", s.handleExportRecords)
	// 404/405 由自写路由直接输出 problem+json（router.go，消除 ServeMux 改写的双缓冲）。
	// Next 仍用框架默认（见 api-layering §1.1）；业务 4xx 两端已对齐。
	return withCORS(s.withAuth(rt))
}

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
			writeError(w, http.StatusUnauthorized, auth.UnauthorizedMessage)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// writeEncoded 写 JSON 响应（Content-Type 由调用方指定）；不转义 HTML，与 Next JSON.stringify 对齐。
// 仅被 writeJSON / writeError 使用（内部 helper，不导出）。
func writeEncoded(w http.ResponseWriter, status int, contentType string, body any) {
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false) // 与 Next JSON.stringify 对齐，不把 <> & 编成 \u003c 等
	_ = enc.Encode(body)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	writeEncoded(w, status, "application/json", body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	// RFC 9457 problem+json（docs/20260805-error-response-shape.md）：
	// 形状与 key 顺序双端逐字一致（success→title→status→detail），Content-Type 用 problem+json。
	writeEncoded(w, status, "application/problem+json", ErrorResponse{
		Success: false,
		Title:   statusTitle(status),
		Status:  status,
		Detail:  msg,
	})
}

// writeErr 统一错误出口（决策 D）：myerr 取 status（>=500 记 error，<500 记 info）；
// 非 myerr = 漏包装 → 500 兜底（describe 类型名+消息）。日志前缀 logMsg 为英文（AGENTS.md）。
// writeErr 业务错误统一出口（决策 D）：全层 *MyError（编译期保证，无裸 error 兜底路径——
// Node routeError 的 unknown 兜底是 JS 无编译期保证的框架差异）。
func writeErr(w http.ResponseWriter, me *myerr.MyError, logMsg string) {
	if me.Status >= http.StatusInternalServerError {
		slog.Error(logMsg, "err", me)
	} else {
		slog.Info(logMsg, "err", me)
	}
	writeError(w, me.Status, me.Message)
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
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return nil, false
	}
	return raw, true
}

func (s *Server) handleLogNumbers(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	batch, me := numberdraft.ParseNumberBatch(raw)
	if me != nil {
		writeErr(w, me, "Error creating number records")
		return
	}
	inserted, recs, me := s.LogSvc.CreateNumberBatch(r.Context(), batch)
	if me != nil {
		writeErr(w, me, "Error creating number records")
		return
	}
	// INSERT 成功后异步 best-effort notify（整批一条摘要），不阻塞写响应。
	// 刻意允许的双端差异（docs/20260801-api-layering.md §1.1 / §7）：
	// Go 用 go 协程；Next 用 after()。语义同为成功后不阻塞的扇出。
	go s.Notifier.NotifyNumberBatchInserted(recs)
	writeJSON(w, http.StatusCreated, NumberBatchSuccess{Success: true, Inserted: inserted, Atomic: true})
}

func (s *Server) handleLogBodyWeight(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	parsed, me := bodyweightdraft.ParseBodyWeight(raw)
	if me != nil {
		writeErr(w, me, "Error creating body weight record")
		return
	}
	rec, me := s.LogSvc.CreateBodyWeight(r.Context(), parsed)
	if me != nil {
		writeErr(w, me, "Error creating body weight record")
		return
	}
	go s.Notifier.NotifyRecordInserted(rec)
	writeJSON(w, http.StatusCreated, RecordSuccess{Success: true, Record: rec})
}

func (s *Server) handleLogTodo(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	parsed, me := tododraft.ParseTodo(raw)
	if me != nil {
		writeErr(w, me, "Error creating to-do record")
		return
	}
	rec, me := s.LogSvc.CreateTodo(r.Context(), parsed)
	if me != nil {
		writeErr(w, me, "Error creating to-do record")
		return
	}
	go s.Notifier.NotifyRecordInserted(rec)
	writeJSON(w, http.StatusCreated, TodoRecordSuccess{Success: true, Record: tododraft.ToTodoRecordJSON(rec)})
}

func (s *Server) handleLogTodoTransition(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	parsed, me := tododraft.ParseTodoTransition(raw)
	if me != nil {
		writeErr(w, me, "Error transitioning to-do")
		return
	}
	result, me2 := s.LogSvc.TransitionTodo(r.Context(), parsed)
	if me2 != nil {
		writeErr(w, me2, "Error transitioning to-do")
		return
	}
	// D6：恰好一次 notify，正文 = objective_context 句 + ": " + 原文
	go s.Notifier.NotifyUser(result.TodoAuditNotifyText)
	writeJSON(w, http.StatusOK, TransitionSuccess{
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
	parsed, me := reviewdraft.ParseReview(raw)
	if me != nil {
		writeErr(w, me, "Error creating review record")
		return
	}
	rec, me := s.LogSvc.CreateReview(r.Context(), parsed)
	if me != nil {
		writeErr(w, me, "Error creating review record")
		return
	}
	go s.Notifier.NotifyRecordInserted(rec)
	writeJSON(w, http.StatusCreated, RecordSuccess{Success: true, Record: rec})
}

func (s *Server) handleLogText(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	body, me := logapi.ParseTextBody(raw)
	if me != nil {
		writeErr(w, me, "Error creating text record")
		return
	}
	rec, me := s.LogSvc.CreateText(r.Context(), body)
	if me != nil {
		writeErr(w, me, "Error creating text record")
		return
	}
	go s.Notifier.NotifyRecordInserted(rec)
	writeJSON(w, http.StatusCreated, RecordSuccess{Success: true, Record: rec})
}

func (s *Server) handleLogTransactions(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	batch, me := transactiondraft.ParseTransactionBatch(raw)
	if me != nil {
		writeErr(w, me, "Error creating transaction records")
		return
	}
	inserted, batchType, sum, recs, me := s.LogSvc.CreateTransactionBatch(r.Context(), batch)
	if me != nil {
		writeErr(w, me, "Error creating transaction records")
		return
	}
	go s.Notifier.NotifyTransactionBatchInserted(recs)
	writeJSON(w, http.StatusCreated, TransactionBatchSuccess{
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
		if me := jsonutil.RejectUnknownObjectKeys(raw, []string{"text"}); me != nil {
			writeErr(w, me, "notify")
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

	if me := s.telegram().SendMessage(text); me != nil {
		writeError(w, 502, me.Message)
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
		if me := jsonutil.RejectUnknownObjectKeys(raw, []string{"text"}); me != nil {
			writeErr(w, me, "notify")
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

	if me := s.qqbot().SendMessage(text); me != nil {
		writeError(w, 502, me.Message)
		return
	}
	writeJSON(w, http.StatusOK, SuccessOnly{Success: true})
}

func (s *Server) handleDbProbe(w http.ResponseWriter, r *http.Request) {
	result, me := dbprobe.Probe(r.Context(), nil)
	if me != nil {
		writeErr(w, me, "db probe")
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

func (s *Server) handleQuery(w http.ResponseWriter, r *http.Request) {
	parsed, me := query.ParseRecordQueryParams(r.URL.Query())
	if me != nil {
		writeErr(w, me, "query records")
		return
	}
	result, me := s.QuerySvc.FetchFilteredRecords(r.Context(), parsed)
	if me != nil {
		writeErr(w, me, "query records")
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
	result, err := s.QuerySvc.FetchSummary(r.Context(), tz, s.Now())
	if err != nil {
		writeErr(w, err, "query summary")
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
	const invalidTZMsg = "query parameter tz must be a valid IANA time zone"
	// 与 Next /api/time 一致：?tz= 空串显式传入 → 400；缺省 → UTC
	if tz == "" && r.URL.Query().Has("tz") {
		writeError(w, http.StatusBadRequest, invalidTZMsg)
		return
	}
	if tz == "" {
		tz = "UTC"
	}
	now, err := timeutil.FormatNowInZone(s.Now(), tz)
	if err != nil {
		writeError(w, http.StatusBadRequest, invalidTZMsg)
		return
	}
	writeJSON(w, http.StatusOK, TimeSuccess{Success: true, Now: now, TZ: tz})
}

func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	prefix := r.URL.Query().Get("prefix")
	counts, err := s.QuerySvc.FetchTagCounts(r.Context(), prefix)
	if err != nil {
		writeErr(w, err, "aggregate tags")
		return
	}
	if counts == nil {
		counts = []tags.TagCount{}
	}
	writeJSON(w, http.StatusOK, TagsSuccess{Success: true, Tags: counts})
}

func (s *Server) handleTransactionsSummary(w http.ResponseWriter, r *http.Request) {
	parsed, me := query.ParseTransactionsSummaryParams(r.URL.Query())
	if me != nil {
		writeErr(w, me, "query transaction summary")
		return
	}
	result, err := s.QuerySvc.FetchTransactionsSummary(
		r.Context(), parsed.From, parsed.To, parsed.FromRaw, parsed.ToRaw,
	)
	if err != nil {
		writeErr(w, err, "query transaction summary")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleRenameTags(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	if me := jsonutil.RejectUnknownObjectKeys(raw, []string{"from", "to"}); me != nil {
		writeErr(w, me, "rename tags")
		return
	}
	// any 字段：与 Next 对齐，非 string from/to 走 validateRename，而非 Invalid JSON body
	var body struct {
		From any `json:"from"`
		To   any `json:"to"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
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

	updated, err := s.TagsSvc.RenameAcrossRecords(r.Context(), from, to)
	if err != nil {
		writeErr(w, err, "rename tags")
		return
	}
	writeJSON(w, http.StatusOK, RenameTagsSuccess{Success: true, Updated: updated})
}

func (s *Server) handleExportRecords(w http.ResponseWriter, r *http.Request) {
	parsed, me := exportapi.ParseExportRecordsParams(r.URL.Query())
	if me != nil {
		writeErr(w, me, "export records")
		return
	}
	recs, me2 := s.ExportSvc.FetchExportRecords(r.Context(), parsed)
	if me2 != nil {
		writeErr(w, me2, "Error exporting records")
		return
	}
	body, serr := exportapi.BuildExportNdjson(recs)
	if serr != nil {
		writeErr(w, serr, "serialize export ndjson")
		return
	}
	now := s.Now()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", exportapi.ExportContentDisposition(parsed.From, parsed.Limit, now))
	w.WriteHeader(200)
	// §4.5：响应体写出成功后再 Notify；Write 失败不视为成功备份。
	if _, err := w.Write([]byte(body)); err != nil {
		slog.Error("write export body", "err", err)
		return
	}
	msg := exportapi.FormatExportNotifyMessage(len(recs), parsed.From, parsed.Limit)
	go s.Notifier.NotifyUser(msg)
}

// handleImportRecords：勿走 readBody（MaxBodyBytes）；MultipartReader 取 file part（≤4MiB）。
func (s *Server) handleImportRecords(w http.ResponseWriter, r *http.Request) {
	ct := r.Header.Get("Content-Type")
	mediatype, params, err := mime.ParseMediaType(ct)
	if err != nil || !strings.EqualFold(mediatype, "multipart/form-data") {
		writeError(w, http.StatusBadRequest, importapi.ErrMultipartContentType)
		return
	}
	boundary := params["boundary"]
	if boundary == "" {
		writeError(w, http.StatusBadRequest, importapi.ErrMultipartContentType)
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
			writeError(w, http.StatusBadRequest, importapi.ErrMultipartContentType)
			return
		}
		if part.FormName() != "file" {
			// 非 file part 丢弃也加上限，避免恶意大字段占满内存。
			n, copyErr := io.Copy(io.Discard, io.LimitReader(part, int64(importapi.MaxImportFileBytes)+1))
			_ = part.Close()
			if copyErr != nil {
				writeError(w, http.StatusBadRequest, importapi.ErrMultipartContentType)
				return
			}
			if n > int64(importapi.MaxImportFileBytes) {
				writeError(w, http.StatusBadRequest, importapi.ErrMultipartPartTooLarge)
				return
			}
			continue
		}
		fileCount++
		if fileCount > 1 {
			_ = part.Close()
			writeError(w, http.StatusBadRequest, importapi.ErrMultipartMultipleFile)
			return
		}
		filename = filepath.Base(part.FileName())
		partCT = part.Header.Get("Content-Type")
		// +1 字节以区分恰好上限与超限
		fileRaw, err = io.ReadAll(io.LimitReader(part, int64(importapi.MaxImportFileBytes)+1))
		_ = part.Close()
		if err != nil {
			writeError(w, http.StatusBadRequest, importapi.ErrMultipartContentType)
			return
		}
	}
	if fileCount == 0 {
		writeError(w, http.StatusBadRequest, importapi.ErrMultipartRequired)
		return
	}
	if !importapi.IsAcceptedImportFilePart(partCT, filename) {
		writeError(w, http.StatusBadRequest, importapi.ErrUnsupportedFileContentType)
		return
	}
	if len(fileRaw) > importapi.MaxImportFileBytes {
		writeError(w, http.StatusBadRequest, importapi.ErrImportLimitsError)
		return
	}

	counts, me := s.ImportSvc.ImportRecordsJSONL(r.Context(), strings.NewReader(string(fileRaw)))
	if me != nil {
		writeErr(w, me, "import records")
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
		slog.Error("write import success body", "err", err)
		return
	}
	msg := importapi.FormatImportNotifyMessage(counts)
	go s.Notifier.NotifyUser(msg)
}
