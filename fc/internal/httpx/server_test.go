package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/fc/internal/auth"
	"github.com/mdk/digitaltwin2026/fc/internal/query"
	"github.com/mdk/digitaltwin2026/fc/internal/telegram"
)

func testServer() *Server {
	return &Server{
		Pool:   nil,
		Tokens: auth.Tokens{AI: "ai-tok", Admin: "admin-tok"},
		Now:    time.Now,
	}
}

func TestCORSPreflight(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodOptions, "/api/query", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "Authorization")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status %d", rr.Code)
	}
	if rr.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("missing CORS origin")
	}
	if !strings.Contains(rr.Header().Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatal("missing Authorization in allow headers")
	}
}

func TestAuthRequired(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodGet, "/api/query", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 401 {
		t.Fatalf("status %d", rr.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["error"] != auth.UnauthorizedMessage {
		t.Fatalf("body: %v", body)
	}
}

func TestAdminRejectsAIToken(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/admin/tags/rename", strings.NewReader(`{"from":"a","to":"b"}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 401 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
}

func TestLogNumberValidationWithoutDB(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/number", strings.NewReader(`{
		"value_number": "1",
		"tags": ["weight"],
		"objective_context": "x"
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if !strings.Contains(body["error"], "happened_at") {
		t.Fatalf("error: %v", body)
	}
}

func TestLogNumberRejectsMissingTimezone(t *testing.T) {
	h := testServer().Handler()
	for _, happened := range []string{"2026-07-30", "2026-07-30T08:00:00"} {
		payload := fmt.Sprintf(`{
			"happened_at": %q,
			"value_number": "1",
			"tags": ["weight"],
			"objective_context": "x"
		}`, happened)
		req := httptest.NewRequest(http.MethodPost, "/api/log/number", strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer ai-tok")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("%q status %d body %s", happened, rr.Code, rr.Body.String())
		}
		var body map[string]string
		_ = json.Unmarshal(rr.Body.Bytes(), &body)
		want := "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)"
		if body["error"] != want {
			t.Fatalf("%q error: %v", happened, body)
		}
	}
}

func TestLogTextRejectsMissingTimezone(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/text", strings.NewReader(`{
		"happened_at": "2026-07-30T10:00:00",
		"value_text": "hello",
		"tags": ["study"],
		"objective_context": "x"
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	want := "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)"
	if body["error"] != want {
		t.Fatalf("error: %v", body)
	}
}

func TestLogTextRejectsReservedTag(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/text", strings.NewReader(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"value_text": "should fail",
		"tags": ["transaction_entry"],
		"objective_context": "x"
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	want := `tag "transaction_entry" is reserved; use POST /api/log/transaction for transaction line entries`
	if body["error"] != want {
		t.Fatalf("error: %v", body)
	}
}

func TestRenameTagsRejectsReservedTag(t *testing.T) {
	h := testServer().Handler()
	for _, tc := range []struct {
		payload string
		want    string
	}{
		{`{"from":"transaction_entry","to":"legacy_tx"}`, `tag "transaction_entry" is reserved; use POST /api/log/transaction for transaction line entries`},
		{`{"from":"food","to":"transaction_entry"}`, `tag "transaction_entry" is reserved; use POST /api/log/transaction for transaction line entries`},
		{`{"from":"transaction_entry:income","to":"legacy_tx"}`, `tag "transaction_entry:income" is reserved; use POST /api/log/transaction for transaction line entries`},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/admin/tags/rename", strings.NewReader(tc.payload))
		req.Header.Set("Authorization", "Bearer admin-tok")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("%s status %d body %s", tc.payload, rr.Code, rr.Body.String())
		}
		var body map[string]string
		_ = json.Unmarshal(rr.Body.Bytes(), &body)
		if body["error"] != tc.want {
			t.Fatalf("%s error: %v", tc.payload, body)
		}
	}
}

func TestSummaryInvalidTZWithoutDB(t *testing.T) {
	h := testServer().Handler()
	for _, tz := range []string{"Not%2FAZone", "Factory", "localtime"} {
		req := httptest.NewRequest(http.MethodGet, "/api/query/summary?tz="+tz, nil)
		req.Header.Set("Authorization", "Bearer ai-tok")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("tz=%s status %d body %s", tz, rr.Code, rr.Body.String())
		}
		var body map[string]string
		_ = json.Unmarshal(rr.Body.Bytes(), &body)
		if body["error"] != "Query parameter tz must be a valid IANA time zone" {
			t.Fatalf("tz=%s error=%v", tz, body)
		}
	}
}

func TestSummaryErrorClassification(t *testing.T) {
	// 与 handleSummary 相同判定：errors.Is(ErrInvalidTZ)；禁止再靠文案含 "tz"
	classify := func(err error) int {
		if errors.Is(err, query.ErrInvalidTZ) {
			return 400
		}
		return 500
	}
	if classify(query.ErrInvalidTZ) != 400 {
		t.Fatal("ErrInvalidTZ → 400")
	}
	if classify(fmt.Errorf("%w", query.ErrInvalidTZ)) != 400 {
		t.Fatal("wrapped ErrInvalidTZ → 400")
	}
	if classify(fmt.Errorf("connection failed near timezone column tz")) != 500 {
		t.Fatal("DB error containing tz must stay 500")
	}
}

func TestTelegramProbeNotConfigured(t *testing.T) {
	s := testServer()
	s.Telegram = &telegram.Sender{
		Getenv: func(string) string { return "" },
	}
	h := s.Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/telegram/probe", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if !strings.Contains(body["error"], "TELEGRAM_BOT_TOKEN") {
		t.Fatalf("error: %v", body)
	}
}

func TestTelegramProbeSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	s := testServer()
	s.Telegram = &telegram.Sender{
		HTTPClient: srv.Client(),
		APIBase:    srv.URL,
		Getenv: func(k string) string {
			switch k {
			case "TELEGRAM_BOT_TOKEN":
				return "tok"
			case "TELEGRAM_USER_ID":
				return "1"
			}
			return ""
		},
	}
	h := s.Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/telegram/probe", strings.NewReader(`{"text":"hi"}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["success"] != true {
		t.Fatalf("body: %v", body)
	}
}

func TestTelegramProbeSendFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"ok":false,"description":"chat not found"}`))
	}))
	defer srv.Close()

	s := testServer()
	s.Telegram = &telegram.Sender{
		HTTPClient: srv.Client(),
		APIBase:    srv.URL,
		Getenv: func(k string) string {
			switch k {
			case "TELEGRAM_BOT_TOKEN":
				return "tok"
			case "TELEGRAM_USER_ID":
				return "1"
			}
			return ""
		},
	}
	h := s.Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/telegram/probe", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 502 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "chat not found") {
		t.Fatalf("body: %s", rr.Body.String())
	}
}

func TestWriteInternalErrorNeverExposesDetails(t *testing.T) {
	t.Setenv("EXPOSE_ERRORS", "1")
	rr := httptest.NewRecorder()
	writeInternalError(rr, errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`))
	if rr.Code != 500 {
		t.Fatalf("status %d", rr.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "Internal server error" {
		t.Fatalf("leaked internal detail: %q", body["error"])
	}
}

