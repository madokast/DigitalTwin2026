package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/exportapi"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
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
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["detail"] != "limit must be an integer between 1 and 1000" {
		t.Fatalf("body %v", body)
	}

	badFrom := httptest.NewRequest(http.MethodGet, "/api/export/records?from=not-a-uuid&limit=10", nil)
	badFrom.Header.Set("Authorization", "Bearer ai-tok")
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, badFrom)
	if rr2.Code != 400 {
		t.Fatalf("bad from status %d", rr2.Code)
	}
	var body2 map[string]any
	_ = json.Unmarshal(rr2.Body.Bytes(), &body2)
	if body2["detail"] != "invalid record id" {
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

func TestExportRecordsNoNotifyWhenWriteFails(t *testing.T) {
	var notified []string
	srv := testServer()
	srv.FetchExportRecords = func(_ context.Context, _ *pgxpool.Pool, _ *exportapi.ParsedExport) ([]record.Record, int, error) {
		return []record.Record{}, 200, nil
	}
	srv.NotifyUser = func(text string) {
		notified = append(notified, text)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/export/records?limit=1", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	fw := &failingExportWriter{header: make(http.Header)}
	srv.handleExportRecords(fw, req)

	if len(notified) != 0 {
		t.Fatalf("must not notify when Write fails: %v", notified)
	}
	if !fw.writeAttempted {
		t.Fatal("expected Write to be attempted")
	}
}

// failingExportWriter：Header/WriteHeader 正常，Write 恒失败（测 §4.5）。
type failingExportWriter struct {
	header         http.Header
	code           int
	writeAttempted bool
}

func (f *failingExportWriter) Header() http.Header {
	if f.header == nil {
		f.header = make(http.Header)
	}
	return f.header
}

func (f *failingExportWriter) WriteHeader(statusCode int) {
	f.code = statusCode
}

func (f *failingExportWriter) Write(b []byte) (int, error) {
	f.writeAttempted = true
	return 0, errors.New("simulated write failure")
}
