package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/auth"
	"github.com/mdk/digitaltwin2026/faas/internal/importapi"
	"github.com/mdk/digitaltwin2026/faas/internal/qqbot"
	"github.com/mdk/digitaltwin2026/faas/internal/query"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
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
	assertProblemDetail(t, rr, auth.UnauthorizedMessage)
	if rr.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("401 content-type %q", rr.Header().Get("Content-Type"))
	}
	body := parseProblem(t, rr)
	if body["title"] != "Unauthorized" || body["status"] != float64(401) || body["success"] != false {
		t.Fatalf("401 problem+json shape %v", body)
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
	if rr404.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("404 content-type %q", rr404.Header().Get("Content-Type"))
	}
	var body404 map[string]any
	_ = json.Unmarshal(rr404.Body.Bytes(), &body404)
	if body404["detail"] != "unknown path: /api/no-such-route" {
		t.Fatalf("404 body %v", body404)
	}
	if body404["title"] != "Not Found" || body404["status"] != float64(404) || body404["success"] != false {
		t.Fatalf("404 problem+json shape %v", body404)
	}

	req405 := httptest.NewRequest(http.MethodGet, "/api/log/numbers", nil)
	req405.Header.Set("Authorization", "Bearer ai-tok")
	rr405 := httptest.NewRecorder()
	h.ServeHTTP(rr405, req405)
	if rr405.Code != 405 {
		t.Fatalf("405 status %d body %s", rr405.Code, rr405.Body.String())
	}
	var body405 map[string]any
	_ = json.Unmarshal(rr405.Body.Bytes(), &body405)
	if body405["detail"] != "method not allowed: GET /api/log/numbers" {
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
	req := httptest.NewRequest(http.MethodPost, "/api/log/numbers", strings.NewReader(`{
		"entries": [{"numeric_value": "1", "memo": "x"}]
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	assertProblemDetailContains(t, rr, "happened_at")
}

func TestLogRejectsSuppressNotificationAsUnknownKeyWithoutDB(t *testing.T) {
	h := testServer().Handler()
	cases := []struct {
		path, payload string
	}{
		{
			"/api/log/numbers",
			`{"happened_at":"2026-08-01T12:00:00Z","entries":[{"numeric_value":"1","memo":"x"}],"suppress_notification":true}`,
		},
		{
			"/api/log/text",
			`{"happened_at":"2026-08-01T12:00:00Z","raw_content":"hi","tags":["study"],"objective_context":"x","suppress_notification":true}`,
		},
		{
			"/api/log/transactions",
			`{"happened_at":"2026-08-01T12:00:00Z","type":"expense","entries":[{"amount":"1.00","memo":"m","category":"food","subcategory":"lunch"}],"suppress_notification":true}`,
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
			assertProblemDetail(t, rr, "Unknown JSON key: suppress_notification")
		})
	}
}

func TestWriteEndpointsRejectBodyLargerThan256KiB(t *testing.T) {
	h := testServer().Handler()
	oversized := strings.Repeat("a", MaxBodyBytes+1)
	req := httptest.NewRequest(http.MethodPost, "/api/log/numbers", strings.NewReader(oversized))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 413 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	assertProblemDetail(t, rr, BodyTooLargeMessage)
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
			http.MethodPost, "/api/log/numbers",
			`{"happened_at":"2026-08-01T12:00:00Z","entries":[{"numeric_value":"1","memo":"x"}]}` + garbage,
		},
		{
			http.MethodPost, "/api/log/text",
			`{"happened_at":"2026-08-01T12:00:00Z","raw_content":"hi","tags":["study"],"objective_context":"x"}` + garbage,
		},
		{
			http.MethodPost, "/api/log/transactions",
			`{"happened_at":"2026-08-01T12:00:00Z","type":"expense","entries":[{"amount":"1.00","memo":"m","tags":["food"]}]}` + garbage,
		},
		{
			http.MethodPost, "/api/admin/tags/rename",
			`{"from":"a","to":"b"}` + garbage,
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
		assertProblemDetail(t, rr, "invalid JSON body")
	}
}

func TestWriteEndpointsRejectNonObjectJSON(t *testing.T) {
	h := testServer().Handler()
	// 顶层 null / 数组 / 字面量：须 400 BODY_MUST_BE_OBJECT（与 Next readJsonBody 对齐）
	// 空 body / 语法错误仍为 Invalid JSON body（见 TestWriteEndpointsRejectTrailingGarbageAfterJSON 等）
	for _, payload := range []string{`null`, `[]`, `"x"`, `123`, `true`} {
		cases := []struct {
			method, path string
		}{
			{http.MethodPost, "/api/log/numbers"},
			{http.MethodPost, "/api/log/text"},
			{http.MethodPost, "/api/log/transactions"},
			{http.MethodPost, "/api/admin/tags/rename"},
		}
		for _, tc := range cases {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(payload))
			if strings.HasPrefix(tc.path, "/api/admin/") {
				req.Header.Set("Authorization", "Bearer admin-tok")
			} else {
				req.Header.Set("Authorization", "Bearer ai-tok")
			}
			req.Header.Set("Content-Type", "application/json")
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != 400 {
				t.Fatalf("%s %s body=%s: status %d", tc.method, tc.path, payload, rr.Code)
			}
			assertProblemDetail(t, rr, "request body must be a JSON object")
		}
	}
}

func TestImportRecordsRejectsMissingOrMalformedBoundary(t *testing.T) {
	h := testServer().Handler()
	for _, ct := range []string{
		"multipart/form-data",            // 缺 boundary
		"multipart/form-data; boundary=", // 空 boundary
		`multipart/form-data; boundary="unterminated`, // 引号不闭合 → ParseMediaType 报错
		"application/json",               // 非 multipart
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", strings.NewReader("x"))
		req.Header.Set("Authorization", "Bearer admin-tok")
		req.Header.Set("Content-Type", ct)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("Content-Type %q: status %d body %s", ct, rr.Code, rr.Body.String())
		}
		assertProblemDetail(t, rr, importapi.ErrMultipartContentType.Error())
	}
}

