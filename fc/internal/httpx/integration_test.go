package httpx_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/fc/internal/auth"
	"github.com/mdk/digitaltwin2026/fc/internal/db"
	"github.com/mdk/digitaltwin2026/fc/internal/httpx"
	"github.com/mdk/digitaltwin2026/fc/internal/telegram"
)

func TestIntegrationSmoke(t *testing.T) {
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("DATABASE_URL not set; skipping Go API integration test")
	}

	ctx := context.Background()
	pool, err := db.Open(ctx)
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	defer pool.Close()

	// Ensure table exists (shared with Node migrations); skip if missing.
	var exists bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'records'
)`).Scan(&exists); err != nil || !exists {
		t.Skip("records table not found; run npm run db:migrate first")
	}

	srv := httpx.NewServer(pool, auth.Tokens{AI: "ai-tok", Admin: "admin-tok"})
	// 集成测不打扰真实 Telegram
	srv.Telegram = &telegram.Sender{Getenv: func(string) string { return "" }}
	h := srv.Handler()

	marker := "go-fc-integration-" + time.Now().UTC().Format("150405.000")
	body := `{
		"happened_at":"2026-07-30T08:00:00+08:00",
		"value_number": "42.5",
		"tags": ["go_fc_test"],
		"objective_context": "` + marker + `"
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
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	rec := created["record"].(map[string]any)
	id := rec["id"].(string)

	q := httptest.NewRequest(http.MethodGet, "/api/query?q="+marker, nil)
	q.Header.Set("Authorization", "Bearer ai-tok")
	qr := httptest.NewRecorder()
	h.ServeHTTP(qr, q)
	if qr.Code != 200 {
		t.Fatalf("query status %d", qr.Code)
	}

	// cleanup
	_, _ = pool.Exec(ctx, `DELETE FROM records WHERE id = $1`, id)
}
