package httpx_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/auth"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/httpx"
	"github.com/mdk/digitaltwin2026/faas/internal/qqbot"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
)

func buildImportMultipartBytes(t *testing.T, filename, contentType, content string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename))
	if contentType != "" {
		h.Set("Content-Type", contentType)
	}
	part, err := w.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, w.FormDataContentType()
}

func TestImportRecordsIntegration(t *testing.T) {
	url := db.TestDatabaseURL(t)
	// db.Open 内部读 env DATABASE_URL；.env.test 自动加载只作用于门闸，须显式注入
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

	marker := "go-import-" + time.Now().UTC().Format("150405.000")
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM records WHERE objective_context LIKE $1`, marker+"%")
		_, _ = pool.Exec(ctx, `DELETE FROM records WHERE id = $1 OR id = $2`,
			"01900000-0000-7000-8000-0000000000c1",
			"01900000-0000-7000-8000-0000000000c2",
		)
	})

	var notified []string
	srv := httpx.NewServer(pool, auth.Tokens{AI: "ai-tok", Admin: "admin-tok"})
	srv.Telegram = &telegram.Sender{Getenv: func(string) string { return "" }}
	srv.Qqbot = &qqbot.Sender{Getenv: func(string) string { return "" }}
	srv.NotifyUser = func(text string) {
		notified = append(notified, text)
	}
	h := srv.Handler()

	// empty → 0 + Notify
	notified = nil
	emptyBody, emptyCT := buildImportMultipartBytes(t, "records.jsonl", "application/x-ndjson", "")
	emptyReq := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", emptyBody)
	emptyReq.Header.Set("Authorization", "Bearer admin-tok")
	emptyReq.Header.Set("Content-Type", emptyCT)
	emptyRR := httptest.NewRecorder()
	h.ServeHTTP(emptyRR, emptyReq)
	if emptyRR.Code != 200 {
		t.Fatalf("empty status %d body %s", emptyRR.Code, emptyRR.Body.String())
	}
	var emptyOK map[string]any
	_ = json.Unmarshal(emptyRR.Body.Bytes(), &emptyOK)
	if emptyOK["inserted"] != float64(0) || emptyOK["total"] != float64(0) {
		t.Fatalf("empty body %v", emptyOK)
	}
	if len(notified) != 1 || !strings.Contains(notified[0], "Imported 0 records") {
		t.Fatalf("empty notify %v", notified)
	}

	id1 := "01900000-0000-7000-8000-0000000000c1"
	line1 := fmt.Sprintf(`{"id":%q,"happened_at":"2026-07-30T00:00:00.000Z","numeric_value":"1","raw_content":null,"tags":"[\"weight\"]","objective_context":%q,"ai_analysis":null}`, id1, marker+"-1")

	// duplicate → 400, no notify, no row
	notified = nil
	dupBody, dupCT := buildImportMultipartBytes(t, "records.jsonl", "application/x-ndjson", line1+"\n"+line1)
	dupReq := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", dupBody)
	dupReq.Header.Set("Authorization", "Bearer admin-tok")
	dupReq.Header.Set("Content-Type", dupCT)
	dupRR := httptest.NewRecorder()
	h.ServeHTTP(dupRR, dupReq)
	if dupRR.Code != 400 {
		t.Fatalf("dup status %d", dupRR.Code)
	}
	var dupErr map[string]string
	_ = json.Unmarshal(dupRR.Body.Bytes(), &dupErr)
	if dupErr["error"] != "line 2: duplicate record id "+id1 {
		t.Fatalf("dup error %v", dupErr)
	}
	if len(notified) != 0 {
		t.Fatalf("must not notify on dup: %v", notified)
	}
	var cnt int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM records WHERE id = $1`, id1).Scan(&cnt)
	if cnt != 0 {
		t.Fatalf("dup leaked row count %d", cnt)
	}

	// reserved tag insert OK
	notified = nil
	id2 := "01900000-0000-7000-8000-0000000000c2"
	reserved := fmt.Sprintf(`{"id":%q,"happened_at":"2026-07-30T00:00:00.000Z","numeric_value":"70","raw_content":null,"tags":"[\"body:weight\"]","objective_context":%q,"ai_analysis":null}`, id2, marker+"-reserved")
	resBody, resCT := buildImportMultipartBytes(t, "records.jsonl", "application/x-ndjson", reserved)
	resReq := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", resBody)
	resReq.Header.Set("Authorization", "Bearer admin-tok")
	resReq.Header.Set("Content-Type", resCT)
	resRR := httptest.NewRecorder()
	h.ServeHTTP(resRR, resReq)
	if resRR.Code != 200 {
		t.Fatalf("reserved status %d body %s", resRR.Code, resRR.Body.String())
	}
	if len(notified) != 1 {
		t.Fatalf("reserved notify %v", notified)
	}

	// round-trip: create via log → export → delete → import
	createBody := fmt.Sprintf(`{
		"happened_at":"2026-07-30T08:00:00+08:00",
		"entries": [{
			"numeric_value": "99",
			"tags": ["go_rt"],
			"memo": %q
		}]
	}`, marker+"-rt")
	createReq := httptest.NewRequest(http.MethodPost, "/api/log/numbers", strings.NewReader(createBody))
	createReq.Header.Set("Authorization", "Bearer ai-tok")
	createReq.Header.Set("Content-Type", "application/json")
	createRR := httptest.NewRecorder()
	h.ServeHTTP(createRR, createReq)
	if createRR.Code != 201 {
		t.Fatalf("create status %d body %s", createRR.Code, createRR.Body.String())
	}
	// 批量不回传 id：按 tag 查回
	ridQ := httptest.NewRequest(http.MethodGet, "/api/query?tag=go_rt", nil)
	ridQ.Header.Set("Authorization", "Bearer ai-tok")
	ridRR := httptest.NewRecorder()
	h.ServeHTTP(ridRR, ridQ)
	if ridRR.Code != 200 {
		t.Fatalf("query status %d", ridRR.Code)
	}
	var ridBody map[string]any
	_ = json.Unmarshal(ridRR.Body.Bytes(), &ridBody)
	ridRecs := ridBody["records"].([]any)
	rid := ridRecs[0].(map[string]any)["id"].(string)

	notified = nil
	expReq := httptest.NewRequest(http.MethodGet, "/api/export/records?from="+rid+"&limit=1", nil)
	expReq.Header.Set("Authorization", "Bearer ai-tok")
	expRR := httptest.NewRecorder()
	h.ServeHTTP(expRR, expReq)
	if expRR.Code != 200 {
		t.Fatalf("export status %d", expRR.Code)
	}
	ndjson := expRR.Body.String()
	if strings.TrimSpace(ndjson) == "" {
		t.Fatal("empty export")
	}

	_, _ = pool.Exec(ctx, `DELETE FROM records WHERE id = $1`, rid)

	notified = nil
	impBody, impCT := buildImportMultipartBytes(t, "records.jsonl", "application/x-ndjson", ndjson)
	impReq := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", impBody)
	impReq.Header.Set("Authorization", "Bearer admin-tok")
	impReq.Header.Set("Content-Type", impCT)
	impRR := httptest.NewRecorder()
	h.ServeHTTP(impRR, impReq)
	if impRR.Code != 200 {
		t.Fatalf("import status %d body %s", impRR.Code, impRR.Body.String())
	}
	var impOK map[string]any
	_ = json.Unmarshal(impRR.Body.Bytes(), &impOK)
	if impOK["inserted"] != float64(1) || impOK["total"] != float64(1) {
		t.Fatalf("import body %v", impOK)
	}
	if len(notified) != 1 || !strings.Contains(notified[0], "Imported 1 records") {
		t.Fatalf("import notify %v", notified)
	}
	var oc, offset string
	var happenedAt time.Time
	err = pool.QueryRow(ctx, `SELECT objective_context, utc_offset, happened_at FROM records WHERE id = $1`, rid).Scan(&oc, &offset, &happenedAt)
	if err != nil || oc != marker+"-rt" {
		t.Fatalf("restored row oc=%q err=%v", oc, err)
	}
	if offset != "+08:00" {
		t.Fatalf("utc_offset=%q want +08:00", offset)
	}
	wantInstant, _ := time.Parse(time.RFC3339, "2026-07-30T08:00:00+08:00")
	if !happenedAt.Equal(wantInstant) {
		t.Fatalf("happened_at=%v want %v", happenedAt, wantInstant)
	}
}
