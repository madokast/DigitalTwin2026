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
	"github.com/mdk/digitaltwin2026/fc/internal/qqbot"
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

func TestJSONNotFoundAndMethodNotAllowed(t *testing.T) {
	h := testServer().Handler()

	req404 := httptest.NewRequest(http.MethodGet, "/api/no-such-route", nil)
	req404.Header.Set("Authorization", "Bearer ai-tok")
	rr404 := httptest.NewRecorder()
	h.ServeHTTP(rr404, req404)
	if rr404.Code != 404 {
		t.Fatalf("404 status %d body %s", rr404.Code, rr404.Body.String())
	}
	if rr404.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("404 content-type %q", rr404.Header().Get("Content-Type"))
	}
	var body404 map[string]string
	_ = json.Unmarshal(rr404.Body.Bytes(), &body404)
	if body404["error"] != "Not found" {
		t.Fatalf("404 body %v", body404)
	}

	req405 := httptest.NewRequest(http.MethodGet, "/api/log/number", nil)
	req405.Header.Set("Authorization", "Bearer ai-tok")
	rr405 := httptest.NewRecorder()
	h.ServeHTTP(rr405, req405)
	if rr405.Code != 405 {
		t.Fatalf("405 status %d body %s", rr405.Code, rr405.Body.String())
	}
	var body405 map[string]string
	_ = json.Unmarshal(rr405.Body.Bytes(), &body405)
	if body405["error"] != "Method not allowed" {
		t.Fatalf("405 body %v", body405)
	}
	if !strings.Contains(rr405.Header().Get("Allow"), "POST") {
		t.Fatalf("405 Allow %q", rr405.Header().Get("Allow"))
	}
}

