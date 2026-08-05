package notify

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf8"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/qqbot"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
)

func TestMain(m *testing.M) {
	_ = os.Setenv("SUPPRESS_BOT_NOTIFICATION", "1")
	os.Exit(m.Run())
}

type truncateCases struct {
	MaxLen int `json:"max_len"`
	Suffix string `json:"suffix"`
	Cases  []struct {
		Name      string `json:"name"`
		Length    int    `json:"length"`
		CJK       bool   `json:"cjk"`
		Truncated bool   `json:"truncated"`
	} `json:"cases"`
}

func loadTruncateCases(t *testing.T) truncateCases {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	b, err := os.ReadFile(filepath.Join(root, "testdata", "notify-truncate-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases truncateCases
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func TestTruncateNotifyMessage(t *testing.T) {
	cases := loadTruncateCases(t)
	if NotifyMessageMaxLen != cases.MaxLen || NotifyTruncationSuffix != cases.Suffix {
		t.Fatalf("constants mismatch fixture: len=%d suffix=%q", cases.MaxLen, cases.Suffix)
	}
	for _, tc := range cases.Cases {
		unit := "a"
		if tc.CJK {
			unit = "字"
		}
		input := strings.Repeat(unit, tc.Length)
		out := TruncateNotifyMessage(input)
		if !tc.Truncated {
			if out != input {
				t.Fatalf("%s: want unchanged", tc.Name)
			}
			continue
		}
		if len([]rune(out)) != NotifyMessageMaxLen {
			t.Fatalf("%s: len=%d want %d", tc.Name, len([]rune(out)), NotifyMessageMaxLen)
		}
		if !strings.HasSuffix(out, NotifyTruncationSuffix) {
			t.Fatalf("%s: missing suffix", tc.Name)
		}
		if !strings.HasPrefix(out, strings.Repeat(unit, 10)) {
			t.Fatalf("%s: missing head", tc.Name)
		}
	}
}

func TestShouldSuppressBotNotification(t *testing.T) {
	cases := []struct {
		name string
		val  string
		want bool
	}{
		{name: "one", val: "1", want: true},
		{name: "trimmed_one", val: " 1 ", want: true},
		{name: "zero", val: "0", want: false},
		{name: "true", val: "true", want: false},
		{name: "yes", val: "yes", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ShouldSuppressBotNotification(func(k string) string {
				if k == "SUPPRESS_BOT_NOTIFICATION" {
					return tc.val
				}
				return ""
			})
			if got != tc.want {
				t.Fatalf("val=%q got=%v want=%v", tc.val, got, tc.want)
			}
		})
	}

	// 空注入回退 process.env（TestMain 设 SUPPRESS=1）
	if !ShouldSuppressBotNotification(func(string) string { return "" }) {
		t.Fatal("expected fallback to process.env SUPPRESS=1")
	}
}

func TestNotifyUserSkipsWhenSuppressed(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()

	n := &Notifier{
		Telegram: &telegram.Sender{
			HTTPClient: srv.Client(),
			APIBase:    srv.URL,
			Getenv: func(k string) string {
				switch k {
				case "SUPPRESS_BOT_NOTIFICATION":
					return "1"
				case "TELEGRAM_BOT_TOKEN":
					return "tok"
				case "TELEGRAM_USER_ID":
					return "1"
				}
				return ""
			},
		},
		Qqbot: &qqbot.Sender{Getenv: func(string) string { return "" }},
	}
	n.NotifyUser("hello")
	if called {
		t.Fatal("should not call channels when SUPPRESS_BOT_NOTIFICATION=1")
	}
}

func TestNotifyUserWarnsWhenNoChannels(t *testing.T) {
	n := &Notifier{
		Getenv: func(k string) string {
			if k == "SUPPRESS_BOT_NOTIFICATION" {
				return "0"
			}
			return ""
		},
		Telegram: &telegram.Sender{Getenv: func(string) string { return "" }},
		Qqbot:    &qqbot.Sender{Getenv: func(string) string { return "" }},
	}
	// 不应 panic；未配置时只打 warn 日志
	n.NotifyUser("hello")
}

func TestNotifyUserTelegramOnly(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	n := &Notifier{
		Telegram: &telegram.Sender{
			HTTPClient: srv.Client(),
			APIBase:    srv.URL,
			Getenv: func(k string) string {
				switch k {
				case "SUPPRESS_BOT_NOTIFICATION":
					return "0"
				case "TELEGRAM_BOT_TOKEN":
					return "tok"
				case "TELEGRAM_USER_ID":
					return "9"
				}
				return ""
			},
		},
		Qqbot: &qqbot.Sender{Getenv: func(string) string { return "" }},
	}
	n.NotifyUser("hi")
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestNotifyUserQQOnly(t *testing.T) {
	var tokenOK, sendOK int32
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&tokenOK, 1)
		_, _ = w.Write([]byte(`{"access_token":"qt","expires_in":7200}`))
	}))
	defer tokenSrv.Close()
	sendSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&sendOK, 1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer sendSrv.Close()

	env := func(k string) string {
		switch k {
		case "SUPPRESS_BOT_NOTIFICATION":
			return "0"
		case "QQBOT_APP_ID":
			return "a"
		case "QQBOT_APP_SECRET":
			return "s"
		case "QQBOT_USER_OPENID":
			return "o"
		}
		return ""
	}
	n := &Notifier{
		Getenv:   env,
		Telegram: &telegram.Sender{Getenv: func(string) string { return "" }},
		Qqbot: &qqbot.Sender{
			HTTPClient: sendSrv.Client(),
			TokenURL:   tokenSrv.URL,
			APIBases:   []string{sendSrv.URL},
			Getenv:     env,
		},
	}
	n.NotifyUser("hi")
	if atomic.LoadInt32(&tokenOK) < 1 || atomic.LoadInt32(&sendOK) < 1 {
		t.Fatalf("token=%d send=%d", tokenOK, sendOK)
	}
}

