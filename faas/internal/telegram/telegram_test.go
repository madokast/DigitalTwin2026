package telegram

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

func TestLoadConfig(t *testing.T) {
	cfg := LoadConfig(func(k string) string { return "" })
	if cfg.Configured() {
		t.Fatal("expected not configured")
	}
	if ConfigError(cfg) != "telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_USER_ID)" {
		t.Fatalf("error: %q", ConfigError(cfg))
	}

	cfg = LoadConfig(func(k string) string {
		if k == "TELEGRAM_BOT_TOKEN" {
			return " tok "
		}
		return ""
	})
	if ConfigError(cfg) != "telegram is not configured (missing TELEGRAM_USER_ID)" {
		t.Fatalf("error: %q", ConfigError(cfg))
	}

	cfg = LoadConfig(func(k string) string {
		switch k {
		case "TELEGRAM_BOT_TOKEN":
			return "tok"
		case "TELEGRAM_USER_ID":
			return "42"
		}
		return ""
	})
	if !cfg.Configured() || cfg.Token != "tok" || cfg.UserID != "42" {
		t.Fatalf("cfg: %+v", cfg)
	}
}

func TestFormatRecordMessage(t *testing.T) {
	num := "72.5"
	subj := "Feeling lighter"
	rec := record.Record{
		ID:               "id-1",
		HappenedAt:       "2026-07-31T12:00:00.000Z",
		NumericValue:     &num,
		Tags:             []string{"weight", "morning"},
		ObjectiveContext: "Scale reading",
		AiAnalysis:       &subj,
	}
	got := FormatRecordMessage(rec)
	want := strings.Join([]string{
		"New record",
		"id: id-1",
		"happened_at: 2026-07-31T12:00:00.000Z",
		"numeric_value: 72.5",
		"tags: weight, morning",
		"objective: Scale reading",
		"ai_analysis: Feeling lighter",
	}, "\n")
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}

	text := "Ran 5k"
	rec2 := record.Record{
		ID:               "id-2",
		HappenedAt:       "2026-07-31T13:00:00.000Z",
		RawContent:       &text,
		Tags:             []string{"run"},
		ObjectiveContext: "Park loop",
	}
	got2 := FormatRecordMessage(rec2)
	if !strings.Contains(got2, "raw_content: Ran 5k") || !strings.Contains(got2, "ai_analysis: (null)") {
		t.Fatalf("unexpected:\n%s", got2)
	}

	offsetRec := record.Record{
		ID:               "id-3",
		HappenedAt:       "2026-07-31T20:00:00.000+08:00",
		RawContent:       &text,
		Tags:             []string{"run"},
		ObjectiveContext: "Park loop",
	}
	got3 := FormatRecordMessage(offsetRec)
	if !strings.Contains(got3, "happened_at: 2026-07-31T20:00:00.000+08:00") {
		t.Fatalf("offset should pass through:\n%s", got3)
	}
}

func TestSendMessageSuccessAndFailure(t *testing.T) {
	var sawBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/sendMessage") {
			t.Fatalf("path %s", r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &sawBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	s := &Sender{
		HTTPClient: srv.Client(),
		APIBase:    srv.URL,
		Getenv: func(k string) string {
			switch k {
			case "TELEGRAM_BOT_TOKEN":
				return "bot"
			case "TELEGRAM_USER_ID":
				return "7"
			}
			return ""
		},
	}
	if err := s.SendMessage("DigitalTwin2026 probe"); err != nil {
		t.Fatal(err)
	}
	if sawBody["chat_id"] != "7" || sawBody["text"] != "DigitalTwin2026 probe" {
		t.Fatalf("body: %#v", sawBody)
	}

	failSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"ok":false,"description":"chat not found"}`))
	}))
	defer failSrv.Close()
	s.APIBase = failSrv.URL
	s.HTTPClient = failSrv.Client()
	err := s.SendMessage("x")
	if err == nil || !strings.Contains(err.Message, "chat not found") {
		t.Fatalf("err: %v", err)
	}
}

func TestSendMessageTransportErrorFixedMessage(t *testing.T) {
	s := &Sender{
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, fmt.Errorf("dial tcp: i/o timeout")
		})},
		APIBase: "http://example.invalid",
		Getenv: func(k string) string {
			switch k {
			case "TELEGRAM_BOT_TOKEN":
				return "bot"
			case "TELEGRAM_USER_ID":
				return "7"
			}
			return ""
		},
	}
	me := s.SendMessage("x")
	if me == nil || me.Status != 500 || !strings.Contains(me.Message, ErrTransportFailedMessage) {
		t.Fatalf("err: %v", me)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestFormatTagsEditedMessage(t *testing.T) {
	got := FormatTagsEditedMessage("add", "id-1", "workout:arm", []string{"exercise"}, []string{"exercise", "workout:arm"})
	want := strings.Join([]string{
		"Tags updated",
		"id: id-1",
		"action: add",
		"tag: workout:arm",
		"tags: from [exercise] to [exercise, workout:arm]",
	}, "\n")
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	if got := FormatTagsEditedMessage("remove", "id-2", "t", []string{}, []string{}); !strings.Contains(got, "tags: from [] to []") {
		t.Fatalf("empty lists: %s", got)
	}
}
