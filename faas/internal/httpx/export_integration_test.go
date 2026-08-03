package httpx_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/auth"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/httpx"
	"github.com/mdk/digitaltwin2026/faas/internal/qqbot"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
)

func TestExportRecordsIntegration(t *testing.T) {
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping Go export integration test. " + db.TestDatabaseURLHint)
	}
	if err := db.AssertSafeTestDatabaseURL(url); err != nil {
		t.Fatalf("%v", err)
	}

	ctx := context.Background()
	pool, err := db.Open(ctx)
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	defer pool.Close()

	var exists bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'records'
)`).Scan(&exists); err != nil || !exists {
		t.Skip("records table not found; run npm run db:migrate first")
	}

	marker := "go-export-" + time.Now().UTC().Format("150405.000")
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM records WHERE objective_context LIKE $1`, marker+"%")
	})

	var notified []string
	srv := httpx.NewServer(pool, auth.Tokens{AI: "ai-tok", Admin: "admin-tok"})
	srv.Telegram = &telegram.Sender{Getenv: func(string) string { return "" }}
	srv.Qqbot = &qqbot.Sender{Getenv: func(string) string { return "" }}
	srv.NotifyUser = func(text string) {
		notified = append(notified, text)
	}
	h := srv.Handler()

	// from 不存在 → 404，不 Notify
	missing := httptest.NewRequest(http.MethodGet,
		"/api/export/records?from=01900000-0000-7000-8000-000000000000&limit=10", nil)
	missing.Header.Set("Authorization", "Bearer ai-tok")
	rr404 := httptest.NewRecorder()
	h.ServeHTTP(rr404, missing)
	if rr404.Code != 404 {
		t.Fatalf("404 status %d body %s", rr404.Code, rr404.Body.String())
	}
	var errBody map[string]string
	_ = json.Unmarshal(rr404.Body.Bytes(), &errBody)
	if errBody["error"] != "export from id not found" {
		t.Fatalf("404 body %v", errBody)
	}
	if len(notified) != 0 {
		t.Fatalf("must not notify on 404: %v", notified)
	}

	var ids []string
	for _, n := range []string{"1", "2", "3"} {
		body := `{
			"happened_at":"2026-07-30T08:00:00+08:00",
			"value_number": "` + n + `",
			"tags": ["go_export"],
			"objective_context": "` + marker + `-` + n + `"
		}`
		req := httptest.NewRequest(http.MethodPost, "/api/log/number", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer ai-tok")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != 201 {
			t.Fatalf("create status %d body %s", rr.Code, rr.Body.String())
		}
		var created map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &created)
		rec := created["record"].(map[string]any)
		ids = append(ids, rec["id"].(string))
	}
	sort.Strings(ids)

	// 不依赖全表为空：从本批最小 id 起 limit=2
	notified = nil
	q := httptest.NewRequest(http.MethodGet,
		"/api/export/records?from="+ids[0]+"&limit=2", nil)
	q.Header.Set("Authorization", "Bearer ai-tok")
	qr := httptest.NewRecorder()
	h.ServeHTTP(qr, q)
	if qr.Code != 200 {
		t.Fatalf("export status %d body %s", qr.Code, qr.Body.String())
	}
	if ct := qr.Header().Get("Content-Type"); ct != "application/x-ndjson" {
		t.Fatalf("content-type %q", ct)
	}
	disp := qr.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disp, `attachment; filename="records-from-`+ids[0]+`-limit-2-`) ||
		!strings.HasSuffix(disp, `.jsonl"`) {
		t.Fatalf("disposition %q", disp)
	}
	lines := strings.Split(strings.TrimRight(qr.Body.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 lines got %d body %q", len(lines), qr.Body.String())
	}
	if len(notified) != 1 || !strings.Contains(notified[0], "Exported 2 records") {
		t.Fatalf("notify %v", notified)
	}

	var first, second map[string]any
	_ = json.Unmarshal([]byte(lines[0]), &first)
	_ = json.Unmarshal([]byte(lines[1]), &second)
	if first["id"] != ids[0] || second["id"] != ids[1] {
		t.Fatalf("page1 ids %v %v want %s %s", first["id"], second["id"], ids[0], ids[1])
	}
	if first["happened_at"] != "2026-07-30T08:00:00.000+08:00" {
		t.Fatalf("export happened_at %v", first["happened_at"])
	}
	if _, ok := first["utc_offset"]; ok {
		t.Fatal("utc_offset must not appear in export JSONL")
	}

	notified = nil
	q2 := httptest.NewRequest(http.MethodGet,
		"/api/export/records?from="+ids[1]+"&limit=2", nil)
	q2.Header.Set("Authorization", "Bearer ai-tok")
	qr2 := httptest.NewRecorder()
	h.ServeHTTP(qr2, q2)
	if qr2.Code != 200 {
		t.Fatalf("page2 status %d", qr2.Code)
	}
	lines2 := strings.Split(strings.TrimRight(qr2.Body.String(), "\n"), "\n")
	if len(lines2) < 2 {
		t.Fatalf("page2 lines %d", len(lines2))
	}
	var overlap, last map[string]any
	_ = json.Unmarshal([]byte(lines2[0]), &overlap)
	_ = json.Unmarshal([]byte(lines2[1]), &last)
	if overlap["id"] != ids[1] || last["id"] != ids[2] {
		t.Fatalf("page2 ids %v %v want %s %s", overlap["id"], last["id"], ids[1], ids[2])
	}
	if _, ok := overlap["happened_at"]; !ok {
		t.Fatal("missing happenedAt")
	}
	if _, ok := overlap["created_at"]; ok {
		t.Fatal("unexpected created_at deform")
	}
	if len(notified) != 1 {
		t.Fatalf("page2 notify %v", notified)
	}
}
