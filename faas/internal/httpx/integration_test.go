package httpx_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/auth"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/httpx"
	"github.com/mdk/digitaltwin2026/faas/internal/qqbot"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
)

func TestIntegrationSmoke(t *testing.T) {
	url := db.TestDatabaseURL(t)
	// db.Open 内部读 env DATABASE_URL；.env.test 自动加载只作用于门闸，须显式注入
	t.Setenv("DATABASE_URL", url)

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
	// 集成测不打扰真实通知渠道（SUPPRESS_BOT_NOTIFICATION=1 也会跳过；双保险）
	srv.Telegram = &telegram.Sender{Getenv: func(string) string { return "" }}
	srv.Qqbot = &qqbot.Sender{Getenv: func(string) string { return "" }}
	h := srv.Handler()

	marker := "go-fc-integration-" + time.Now().UTC().Format("150405.000")
	// 须在断言之前注册：t.Fatalf 会跳过函数末尾 cleanup，残留测试行
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM records WHERE objective_context = $1`, marker)
	})

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
	rec, _ := created["record"].(map[string]any)
	if rec == nil || rec["id"] == nil || rec["id"] == "" {
		t.Fatalf("missing record.id in %s", rr.Body.String())
	}

	q := httptest.NewRequest(http.MethodGet, "/api/query?q="+marker, nil)
	q.Header.Set("Authorization", "Bearer ai-tok")
	qr := httptest.NewRecorder()
	h.ServeHTTP(qr, q)
	if qr.Code != 200 {
		t.Fatalf("query status %d", qr.Code)
	}
}
