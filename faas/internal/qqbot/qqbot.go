// Package qqbot：QQ Bot 主动 C2C 通知（与 src/lib/qqbot.ts 对齐）
package qqbot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
)

// HTTPTimeout 与 Next QQBOT_HTTP_TIMEOUT_MS（15s）对齐。
const HTTPTimeout = 15 * time.Second

// ErrTransportFailedMessage 与 Next QQBOT_TRANSPORT_FAILED 同文案（超时/网络等）。
const ErrTransportFailedMessage = "QQ Bot sendMessage failed: request failed"

const defaultTokenURL = "https://bots.qq.com/app/getAppAccessToken"

// 提前刷新窗口：距过期不足此时长则重新拉 token
const tokenRefreshSkew = 60 * time.Second

var defaultAPIBases = []string{
	"https://api.sgroup.qq.com",
	"https://api.bot.qq.com",
}

// Config 三键均非空才算 configured。
type Config struct {
	AppID      string
	AppSecret  string
	UserOpenID string
	Missing    []string
}

func (c Config) Configured() bool {
	return len(c.Missing) == 0
}

// LoadConfig 从环境变量读取（可注入 getenv 便于测试）。
func LoadConfig(getenv func(string) string) Config {
	if getenv == nil {
		getenv = os.Getenv
	}
	appID := strings.TrimSpace(getenv("QQBOT_APP_ID"))
	appSecret := strings.TrimSpace(getenv("QQBOT_APP_SECRET"))
	userOpenID := strings.TrimSpace(getenv("QQBOT_USER_OPENID"))
	var missing []string
	if appID == "" {
		missing = append(missing, "QQBOT_APP_ID")
	}
	if appSecret == "" {
		missing = append(missing, "QQBOT_APP_SECRET")
	}
	if userOpenID == "" {
		missing = append(missing, "QQBOT_USER_OPENID")
	}
	return Config{
		AppID:      appID,
		AppSecret:  appSecret,
		UserOpenID: userOpenID,
		Missing:    missing,
	}
}

// ConfigError 未配置时的英文错误；已配置返回 ""。
func ConfigError(cfg Config) string {
	if cfg.Configured() {
		return ""
	}
	if len(cfg.Missing) == 3 {
		return "QQ Bot is not configured (QQBOT_APP_ID / QQBOT_APP_SECRET / QQBOT_USER_OPENID)"
	}
	return "QQ Bot is not configured (missing " + strings.Join(cfg.Missing, ", ") + ")"
}

// Sender 便于单测注入 HTTP / bases / token URL。
type Sender struct {
	HTTPClient *http.Client
	Getenv     func(string) string
	TokenURL   string   // 默认 bots.qq.com getAppAccessToken
	APIBases   []string // 默认双 base；可注入便于测

	// 刻意允许的双端差异（docs/20260801-api-layering.md §1.1）：
	// Go 每 Sender 自带 token 缓存；TS 为包级 tokenCache。发送语义对齐。
	tokenMu   sync.Mutex
	token     string
	expiresAt time.Time
}