func TestNotifyUserBothParallel(t *testing.T) {
	var inflight, maxInflight int32
	tgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := atomic.AddInt32(&inflight, 1)
		for {
			old := atomic.LoadInt32(&maxInflight)
			if cur <= old || atomic.CompareAndSwapInt32(&maxInflight, old, cur) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		atomic.AddInt32(&inflight, -1)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer tgSrv.Close()

	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := atomic.AddInt32(&inflight, 1)
		for {
			old := atomic.LoadInt32(&maxInflight)
			if cur <= old || atomic.CompareAndSwapInt32(&maxInflight, old, cur) {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
		atomic.AddInt32(&inflight, -1)
		_, _ = w.Write([]byte(`{"access_token":"qt","expires_in":7200}`))
	}))
	defer tokenSrv.Close()

	qqSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer qqSrv.Close()

	env := func(k string) string {
		switch k {
		case "SUPPRESS_BOT_NOTIFICATION":
			return "0"
		case "TELEGRAM_BOT_TOKEN":
			return "tok"
		case "TELEGRAM_USER_ID":
			return "9"
		case "QQBOT_APP_ID":
			return "a"
		case "QQBOT_APP_SECRET":
			return "s"
		case "QQBOT_USER_OPENID":
			return "o"
		}
		return ""
	}
	n := &Notifier{
		Telegram: &telegram.Sender{
			HTTPClient: tgSrv.Client(),
			APIBase:    tgSrv.URL,
			Getenv:     env,
		},
		Qqbot: &qqbot.Sender{
			HTTPClient: qqSrv.Client(),
			TokenURL:   tokenSrv.URL,
			APIBases:   []string{qqSrv.URL},
			Getenv:     env,
		},
	}
	n.NotifyUser("hi")
	if atomic.LoadInt32(&maxInflight) < 2 {
		t.Fatalf("maxInflight=%d want >=2", maxInflight)
	}
}

