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
		"entries": [{
			"numeric_value": "42.5",
			"tags": ["go_fc_test"],
			"memo": "` + marker + `"
		}]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/log/numbers", strings.NewReader(body))
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
	if inserted, _ := created["inserted"].(float64); inserted != 1 {
		t.Fatalf("inserted: %v body %s", created["inserted"], rr.Body.String())
	}
	if atomic, _ := created["atomic"].(bool); !atomic {
		t.Fatalf("atomic: %v", created["atomic"])
	}

	// 批量不回传 id：按 q 查回本批记录
	ids := httptest.NewRequest(http.MethodGet, "/api/query?q="+marker, nil)
	ids.Header.Set("Authorization", "Bearer ai-tok")
	idsRR := httptest.NewRecorder()
	h.ServeHTTP(idsRR, ids)
	if idsRR.Code != 200 {
		t.Fatalf("query status %d", idsRR.Code)
	}
	var idsBody map[string]any
	if err := json.Unmarshal(idsRR.Body.Bytes(), &idsBody); err != nil {
		t.Fatal(err)
	}
	recs := idsBody["records"].([]any)
	if len(recs) < 1 {
		t.Fatalf("no record found for marker %s", marker)
	}
	rec := recs[0].(map[string]any)
	if rec["id"] == nil || rec["id"] == "" {
		t.Fatalf("missing record.id in %s", idsRR.Body.String())
	}

	// 小数值（0.0001）可存可读：与记账金额不同，number 用更宽的 DecimalString
	smallBody := `{
		"happened_at":"2026-07-30T08:00:00+08:00",
		"entries": [{
			"numeric_value": "0.0001",
			"tags": ["go_small"],
			"memo": "tiny measurement"
		}]
	}`
	smallReq := httptest.NewRequest(http.MethodPost, "/api/log/numbers", strings.NewReader(smallBody))
	smallReq.Header.Set("Authorization", "Bearer ai-tok")
	smallReq.Header.Set("Content-Type", "application/json")
	smallRR := httptest.NewRecorder()
	h.ServeHTTP(smallRR, smallReq)
	if smallRR.Code != 201 {
		t.Fatalf("small create status %d body %s", smallRR.Code, smallRR.Body.String())
	}
	smallQ := httptest.NewRequest(http.MethodGet, "/api/query?tag=go_small", nil)
	smallQ.Header.Set("Authorization", "Bearer ai-tok")
	smallQR := httptest.NewRecorder()
	h.ServeHTTP(smallQR, smallQ)
	if smallQR.Code != 200 {
		t.Fatalf("small query status %d", smallQR.Code)
	}
	var smallBodyOut map[string]any
	if err := json.Unmarshal(smallQR.Body.Bytes(), &smallBodyOut); err != nil {
		t.Fatal(err)
	}
	smallRecs := smallBodyOut["records"].([]any)
	if len(smallRecs) != 1 {
		t.Fatalf("small records: %v", smallBodyOut["count"])
	}
	smallRec := smallRecs[0].(map[string]any)
	if smallRec["numeric_value"] != "0.0001" {
		t.Fatalf("small numeric_value: %v", smallRec["numeric_value"])
	}

	q := httptest.NewRequest(http.MethodGet, "/api/query?q="+marker, nil)
	q.Header.Set("Authorization", "Bearer ai-tok")
	qr := httptest.NewRecorder()
	h.ServeHTTP(qr, q)
	if qr.Code != 200 {
		t.Fatalf("query status %d", qr.Code)
	}

	// tag 族通配：创建 review 族记录后用 tag=review:* 命中
	reviewBody := `{
		"happened_at":"2026-08-09T19:00:00+08:00",
		"cadence":"weekly",
		"raw_content":"integration weekly review",
		"objective_context":"` + marker + `"
	}`
	rv := httptest.NewRequest(http.MethodPost, "/api/log/review", strings.NewReader(reviewBody))
	rv.Header.Set("Authorization", "Bearer ai-tok")
	rv.Header.Set("Content-Type", "application/json")
	rvr := httptest.NewRecorder()
	h.ServeHTTP(rvr, rv)
	if rvr.Code != 201 {
		t.Fatalf("review status %d body %s", rvr.Code, rvr.Body.String())
	}

	wq := httptest.NewRequest(http.MethodGet, "/api/query?tag=review:*&q="+marker, nil)
	wq.Header.Set("Authorization", "Bearer ai-tok")
	wqr := httptest.NewRecorder()
	h.ServeHTTP(wqr, wq)
	if wqr.Code != 200 {
		t.Fatalf("wildcard query status %d body %s", wqr.Code, wqr.Body.String())
	}
	var wqBody map[string]any
	if err := json.Unmarshal(wqr.Body.Bytes(), &wqBody); err != nil {
		t.Fatal(err)
	}
	if n, _ := wqBody["count"].(float64); n < 1 {
		t.Fatalf("wildcard review:* should match review rows, count=%v body=%s", wqBody["count"], wqr.Body.String())
	}

	// 族 vs 真前缀语义边界：tag=body:* 命中 body:weight，不命中 bodyguard
	guardBody := `{
		"happened_at":"2026-08-02T08:00:00+08:00",
		"raw_content": "guard",
		"objective_context": "` + marker + `-bodyguard"
	}`
	gb := httptest.NewRequest(http.MethodPost, "/api/log/text", strings.NewReader(guardBody))
	gb.Header.Set("Authorization", "Bearer ai-tok")
	gb.Header.Set("Content-Type", "application/json")
	gbr := httptest.NewRecorder()
	h.ServeHTTP(gbr, gb)
	if gbr.Code != 201 {
		t.Fatalf("text create status %d body %s", gbr.Code, gbr.Body.String())
	}

	bwBody := `{
		"happened_at":"2026-08-02T08:00:00+08:00",
		"numeric_value": "75.5",
		"objective_context": "` + marker + `-bodyweight"
	}`
	bw := httptest.NewRequest(http.MethodPost, "/api/log/body/weight", strings.NewReader(bwBody))
	bw.Header.Set("Authorization", "Bearer ai-tok")
	bw.Header.Set("Content-Type", "application/json")
	bwr := httptest.NewRecorder()
	h.ServeHTTP(bwr, bw)
	if bwr.Code != 201 {
		t.Fatalf("body weight status %d body %s", bwr.Code, bwr.Body.String())
	}

	fq := httptest.NewRequest(http.MethodGet, "/api/query?tag=body:*&q="+marker, nil)
	fq.Header.Set("Authorization", "Bearer ai-tok")
	fqr := httptest.NewRecorder()
	h.ServeHTTP(fqr, fq)
	if fqr.Code != 200 {
		t.Fatalf("family query status %d body %s", fqr.Code, fqr.Body.String())
	}
	var fqBody map[string]any
	if err := json.Unmarshal(fqr.Body.Bytes(), &fqBody); err != nil {
		t.Fatal(err)
	}
	rows, _ := fqBody["records"].([]any)
	for _, r := range rows {
		obj, _ := r.(map[string]any)["objective_context"].(string)
		if strings.Contains(obj, "-bodyguard") {
			t.Fatalf("body:* must not match bodyguard, got %s", fqr.Body.String())
		}
	}
	if !strings.Contains(fqr.Body.String(), "-bodyweight") {
		t.Fatalf("body:* should match body:weight, got %s", fqr.Body.String())
	}

	// 裸保留前缀 → 200 + hint（恒空毒化交集）
	hq := httptest.NewRequest(http.MethodGet, "/api/query?tag=review", nil)
	hq.Header.Set("Authorization", "Bearer ai-tok")
	hqr := httptest.NewRecorder()
	h.ServeHTTP(hqr, hq)
	if hqr.Code != 200 {
		t.Fatalf("bare reserved status %d body %s", hqr.Code, hqr.Body.String())
	}
	var hqBody map[string]any
	if err := json.Unmarshal(hqr.Body.Bytes(), &hqBody); err != nil {
		t.Fatal(err)
	}
	if hint, _ := hqBody["hint"].(string); hint == "" {
		t.Fatalf("bare reserved review must include hint, body=%s", hqr.Body.String())
	}
	if n, _ := hqBody["count"].(float64); n != 0 {
		t.Fatalf("bare reserved review count must be 0, got %v", n)
	}
}
