// Package telegram：Bot sendMessage 与录入成功通知（与 src/lib/telegram.ts 对齐）
package telegram

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/mdk/digitaltwin2026/fc/internal/record"
)

// Config 为非空 token + user id 才算 configured。
type Config struct {
	Token   string
	UserID  string
	Missing []string
}

func (c Config) Configured() bool {
	return len(c.Missing) == 0
}

// LoadConfig 从环境变量读取（可注入 env map 便于测试）。
func LoadConfig(getenv func(string) string) Config {
	if getenv == nil {
		getenv = os.Getenv
	}
	token := strings.TrimSpace(getenv("TELEGRAM_BOT_TOKEN"))
	userID := strings.TrimSpace(getenv("TELEGRAM_USER_ID"))
	var missing []string
	if token == "" {
		missing = append(missing, "TELEGRAM_BOT_TOKEN")
	}
	if userID == "" {
		missing = append(missing, "TELEGRAM_USER_ID")
	}
	return Config{Token: token, UserID: userID, Missing: missing}
}

// ConfigError 未配置时的英文错误；已配置返回 ""。
func ConfigError(cfg Config) string {
	if cfg.Configured() {
		return ""
	}
	if len(cfg.Missing) == 2 {
		return "Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_USER_ID)"
	}
	return "Telegram is not configured (missing " + strings.Join(cfg.Missing, ", ") + ")"
}

func formatTags(tagsJSON string) string {
	var arr []any
	if err := json.Unmarshal([]byte(tagsJSON), &arr); err != nil {
		return tagsJSON
	}
	parts := make([]string, 0, len(arr))
	for _, v := range arr {
		parts = append(parts, fmt.Sprint(v))
	}
	return strings.Join(parts, ", ")
}

// FormatRecordMessage 英文纯文本排版。
func FormatRecordMessage(rec record.Record) string {
	lines := []string{
		"New record",
		"id: " + rec.ID,
		"happened_at: " + rec.HappenedAt,
	}
	if rec.ValueNumber != nil && *rec.ValueNumber != "" {
		lines = append(lines, "value_number: "+*rec.ValueNumber)
	} else {
		vt := ""
		if rec.ValueText != nil {
			vt = *rec.ValueText
		}
		lines = append(lines, "value_text: "+vt)
	}
	lines = append(lines, "tags: "+formatTags(rec.Tags))
	lines = append(lines, "objective: "+rec.ObjectiveContext)
	subj := "(null)"
	if rec.SubjectiveInterpretation != nil && *rec.SubjectiveInterpretation != "" {
		subj = *rec.SubjectiveInterpretation
	}
	lines = append(lines, "subjective: "+subj)
	return strings.Join(lines, "\n")
}

// Sender 便于单测注入 HTTP。
type Sender struct {
	HTTPClient *http.Client
	Getenv     func(string) string
	APIBase    string // 默认 https://api.telegram.org
}

func (s *Sender) client() *http.Client {
	if s != nil && s.HTTPClient != nil {
		return s.HTTPClient
	}
	return &http.Client{Timeout: 15 * time.Second}
}

func (s *Sender) getenv() func(string) string {
	if s != nil && s.Getenv != nil {
		return s.Getenv
	}
	return os.Getenv
}

func (s *Sender) apiBase() string {
	if s != nil && s.APIBase != "" {
		return strings.TrimRight(s.APIBase, "/")
	}
	return "https://api.telegram.org"
}

type sendBody struct {
	ChatID                string `json:"chat_id"`
	Text                  string `json:"text"`
	DisableWebPagePreview bool   `json:"disable_web_page_preview"`
}

type apiResponse struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
}

