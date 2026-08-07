package httpx_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/qqbot"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
)

func TestTagsEditIntegration(t *testing.T) {
	url := db.TestDatabaseURL(t)
	t.Setenv("DATABASE_URL", url)

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

	const id = "01900000-0000-7000-8000-0000000000d1"
	marker := "go-tags-" + time.Now().UTC().Format("150405.000")
	if _, err := pool.Exec(ctx, `
INSERT INTO records (id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags)
VALUES ($1, now(), '+00:00', '1', NULL, $2, NULL, '["exercise"]')
`, id, marker); err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM records WHERE objective_context LIKE $1`, marker+"%")
		_, _ = pool.Exec(ctx, `DELETE FROM records WHERE id = $1`, id)
	})

	var notified []string
	srv := newRealServer(pool)
	srv.Telegram = &telegram.Sender{Getenv: func(string) string { return "" }}
	srv.Qqbot = &qqbot.Sender{Getenv: func(string) string { return "" }}
	srv.Notifier = &spyNotifier{texts: &notified}
	h := srv.Handler()

	post := func(path, body string) (*httptest.ResponseRecorder, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin-tok")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		var got map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &got)
		return rr, got
	}

	// add → changed:true + notify（含 action: add）
	srv.Notifier.(*spyNotifier).reset()
	rr, got := post("/api/log/tags/add", `{"id":"`+id+`","tag":"workout:arm"}`)
	if rr.Code != 200 || got["changed"] != true {
		t.Fatalf("add status=%d body=%s", rr.Code, rr.Body.String())
	}
	texts := srv.Notifier.(*spyNotifier).waitTexts(1)
	if len(texts) != 1 || !strings.Contains(texts[0], "action: add") ||
		!strings.Contains(texts[0], "tag: workout:arm") {
		t.Fatalf("add notify %v", texts)
	}

	// add 同 tag → changed:false，不通知（异步竞态：等待后计数不变）
	rr, got = post("/api/log/tags/add", `{"id":"`+id+`","tag":"workout:arm"}`)
	if rr.Code != 200 || got["changed"] != false {
		t.Fatalf("dup add status=%d body=%s", rr.Code, rr.Body.String())
	}
	time.Sleep(100 * time.Millisecond)
	if len(notified) != 1 {
		t.Fatalf("dup add must not notify: %v", notified)
	}

	// remove → changed:true，notify action: remove
	rr, got = post("/api/log/tags/remove", `{"id":"`+id+`","tag":"workout:arm"}`)
	if rr.Code != 200 || got["changed"] != true {
		t.Fatalf("remove status=%d body=%s", rr.Code, rr.Body.String())
	}
	texts = srv.Notifier.(*spyNotifier).waitTexts(2)
	if len(texts) != 2 || !strings.Contains(texts[1], "action: remove") {
		t.Fatalf("remove notify %v", texts)
	}

	// remove 同 tag → changed:false 且 DB 回落到 ["exercise"]
	rr, got = post("/api/log/tags/remove", `{"id":"`+id+`","tag":"workout:arm"}`)
	if rr.Code != 200 || got["changed"] != false {
		t.Fatalf("dup remove status=%d body=%s", rr.Code, rr.Body.String())
	}
	time.Sleep(100 * time.Millisecond)
	if len(notified) != 2 {
		t.Fatalf("dup remove must not notify: %v", notified)
	}
	var tags string
	_ = pool.QueryRow(ctx, `SELECT tags FROM records WHERE id = $1`, id).Scan(&tags)
	if tags != `["exercise"]` {
		t.Fatalf("final tags %s", tags)
	}

	// 404：不存在的 id（任意普通 id 即可）
	missing := "01900000-0000-7000-8000-0000000000d2"
	rr, got = post("/api/log/tags/add", `{"id":"`+missing+`","tag":"t"}`)
	if rr.Code != 404 || got["detail"] != "record "+missing+" not found" {
		t.Fatalf("404 status=%d body=%s", rr.Code, rr.Body.String())
	}
}
