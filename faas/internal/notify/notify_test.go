package notify

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/qqbot"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
)

func TestMain(m *testing.M) {
	_ = os.Setenv("DIGITAL_TWIN_TEST", "1")
	_ = os.Unsetenv("NOTIFY_ALLOW_IN_TEST")
	os.Exit(m.Run())
}

func TestShouldSkipNotifyInTest(t *testing.T) {
	if !ShouldSkipNotifyInTest(func(k string) string {
		if k == "DIGITAL_TWIN_TEST" {
			return "1"
		}
		return ""
	}) {
		t.Fatal("expected skip")
	}
	if ShouldSkipNotifyInTest(func(k string) string {
		switch k {
		case "DIGITAL_TWIN_TEST":
			return "1"
		case "NOTIFY_ALLOW_IN_TEST":
			return "1"
		}
		return ""
	}) {
		t.Fatal("expected allow")
	}
}

func TestNotifyUserSkipsInTestMode(t *testing.T) {
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
				case "DIGITAL_TWIN_TEST":
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
		t.Fatal("should not call channels in test mode")
	}
}

func TestNotifyUserWarnsWhenNoChannels(t *testing.T) {
	n := &Notifier{
		Getenv: func(k string) string {
			if k == "NOTIFY_ALLOW_IN_TEST" {
				return "1"
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
				case "NOTIFY_ALLOW_IN_TEST":
					return "1"
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
		case "NOTIFY_ALLOW_IN_TEST":
			return "1"
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
		case "NOTIFY_ALLOW_IN_TEST":
			return "1"
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
				case "NOTIFY_ALLOW_IN_TEST":
					return "1"
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
				case "NOTIFY_ALLOW_IN_TEST":
					return "1"
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
				case "NOTIFY_ALLOW_IN_TEST":
					return "1"
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
		ValueNumber:      &num,
		Tags:             `["weight"]`,
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
				if k == "NOTIFY_ALLOW_IN_TEST" {
					return "1"
				}
				return ""
			},
		},
		Qqbot: &qqbot.Sender{Getenv: func(k string) string {
			if k == "NOTIFY_ALLOW_IN_TEST" {
				return "1"
			}
			return ""
		}},
	}
	n.NotifyRecordInserted(record.Record{ID: "x", HappenedAt: "t", Tags: `["a"]`, ObjectiveContext: "o"})
	if called {
		t.Fatal("should not call when unconfigured")
	}
}
