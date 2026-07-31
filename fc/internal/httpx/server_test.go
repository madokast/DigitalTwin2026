package httpx

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/fc/internal/auth"
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
		"value_number": 1,
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

func TestSummaryInvalidTZWithoutDB(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodGet, "/api/query/summary?tz=Not%2FAZone", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
}

func TestQueryBadPageWithoutDB(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodGet, "/api/query?page=0", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d", rr.Code)
	}
}
