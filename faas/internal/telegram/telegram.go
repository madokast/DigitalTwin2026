// Package telegram：Bot sendMessage 与消息排版（与 src/lib/telegram.ts 对齐）
package telegram

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

// HTTPTimeout 与 Next TELEGRAM_HTTP_TIMEOUT_MS（15s）对齐。
const HTTPTimeout = 15 * time.Second

// ErrTransportFailedMessage 与 Next TELEGRAM_TRANSPORT_FAILED 同文案（超时/网络等）。
var ErrTransportFailedMessage = errors.New("Telegram sendMessage failed: request failed")

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

func formatTags(tags []string) string {
	return strings.Join(tags, ", ")
}

// FormatRecordMessage 英文纯文本排版。
func FormatRecordMessage(rec record.Record) string {
	lines := []string{
		"New record",
		"id: " + rec.ID,
		"happened_at: " + rec.HappenedAt,
	}
	if rec.NumericValue != nil && *rec.NumericValue != "" {
		lines = append(lines, "numeric_value: "+*rec.NumericValue)
	} else {
		vt := ""
		if rec.RawContent != nil {
			vt = *rec.RawContent
		}
		lines = append(lines, "raw_content: "+vt)
	}
	lines = append(lines, "tags: "+formatTags(rec.Tags))
	lines = append(lines, "objective: "+rec.ObjectiveContext)
	subj := "(null)"
	if rec.AiAnalysis != nil && *rec.AiAnalysis != "" {
		subj = *rec.AiAnalysis
	}
	lines = append(lines, "ai_analysis: "+subj)
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
	return &http.Client{Timeout: HTTPTimeout}
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
		return fmt.Errorf("%w", ErrTransportFailedMessage)
	}

	url := fmt.Sprintf("%s/bot%s/sendMessage", s.apiBase(), cfg.Token)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("%w", ErrTransportFailedMessage)
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := s.client().Do(req)
	if err != nil {
		return fmt.Errorf("%w", ErrTransportFailedMessage)
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

// FormatTransactionBatchMessage 整单摘要。
func FormatTransactionBatchMessage(rows []record.Record) string {
	n := len(rows)
	amounts := make([]string, 0, n)
	for _, r := range rows {
		if r.NumericValue != nil && *r.NumericValue != "" {
			amounts = append(amounts, *r.NumericValue)
		}
	}
	sumLabel := "(mixed)"
	if len(amounts) == n {
		sumLabel = strings.Join(amounts, " + ")
	}
	firstMemo := ""
	happened := ""
	typeLabel := "(unknown)"
	if n > 0 {
		firstMemo = rows[0].ObjectiveContext
		happened = rows[0].HappenedAt
		if t := transactionTypeFromTags(rows[0].Tags); t != "" {
			typeLabel = t
		}
	}
	return strings.Join([]string{
		"New transactions batch",
		"type: " + typeLabel,
		fmt.Sprintf("inserted: %d", n),
		"happened_at: " + happened,
		"amounts: " + sumLabel,
		"first_memo: " + firstMemo,
	}, "\n")
}

// FormatNumberBatchMessage 整单摘要。
func FormatNumberBatchMessage(rows []record.Record) string {
	n := len(rows)
	happened := ""
	if n > 0 {
		happened = rows[0].HappenedAt
	}
	lines := []string{
		"New numbers batch",
		fmt.Sprintf("inserted: %d", n),
		"happened_at: " + happened,
	}
	for _, r := range rows {
		value := ""
		if r.NumericValue != nil {
			value = *r.NumericValue
		}
		lines = append(lines, fmt.Sprintf("%s/%s/%s", value, r.ObjectiveContext, strings.Join(r.Tags, ",")))
	}
	return strings.Join(lines, "\n")
}

// transactionTypeFromTags 从 tags JSON 取 transaction_entry:{type}。
func transactionTypeFromTags(tagList []string) string {
	prefix := tags.ReservedTagTransactionEntry + ":"
	for _, s := range tagList {
		if strings.HasPrefix(s, prefix) {
			rest := s[len(prefix):]
			if rest != "" {
				return rest
			}
		}
	}
	return ""
}

// Default 进程级默认 Sender（生产路径）。
var Default = &Sender{}