func TestLogNumberRejectsMissingTimezone(t *testing.T) {
	h := testServer().Handler()
	for _, happened := range []string{"2026-07-30", "2026-07-30T08:00:00"} {
		payload := fmt.Sprintf(`{
			"happened_at": %q,
			"entries": [{"numeric_value": "1", "memo": "x"}]
		}`, happened)
		req := httptest.NewRequest(http.MethodPost, "/api/log/numbers", strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer ai-tok")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("%q status %d body %s", happened, rr.Code, rr.Body.String())
		}
		var body map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &body)
		want := "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)"
		if body["detail"] != want {
			t.Fatalf("%q error: %v", happened, body)
		}
	}
}

func TestLogTextRejectsMissingTimezone(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/text", strings.NewReader(`{
		"happened_at": "2026-07-30T10:00:00",
		"raw_content": "hello",
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
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	want := "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)"
	if body["detail"] != want {
		t.Fatalf("error: %v", body)
	}
}

func TestLogTextRejectsReservedTag(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/text", strings.NewReader(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"raw_content": "should fail",
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
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	want := `tag "transaction_entry" is reserved; use the dedicated log API for this record type`
	if body["detail"] != want {
		t.Fatalf("error: %v", body)
	}
}

func TestLogTextRejectsReviewReservedTag(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/text", strings.NewReader(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"raw_content": "should fail",
		"tags": ["review:weekly"],
		"objective_context": "x"
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	want := `tag "review:weekly" is reserved; use the dedicated log API for this record type`
	if body["detail"] != want {
		t.Fatalf("error: %v", body)
	}
}

func TestLogReviewRejectsMissingCadence(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/review", strings.NewReader(`{
		"happened_at": "2026-08-09T19:00:00+08:00",
		"raw_content": "x",
		"objective_context": "ctx"
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	assertProblemDetail(t, rr, "missing required field: cadence")
}

func TestLogReviewRejectsInvalidCadence(t *testing.T) {
	h := testServer().Handler()
	for _, cadence := range []string{"WEEKLY", " weekly", "weekly2"} {
		req := httptest.NewRequest(http.MethodPost, "/api/log/review", strings.NewReader(`{
			"happened_at": "2026-08-09T19:00:00+08:00",
			"cadence": "`+cadence+`",
			"raw_content": "x",
			"objective_context": "ctx"
		}`))
		req.Header.Set("Authorization", "Bearer ai-tok")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("%q: status %d body %s", cadence, rr.Code, rr.Body.String())
		}
		assertProblemDetail(t, rr, "invalid cadence: must be one of daily, weekly, monthly, quarterly, semiannually, yearly")
	}
}

func TestLogReviewRejectsReservedTag(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/review", strings.NewReader(`{
		"happened_at": "2026-08-09T19:00:00+08:00",
		"cadence": "weekly",
		"raw_content": "x",
		"objective_context": "ctx",
		"tags": ["review:weekly"]
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	want := `tag "review:weekly" is reserved; use the dedicated log API for this record type`
	if body["detail"] != want {
		t.Fatalf("error: %v", body)
	}
}

func TestLogReviewRejectsUnknownKey(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/review", strings.NewReader(`{
		"happened_at": "2026-08-09T19:00:00+08:00",
		"cadence": "weekly",
		"raw_content": "x",
		"objective_context": "ctx",
		"numeric_value": "1"
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	assertProblemDetail(t, rr, "Unknown JSON key: numeric_value")
}