func TestAdminPathPrefixDoesNotMatchAdministration(t *testing.T) {
	h := testServer().Handler()
	// /api/administration 不是 admin 路由：AI token 应能过鉴权（再 404）
	req := httptest.NewRequest(http.MethodGet, "/api/administration", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code == 401 {
		t.Fatal("AI token must not be rejected as admin-only for /api/administration")
	}
	if rr.Code != 404 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
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

func TestLogRejectsInvalidSuppressNotificationWithoutDB(t *testing.T) {
	h := testServer().Handler()
	cases := []struct {
		path, payload string
	}{
		{
			"/api/log/number",
			`{"happened_at":"2026-08-01T12:00:00Z","value_number":"1","tags":["weight"],"objective_context":"x","suppress_notification":"true"}`,
		},
		{
			"/api/log/text",
			`{"happened_at":"2026-08-01T12:00:00Z","value_text":"hi","tags":["study"],"objective_context":"x","suppress_notification":1}`,
		},
		{
			"/api/log/transaction",
			`{"happened_at":"2026-08-01T12:00:00Z","type":"expense","entries":[{"amount":"1.00","memo":"m","category":"food","subcategory":"lunch"}],"suppress_notification":"yes"}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.payload))
			req.Header.Set("Authorization", "Bearer ai-tok")
			req.Header.Set("Content-Type", "application/json")
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != 400 {
				t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
			}
			var body map[string]string
			_ = json.Unmarshal(rr.Body.Bytes(), &body)
			if body["error"] != "Invalid suppress_notification" {
				t.Fatalf("error: %v", body)
			}
		})
	}
}

func TestWriteEndpointsRejectBodyLargerThan256KiB(t *testing.T) {
	h := testServer().Handler()
	oversized := strings.Repeat("a", MaxBodyBytes+1)
	req := httptest.NewRequest(http.MethodPost, "/api/log/number", strings.NewReader(oversized))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 413 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["error"] != BodyTooLargeMessage {
		t.Fatalf("error: %v", body)
	}
}

func TestReadBodyAllowsExactlyMaxBodyBytes(t *testing.T) {
	pad := MaxBodyBytes - 2
	payload := "{" + strings.Repeat(" ", pad) + "}"
	if len(payload) != MaxBodyBytes {
		t.Fatalf("len=%d", len(payload))
	}
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(payload))
	raw, err := readBody(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != MaxBodyBytes {
		t.Fatalf("len=%d", len(raw))
	}
}

func TestWriteEndpointsRejectTrailingGarbageAfterJSON(t *testing.T) {
	h := testServer().Handler()
	// 合法 JSON 后跟垃圾：须 400（与 Next JSON.parse / Unmarshal 对齐；旧 Decoder 会静默忽略）
	const garbage = " xyz"
	cases := []struct {
		method, path, payload string
	}{
		{
			http.MethodPost, "/api/log/number",
			`{"happened_at":"2026-08-01T12:00:00Z","value_number":"1","tags":["weight"],"objective_context":"x"}` + garbage,
		},
		{
			http.MethodPost, "/api/log/text",
			`{"happened_at":"2026-08-01T12:00:00Z","value_text":"hi","tags":["study"],"objective_context":"x"}` + garbage,
		},
		{
			http.MethodPost, "/api/log/transaction",
			`{"happened_at":"2026-08-01T12:00:00Z","type":"expense","entries":[{"amount":"1.00","memo":"m","tags":["food"]}]}` + garbage,
		},
		{
			http.MethodPost, "/api/admin/tags/rename",
			`{"from":"a","to":"b"}` + garbage,
		},
		{
			http.MethodPatch, "/api/admin/records/01900000-0000-7000-8000-000000000001",
			`{"happened_at":"2026-08-01T12:00:00Z","value_number":"1","tags":["weight"],"objective_context":"x"}` + garbage,
		},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.payload))
		if strings.HasPrefix(tc.path, "/api/admin/") {
			req.Header.Set("Authorization", "Bearer admin-tok")
		} else {
			req.Header.Set("Authorization", "Bearer ai-tok")
		}
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("%s %s: status %d body %s", tc.method, tc.path, rr.Code, rr.Body.String())
		}
		var body map[string]string
		_ = json.Unmarshal(rr.Body.Bytes(), &body)
		if body["error"] != "Invalid JSON body" {
			t.Fatalf("%s %s: error %v", tc.method, tc.path, body)
		}
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

func TestLogNumberRejectsBodyWeightReservedTag(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/number", strings.NewReader(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"value_number": "1",
		"tags": ["body:weight"],
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
	want := `tag "body:weight" is reserved; use POST /api/log/body/weight for body weight entries`
	if body["error"] != want {
		t.Fatalf("error: %v", body)
	}
}

func TestLogBodyWeightRejectsJSONNumber(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/body/weight", strings.NewReader(`{
		"happened_at": "2026-08-02T08:00:00+08:00",
		"value_number": 75.5,
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
	if body["error"] != "value_number must be a decimal string" {
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
		{`{"from":"weight","to":"body:weight"}`, `tag "body:weight" is reserved; use POST /api/log/body/weight for body weight entries`},
		{`{"from":"body:weight","to":"mass"}`, `tag "body:weight" is reserved; use POST /api/log/body/weight for body weight entries`},
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

func TestTransactionSummaryMissingParamsWithoutDB(t *testing.T) {
	h := testServer().Handler()
	cases := []struct {
		url  string
		want string
	}{
		{"/api/query/transaction/summary", "Missing required query parameter: from"},
		{"/api/query/transaction/summary?to=2026-08-01T00:00:00Z", "Missing required query parameter: from"},
		{"/api/query/transaction/summary?from=2026-07-01T00:00:00Z", "Missing required query parameter: to"},
		{
			"/api/query/transaction/summary?from=2026-07-01T00:00:00Z&to=2026-07-01T00:00:00Z",
			"from must be earlier than to",
		},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, tc.url, nil)
		req.Header.Set("Authorization", "Bearer ai-tok")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("%s status %d body %s", tc.url, rr.Code, rr.Body.String())
		}
		var body map[string]string
		_ = json.Unmarshal(rr.Body.Bytes(), &body)
		if body["error"] != tc.want {
			t.Fatalf("%s error=%v want %q", tc.url, body, tc.want)
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

func TestQqbotProbeNotConfigured(t *testing.T) {
	s := testServer()
	s.Qqbot = &qqbot.Sender{
		Getenv: func(string) string { return "" },
	}
	h := s.Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/qqbot/probe", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if !strings.Contains(body["error"], "QQBOT_APP_ID") {
		t.Fatalf("error: %v", body)
	}
}

func TestQqbotProbeSuccess(t *testing.T) {
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":7200}`))
	}))
	defer tokenSrv.Close()
	sendSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer sendSrv.Close()

	s := testServer()
	s.Qqbot = &qqbot.Sender{
		HTTPClient: sendSrv.Client(),
		TokenURL:   tokenSrv.URL,
		APIBases:   []string{sendSrv.URL},
		Getenv: func(k string) string {
			switch k {
			case "QQBOT_APP_ID":
				return "app"
			case "QQBOT_APP_SECRET":
				return "sec"
			case "QQBOT_USER_OPENID":
				return "openid"
			}
			return ""
		},
	}
	h := s.Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/qqbot/probe", strings.NewReader(`{"text":"hi"}`))
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

func TestQqbotProbeSendFailure(t *testing.T) {
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":7200}`))
	}))
	defer tokenSrv.Close()
	failSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"invalid openid"}`))
	}))
	defer failSrv.Close()

	s := testServer()
	s.Qqbot = &qqbot.Sender{
		HTTPClient: failSrv.Client(),
		TokenURL:   tokenSrv.URL,
		APIBases:   []string{failSrv.URL},
		Getenv: func(k string) string {
			switch k {
			case "QQBOT_APP_ID":
				return "app"
			case "QQBOT_APP_SECRET":
				return "sec"
			case "QQBOT_USER_OPENID":
				return "openid"
			}
			return ""
		},
	}
	h := s.Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/qqbot/probe", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 502 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "invalid openid") {
		t.Fatalf("body: %s", rr.Body.String())
	}
}

func TestWriteJSONDoesNotHTMLEscape(t *testing.T) {
	rr := httptest.NewRecorder()
	writeError(rr, 400, "a < b & c > d")
	raw := rr.Body.String()
	if strings.Contains(raw, `\u003c`) || strings.Contains(raw, `\u003e`) || strings.Contains(raw, `\u0026`) {
		t.Fatalf("HTML-escaped: %s", raw)
	}
	if !strings.Contains(raw, `a < b & c > d`) {
		t.Fatalf("body: %s", raw)
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