func TestNotifyUserTimeout(t *testing.T) {
	// 永不返回的 RoundTrip，避免 httptest.Close 等 handler Sleep
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })

	n := &Notifier{
		Timeout: 50 * time.Millisecond,
		Telegram: &telegram.Sender{
			HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				<-block
				return nil, fmt.Errorf("cancelled")
			})},
			APIBase: "http://example.invalid",
			Getenv: func(k string) string {
				switch k {
				case "SUPPRESS_BOT_NOTIFICATION":
					return "0"
				case "TELEGRAM_BOT_TOKEN":
					return "tok"
				case "TELEGRAM_USER_ID":
					return "9"
				}
				return ""
			},
		},
		Qqbot: &qqbot.Sender{Getenv: func(string) string { return "" }},
	}
	started := time.Now()
	n.NotifyUser("hi")
	if time.Since(started) > 500*time.Millisecond {
		t.Fatal("should return after parallel timeout")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestNotifyUserLogsFailureWithoutPanic(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"ok":false,"description":"Unauthorized"}`))
	}))
	defer srv.Close()

	n := &Notifier{
		Telegram: &telegram.Sender{
			HTTPClient: srv.Client(),
			APIBase:    srv.URL,
			Getenv: func(k string) string {
				switch k {
				case "SUPPRESS_BOT_NOTIFICATION":
					return "0"
				case "TELEGRAM_BOT_TOKEN":
					return "t"
				case "TELEGRAM_USER_ID":
					return "1"
				}
				return ""
			},
		},
		Qqbot: &qqbot.Sender{Getenv: func(string) string { return "" }},
	}
	n.NotifyUser("hi")
}

func TestNotifyRecordInsertedFormats(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	n := &Notifier{
		Telegram: &telegram.Sender{
			HTTPClient: srv.Client(),
			APIBase:    srv.URL,
			Getenv: func(k string) string {
				switch k {
				case "SUPPRESS_BOT_NOTIFICATION":
					return "0"
				case "TELEGRAM_BOT_TOKEN":
					return "t"
				case "TELEGRAM_USER_ID":
					return "1"
				}
				return ""
			},
		},
		Qqbot: &qqbot.Sender{Getenv: func(string) string { return "" }},
	}
	num := "72.5"
	n.NotifyRecordInserted(record.Record{
		ID:               "id-1",
		HappenedAt:       "2026-07-31T12:00:00.000Z",
		NumericValue:      &num,
		Tags:             []string{"weight"},
		ObjectiveContext: "Scale",
	})
	if !strings.Contains(body, "New record") {
		t.Fatalf("body: %s", body)
	}
}

func TestNotifySkipsWhenUnconfigured(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = fmt.Fprintf(w, `{"ok":true}`)
	}))
	defer srv.Close()

	n := &Notifier{
		Telegram: &telegram.Sender{
			HTTPClient: srv.Client(),
			APIBase:    srv.URL,
			Getenv: func(k string) string {
				if k == "SUPPRESS_BOT_NOTIFICATION" {
					return "0"
				}
				return ""
			},
		},
		Qqbot: &qqbot.Sender{Getenv: func(k string) string {
			if k == "SUPPRESS_BOT_NOTIFICATION" {
				return "0"
			}
			return ""
		}},
	}
	n.NotifyRecordInserted(record.Record{ID: "x", HappenedAt: "t", Tags: []string{"a"}, ObjectiveContext: "o"})
	if called {
		t.Fatal("should not call when unconfigured")
	}
}

func TestNotifyNumberBatchInsertedFormats(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	n := &Notifier{
		Telegram: &telegram.Sender{
			HTTPClient: srv.Client(),
			APIBase:    srv.URL,
			Getenv: func(k string) string {
				switch k {
				case "SUPPRESS_BOT_NOTIFICATION":
					return "0"
				case "TELEGRAM_BOT_TOKEN":
					return "t"
				case "TELEGRAM_USER_ID":
					return "1"
				}
				return ""
			},
		},
		Qqbot: &qqbot.Sender{Getenv: func(string) string { return "" }},
	}
	v1, v2 := "72.5", "36.8"
	n.NotifyNumberBatchInserted([]record.Record{
		{ID: "id-1", HappenedAt: "2026-08-05T10:00:00+08:00", NumericValue: &v1, ObjectiveContext: "Scale"},
		{ID: "id-2", HappenedAt: "2026-08-05T10:00:00+08:00", NumericValue: &v2, ObjectiveContext: "axillary"},
	})
	if !strings.Contains(body, "New numbers batch") {
		t.Fatalf("body: %s", body)
	}
	if !strings.Contains(body, "inserted: 2") {
		t.Fatalf("body: %s", body)
	}
	// 逐条：value/memo/tags
	if !strings.Contains(body, "72.5/Scale/") {
		t.Fatalf("body: %s", body)
	}
	if !strings.Contains(body, "36.8/axillary/") {
		t.Fatalf("body: %s", body)
	}
}

func TestNotifyNumberBatchInsertedSkipsEmpty(t *testing.T) {
	// len==0 早返回，nil Notifier / 无渠道也不会 panic 或发送
	var n *Notifier
	n.NotifyNumberBatchInserted(nil)
}

func TestNotifyNumberBatchInsertedTruncatesOversized(t *testing.T) {
	rows := make([]record.Record, 100)
	for i := range rows {
		v := "36.8"
		rows[i] = record.Record{
			ID:               fmt.Sprintf("id-%d", i),
			HappenedAt:       "2026-08-05T10:00:00+08:00",
			NumericValue:      &v,
			Tags:             []string{"vitals"},
			ObjectiveContext: fmt.Sprintf("axillary temperature reading %d", i),
		}
	}
	raw := telegram.FormatNumberBatchMessage(rows)
	if utf8.RuneCountInString(raw) <= NotifyMessageMaxLen {
		t.Fatalf("raw should exceed limit, runes=%d", utf8.RuneCountInString(raw))
	}
	out := TruncateNotifyMessage(raw)
	if utf8.RuneCountInString(out) != NotifyMessageMaxLen {
		t.Fatalf("truncated runes=%d want %d", utf8.RuneCountInString(out), NotifyMessageMaxLen)
	}
	if !strings.HasSuffix(out, NotifyTruncationSuffix) {
		t.Fatalf("missing suffix: %q", out[len(out)-20:])
	}
}
