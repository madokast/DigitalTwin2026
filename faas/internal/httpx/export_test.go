package httpx

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExportRecordsValidation(t *testing.T) {
	h := testServer().Handler()

	missing := httptest.NewRequest(http.MethodGet, "/api/export/records", nil)
	missing.Header.Set("Authorization", "Bearer ai-tok")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, missing)
	if rr.Code != 400 {
		t.Fatalf("missing limit status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["error"] != "limit must be an integer between 1 and 1000" {
		t.Fatalf("body %v", body)
	}

	badFrom := httptest.NewRequest(http.MethodGet, "/api/export/records?from=not-a-uuid&limit=10", nil)
	badFrom.Header.Set("Authorization", "Bearer ai-tok")
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, badFrom)
	if rr2.Code != 400 {
		t.Fatalf("bad from status %d", rr2.Code)
	}
	var body2 map[string]string
	_ = json.Unmarshal(rr2.Body.Bytes(), &body2)
	if body2["error"] != "Invalid record id" {
		t.Fatalf("body %v", body2)
	}
}

func TestExportRecordsAuthRequired(t *testing.T) {
	h := testServer().Handler()
	req := httptest.NewRequest(http.MethodGet, "/api/export/records?limit=1", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 401 {
		t.Fatalf("status %d", rr.Code)
	}
}

func TestExportRecordsNotifyOnEmptySuccess(t *testing.T) {
	// 无 DB：用校验失败路径确认失败不 Notify；成功路径见集成测。
	// 此处用注入 NotifyUser + 校验错误对照。
	var notified []string
	srv := testServer()
	srv.NotifyUser = func(text string) {
		notified = append(notified, text)
	}
	h := srv.Handler()
	req := httptest.NewRequest(http.MethodGet, "/api/export/records?limit=0", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d", rr.Code)
	}
	if len(notified) != 0 {
		t.Fatalf("must not notify on validation error: %v", notified)
	}
}