func TestLogReviewRejectsBlankRawContent(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/review", strings.NewReader(`{
		"happened_at": "2026-08-09T19:00:00+08:00",
		"cadence": "weekly",
		"raw_content": "   ",
		"objective_context": "ctx"
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	assertProblemDetail(t, rr, "raw_content must not be blank")
}

func TestLogNumberRejectsWhitespacePaddedTag(t *testing.T) {
	h := testServer().Handler()
	for _, bad := range []string{" weight", "weight ", " weight ", "体重"} {
		req := httptest.NewRequest(http.MethodPost, "/api/log/numbers", strings.NewReader(`{
			"happened_at": "2026-08-01T12:30:00+08:00",
			"entries": [{"numeric_value": "1", "memo": "x", "tags": ["`+bad+`"]}]
		}`))
		req.Header.Set("Authorization", "Bearer ai-tok")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("%q: status %d body %s", bad, rr.Code, rr.Body.String())
		}
		assertProblemDetailContains(t, rr, "invalid tag")
	}
}

func TestLogNumberRejectsBodyWeightReservedTag(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/numbers", strings.NewReader(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"entries": [{"numeric_value": "1", "memo": "x", "tags": ["body:weight"]}]
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	want := `entries[0]: tag "body:weight" is reserved; use the dedicated log API for this record type`
	if body["detail"] != want {
		t.Fatalf("error: %v", body)
	}
}

func TestLogNumberRejectsTodoReservedTag(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/numbers", strings.NewReader(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"entries": [{"numeric_value": "1", "memo": "x", "tags": ["todo:in_progress"]}]
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	want := `entries[0]: tag "todo:in_progress" is reserved; use the dedicated log API for this record type`
	if body["detail"] != want {
		t.Fatalf("error: %v", body)
	}
}

func TestLogBodyWeightRejectsJSONNumber(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/log/body/weight", strings.NewReader(`{
		"happened_at": "2026-08-02T08:00:00+08:00",
		"numeric_value": 75.5,
		"objective_context": "x"
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	assertProblemDetail(t, rr, "numeric_value must be a decimal string")
}

func TestRenameTagsRejectsReservedTag(t *testing.T) {
	h := testServer().Handler()
	for _, tc := range []struct {
		payload string
		want    string
	}{
		{`{"from":"transaction_entry","to":"legacy_tx"}`, `tag "transaction_entry" is reserved; use the dedicated log API for this record type`},
		{`{"from":"food","to":"transaction_entry"}`, `tag "transaction_entry" is reserved; use the dedicated log API for this record type`},
		{`{"from":"transaction_entry:income","to":"legacy_tx"}`, `tag "transaction_entry:income" is reserved; use the dedicated log API for this record type`},
		{`{"from":"weight","to":"body:weight"}`, `tag "body:weight" is reserved; use the dedicated log API for this record type`},
		{`{"from":"body:weight","to":"mass"}`, `tag "body:weight" is reserved; use the dedicated log API for this record type`},
		{`{"from":"todo","to":"errand"}`, `tag "todo" is reserved; use the dedicated log API for this record type`},
		{`{"from":"errand","to":"todo:in_progress"}`, `tag "todo:in_progress" is reserved; use the dedicated log API for this record type`},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/admin/tags/rename", strings.NewReader(tc.payload))
		req.Header.Set("Authorization", "Bearer admin-tok")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("%s status %d body %s", tc.payload, rr.Code, rr.Body.String())
		}
		assertProblemDetail(t, rr, tc.want)
	}
}

func TestSummaryInvalidTZWithoutDB(t *testing.T) {
	h := testServer().Handler()
	// 该路由属 /api/admin/*：AI token 必须 401，仅 AdminToken 可达
	aiReq := httptest.NewRequest(http.MethodGet, "/api/admin/records/stats?tz=UTC", nil)
	aiReq.Header.Set("Authorization", "Bearer ai-tok")
	aiRR := httptest.NewRecorder()
	h.ServeHTTP(aiRR, aiReq)
	if aiRR.Code != 401 {
		t.Fatalf("ai-tok status %d body %s", aiRR.Code, aiRR.Body.String())
	}
	for _, tz := range []string{"Not%2FAZone", "Factory", "localtime"} {
		req := httptest.NewRequest(http.MethodGet, "/api/admin/records/stats?tz="+tz, nil)
		req.Header.Set("Authorization", "Bearer admin-tok")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Fatalf("tz=%s status %d body %s", tz, rr.Code, rr.Body.String())
		}
		assertProblemDetail(t, rr, "query parameter tz must be a valid IANA time zone")
	}
}