// ClearAccessTokenCacheForTests 清空本 Sender 的 access_token 缓存。
func (s *Sender) ClearAccessTokenCacheForTests() {
	if s == nil {
		return
	}
	s.tokenMu.Lock()
	defer s.tokenMu.Unlock()
	s.token = ""
	s.expiresAt = time.Time{}
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

func (s *Sender) tokenURL() string {
	if s != nil && s.TokenURL != "" {
		return s.TokenURL
	}
	return defaultTokenURL
}

func (s *Sender) apiBases() []string {
	if s != nil && len(s.APIBases) > 0 {
		out := make([]string, len(s.APIBases))
		for i, b := range s.APIBases {
			out[i] = strings.TrimRight(b, "/")
		}
		return out
	}
	return append([]string(nil), defaultAPIBases...)
}

func (s *Sender) cachedTokenValid() string {
	s.tokenMu.Lock()
	defer s.tokenMu.Unlock()
	if s.token == "" {
		return ""
	}
	if time.Now().After(s.expiresAt.Add(-tokenRefreshSkew)) {
		return ""
	}
	return s.token
}

func (s *Sender) storeToken(token string, expiresInSec int) {
	ttl := expiresInSec
	if ttl <= 0 {
		ttl = 7200
	}
	s.tokenMu.Lock()
	defer s.tokenMu.Unlock()
	s.token = token
	s.expiresAt = time.Now().Add(time.Duration(ttl) * time.Second)
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   any    `json:"expires_in"`
	Message     string `json:"message"`
	Msg         string `json:"msg"`
}

func parseExpiresIn(v any) int {
	switch x := v.(type) {
	case float64:
		if x > 0 {
			return int(x)
		}
	case json.Number:
		n, err := x.Int64()
		if err == nil && n > 0 {
			return int(n)
		}
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		if err == nil && n > 0 {
			return n
		}
	case int:
		if x > 0 {
			return x
		}
	}
	return 0
}

// fetchAccessToken 外部 OAuth 换取 access_token。错误语义：外部 API / 网络失败 → 500。
func (s *Sender) fetchAccessToken(cfg Config) (string, *myerr.MyError) {
	payload, err := json.Marshal(map[string]string{
		"appId":        cfg.AppID,
		"clientSecret": cfg.AppSecret,
	})
	if err != nil {
		return "", myerr.NewValidation(err.Error())
	}
	req, err := http.NewRequest(http.MethodPost, s.tokenURL(), bytes.NewReader(payload))
	if err != nil {
		return "", myerr.NewInternalMsg(ErrTransportFailedMessage)
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := s.client().Do(req)
	if err != nil {
		return "", myerr.NewInternalMsg(ErrTransportFailedMessage)
	}
	defer res.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var parsed tokenResponse
	_ = json.Unmarshal(raw, &parsed)
	if parsed.AccessToken == "" {
		reason := parsed.Message
		if reason == "" {
			reason = parsed.Msg
		}
		if reason == "" {
			reason = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		return "", myerr.NewInternal(fmt.Errorf("QQ Bot getAppAccessToken failed: %s", reason))
	}
	s.storeToken(parsed.AccessToken, parseExpiresIn(parsed.ExpiresIn))
	return parsed.AccessToken, nil
}

func (s *Sender) resolveAccessToken(cfg Config) (string, *myerr.MyError) {
	if tok := s.cachedTokenValid(); tok != "" {
		return tok, nil
	}
	return s.fetchAccessToken(cfg)
}

type sendErrorBody struct {
	Message string `json:"message"`
	Msg     string `json:"msg"`
	Code    *int   `json:"code"`
}

func readSendErrorReason(status int, raw []byte) string {
	var body sendErrorBody
	if json.Unmarshal(raw, &body) == nil {
		if body.Message != "" {
			return body.Message
		}
		if body.Msg != "" {
			return body.Msg
		}
		if body.Code != nil {
			return fmt.Sprintf("code %d", *body.Code)
		}
	}
	return fmt.Sprintf("HTTP %d", status)
}

// SendMessage 主动 C2C 文本（无 msg_id）；双 API base 依次尝试。
// 错误英文不含 appSecret / access_token。错误语义：配置缺失 / 数据问题 → 400；外部失败 → 500。
func (s *Sender) SendMessage(text string) *myerr.MyError {
	cfg := LoadConfig(s.getenv())
	if !cfg.Configured() {
		return myerr.NewValidation(ConfigError(cfg))
	}

	token, me := s.resolveAccessToken(cfg)
	if me != nil {
		return me
	}
	if token == "" {
		return myerr.NewInternalMsg(ErrTransportFailedMessage)
	}

	path := "/v2/users/" + url.PathEscape(cfg.UserOpenID) + "/messages"
	payload, err := json.Marshal(map[string]any{
		"content":  text,
		"msg_type": 0,
	})
	if err != nil {
		return myerr.NewValidation(err.Error())
	}

	lastErr := "send failed"
	for _, base := range s.apiBases() {
		req, err := http.NewRequest(http.MethodPost, base+path, bytes.NewReader(payload))
		if err != nil {
			lastErr = "request failed"
			continue
		}
		req.Header.Set("Authorization", "QQBot "+token)
		req.Header.Set("Content-Type", "application/json; charset=utf-8")

		res, err := s.client().Do(req)
		if err != nil {
			lastErr = "request failed"
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		_ = res.Body.Close()
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return nil
		}
		lastErr = readSendErrorReason(res.StatusCode, raw)
	}
	return myerr.NewInternal(fmt.Errorf("QQ Bot sendMessage failed: %s", lastErr))
}

// Default 进程级默认 Sender（生产路径）。
var Default = &Sender{}