// SendMessage 调用 Bot API sendMessage。
func (s *Sender) SendMessage(text string) error {
	cfg := LoadConfig(s.getenv())
	if !cfg.Configured() {
		return fmt.Errorf("%s", ConfigError(cfg))
	}

	payload, err := json.Marshal(sendBody{
		ChatID:                cfg.UserID,
		Text:                  text,
		DisableWebPagePreview: true,
	})
	if err != nil {
		return fmt.Errorf("Telegram sendMessage failed: %w", err)
	}

	url := fmt.Sprintf("%s/bot%s/sendMessage", s.apiBase(), cfg.Token)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("Telegram sendMessage failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := s.client().Do(req)
	if err != nil {
		return fmt.Errorf("Telegram sendMessage failed: %w", err)
	}
	defer res.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var parsed apiResponse
	_ = json.Unmarshal(raw, &parsed)
	if parsed.OK {
		return nil
	}
	reason := parsed.Description
	if reason == "" {
		reason = fmt.Sprintf("HTTP %d", res.StatusCode)
	}
	return fmt.Errorf("Telegram sendMessage failed: %s", reason)
}

// ShouldSkipNotifyInTest 测试态下跳过录入后自动通知。
// TELEGRAM_ALLOW_IN_TEST=1 可放行；probe 走 SendMessage，不受此限制。
// 同时看注入 getenv 与 os.Getenv（TestMain 设的 DIGITAL_TWIN_TEST）。
func ShouldSkipNotifyInTest(getenv func(string) string) bool {
	if getenv == nil {
		getenv = os.Getenv
	}
	allow := strings.TrimSpace(getenv("TELEGRAM_ALLOW_IN_TEST"))
	if allow == "" {
		allow = strings.TrimSpace(os.Getenv("TELEGRAM_ALLOW_IN_TEST"))
	}
	if allow == "1" {
		return false
	}
	flag := strings.TrimSpace(getenv("DIGITAL_TWIN_TEST"))
	if flag == "" {
		flag = strings.TrimSpace(os.Getenv("DIGITAL_TWIN_TEST"))
	}
	return flag == "1"
}

// NotifyRecordInserted best-effort：测试态 / 未配置跳过；失败只打日志。
func (s *Sender) NotifyRecordInserted(rec record.Record) {
	getenv := s.getenv()
	// 测试态静默跳过，避免集成/插入路径打扰真实 Bot
	if ShouldSkipNotifyInTest(getenv) {
		return
	}
	cfg := LoadConfig(getenv)
	if !cfg.Configured() {
		log.Printf("Telegram notify skipped: not configured")
		return
	}
	if err := s.SendMessage(FormatRecordMessage(rec)); err != nil {
		log.Printf("Telegram notify failed: %v", err)
	}
}

// FormatTransactionBatchMessage 整单摘要。
func FormatTransactionBatchMessage(rows []record.Record) string {
	n := len(rows)
	amounts := make([]string, 0, n)
	for _, r := range rows {
		if r.ValueNumber != nil && *r.ValueNumber != "" {
			amounts = append(amounts, *r.ValueNumber)
		}
	}
	sumLabel := "(mixed)"
	if len(amounts) == n {
		sumLabel = strings.Join(amounts, " + ")
	}
	firstMemo := ""
	happened := ""
	if n > 0 {
		firstMemo = rows[0].ObjectiveContext
		happened = rows[0].HappenedAt
	}
	return strings.Join([]string{
		"New transaction batch",
		fmt.Sprintf("inserted: %d", n),
		"happened_at: " + happened,
		"amounts: " + sumLabel,
		"first_memo: " + firstMemo,
	}, "\n")
}

// NotifyTransactionBatchInserted best-effort 一条摘要。
func (s *Sender) NotifyTransactionBatchInserted(rows []record.Record) {
	if len(rows) == 0 {
		return
	}
	getenv := s.getenv()
	if ShouldSkipNotifyInTest(getenv) {
		return
	}
	cfg := LoadConfig(getenv)
	if !cfg.Configured() {
		log.Printf("Telegram notify skipped: not configured")
		return
	}
	if err := s.SendMessage(FormatTransactionBatchMessage(rows)); err != nil {
		log.Printf("Telegram notify failed: %v", err)
	}
}

// Default 进程级默认 Sender（生产路径）。
var Default = &Sender{}