func TestTagQueryWildcardAndHintWithoutDB(t *testing.T) {
	h := testServer().Handler()
	do := func(url string) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", "Bearer ai-tok")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		var body map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &body)
		return rr.Code, body
	}

	// 非法通配 → 400 统一文案
	for _, url := range []string{
		"/api/query?tag=*",
		"/api/query?tag=re*view",
		"/api/query?tag=work*",
		"/api/query?tag=re*vi*",
		"/api/query?tag=review:*:x",
	} {
		code, body := do(url)
		if code != 400 {
			t.Fatalf("%s status %d body %v", url, code, body)
		}
		errMsg, _ := body["detail"].(string)
		if !strings.Contains(errMsg, "invalid tag query") {
			t.Fatalf("%s error=%v", url, body["detail"])
		}
	}
	// hint 行为依赖 DB（恒空交集），在 integration_test.go 有库场景断言；
	// 无 DB 下合法查询会走 FetchFilteredRecords（nil Pool panic），此处不测。
}

func TestTimeEndpointWithoutDB(t *testing.T) {
	s := testServer()
	fixed := time.UnixMilli(1785429045123).UTC()
	s.Now = func() time.Time { return fixed }
	h := s.Handler()

	do := func(url string) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", "Bearer ai-tok")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		var body map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &body)
		return rr.Code, body
	}

	// 缺省 → UTC；显式 UTC；零偏移非 UTC 区 → Z
	code, body := do("/api/time")
	if code != 200 || body["now"] != "2026-07-30T16:30:45.123Z" || body["tz"] != "UTC" {
		t.Fatalf("default: code=%d body=%v", code, body)
	}
	code, body = do("/api/time?tz=Asia/Shanghai")
	if code != 200 || body["now"] != "2026-07-31T00:30:45.123+08:00" || body["tz"] != "Asia/Shanghai" {
		t.Fatalf("shanghai: code=%d body=%v", code, body)
	}
	code, body = do("/api/time?tz=Africa/Abidjan")
	if code != 200 || body["now"] != "2026-07-30T16:30:45.123Z" || body["tz"] != "Africa/Abidjan" {
		t.Fatalf("abidjan: code=%d body=%v", code, body)
	}

	// 空串 tz → 400；非法 tz → 400
	for _, url := range []string{"/api/time?tz=", "/api/time?tz=Not%2FAZone"} {
		code, body = do(url)
		if code != 400 {
			t.Fatalf("%s status %d body %v", url, code, body)
		}
		if body["detail"] != "query parameter tz must be a valid IANA time zone" {
			t.Fatalf("%s error=%v", url, body)
		}
	}
}

func TestTransactionsSummaryMissingParamsWithoutDB(t *testing.T) {
	h := testServer().Handler()
	cases := []struct {
		url  string
		want string
	}{
		{"/api/query/transactions/summary", "missing required query parameter: from"},
		{"/api/query/transactions/summary?to=2026-08-01T00:00:00Z", "missing required query parameter: from"},
		{"/api/query/transactions/summary?from=2026-07-01T00:00:00Z", "missing required query parameter: to"},
		{
			"/api/query/transactions/summary?from=2026-07-01T00:00:00Z&to=2026-07-01T00:00:00Z",
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
		assertProblemDetail(t, rr, tc.want)
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
	assertProblemDetailContains(t, rr, "TELEGRAM_BOT_TOKEN")
}

func TestTelegramProbeMalformedJSON(t *testing.T) {
	var botCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		botCalls.Add(1)
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
	req := httptest.NewRequest(http.MethodPost, "/api/telegram/probe", strings.NewReader(`{broken`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	assertProblemDetail(t, rr, "invalid JSON body")
	if botCalls.Load() != 0 {
		t.Fatalf("bot API called %d times; malformed JSON must not send", botCalls.Load())
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
	assertProblemDetailContains(t, rr, "QQBOT_APP_ID")
}

func TestQqbotProbeMalformedJSON(t *testing.T) {
	var tokenCalls atomic.Int32
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokenCalls.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":7200}`))
	}))
	defer tokenSrv.Close()
	var sendCalls atomic.Int32
	sendSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sendCalls.Add(1)
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
	req := httptest.NewRequest(http.MethodPost, "/api/qqbot/probe", strings.NewReader(`{broken`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	assertProblemDetail(t, rr, "invalid JSON body")
	if tokenCalls.Load() != 0 || sendCalls.Load() != 0 {
		t.Fatalf("QQ API called (token %d / send %d); malformed JSON must not send",
			tokenCalls.Load(), sendCalls.Load())
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

func TestDbProbeMissingDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodPost, "/api/db/probe", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 503 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	assertProblemDetail(t, rr, "DATABASE_URL is not set")
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
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["detail"] != "Internal server error" {
		t.Fatalf("leaked internal detail: %q", body["detail"])
	}
}
