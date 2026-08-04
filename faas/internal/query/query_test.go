package query

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

func TestParseRecordQueryParamsDefaults(t *testing.T) {
	p, err := ParseRecordQueryParams(url.Values{})
	if err != nil {
		t.Fatal(err)
	}
	if p.Page != 1 || p.PageSize != 20 {
		t.Fatalf("defaults: %+v", p)
	}
}

func TestParseRecordQueryParamsErrors(t *testing.T) {
	_, err := ParseRecordQueryParams(url.Values{"page": {"0"}})
	if err == nil {
		t.Fatal("page 0")
	}
	_, err = ParseRecordQueryParams(url.Values{"page_size": {"101"}})
	if err == nil {
		t.Fatal("pageSize 101")
	}
	_, err = ParseRecordQueryParams(url.Values{"from": {"2026-07-30T00:00:00"}})
	if err == nil || err.Error() == "" {
		t.Fatal("from without tz")
	}
	// 超大整数：拒绝 Number 精度丢失 / Atoi 溢出边界之上的值（与 Next MAX_SAFE_INTEGER 对齐）
	for _, raw := range []string{
		"9007199254740992",         // MAX_SAFE_INTEGER+1
		"9007199254740993",         // Number 会舍入
		"999999999999999999999999", // 远超 int64
	} {
		_, err = ParseRecordQueryParams(url.Values{"page": {raw}})
		if err == nil || err.Error() != "page must be a positive integer" {
			t.Fatalf("page %q: got %v", raw, err)
		}
	}
	_, err = ParseRecordQueryParams(url.Values{"id": {"not-a-uuid"}})
	if err == nil || err.Error() != "Invalid record id" {
		t.Fatalf("bad id: %v", err)
	}
	for _, id := range []string{
		"a0eebc99-9c0b-4ef8-7000-6bb9bd380a11",
		"01234567-89ab-cdef-0123-456789abcdef",
	} {
		_, err = ParseRecordQueryParams(url.Values{"id": {id}})
		if err == nil || err.Error() != "Invalid record id" {
			t.Fatalf("id %q: got %v", id, err)
		}
	}
}

func TestParseRecordQueryParamsFilters(t *testing.T) {
	q := url.Values{}
	q.Set("from", "2026-07-01T00:00:00Z")
	q.Set("to", "2026-08-01T00:00:00+08:00")
	q.Add("tag", "weight")
	q.Add("tag", "morning")
	q.Set("q", "hello")
	p, err := ParseRecordQueryParams(q)
	if err != nil {
		t.Fatal(err)
	}
	if p.From == nil || !p.From.Equal(time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("from: %v", p.From)
	}
	if len(p.Tags) != 2 || p.Q != "hello" {
		t.Fatalf("filters: %+v", p)
	}
}

func TestParseRecordQueryParamsCompactOffset(t *testing.T) {
	// 与 Next query.test「+0800」及 OpenAPI HappenedAtInput 一致
	q := url.Values{}
	q.Set("from", "2026-07-30T00:00:00+0800")
	q.Set("to", "2026-07-31T00:00:00+0800")
	p, err := ParseRecordQueryParams(q)
	if err != nil {
		t.Fatal(err)
	}
	wantFrom, _ := time.Parse(time.RFC3339, "2026-07-30T00:00:00+08:00")
	wantTo, _ := time.Parse(time.RFC3339, "2026-07-31T00:00:00+08:00")
	if p.From == nil || !p.From.Equal(wantFrom) {
		t.Fatalf("from: got %v want %v", p.From, wantFrom)
	}
	if p.To == nil || !p.To.Equal(wantTo) {
		t.Fatalf("to: got %v want %v", p.To, wantTo)
	}
}

func TestRecordsListOrderBySharedFixture(t *testing.T) {
	t.Parallel()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	b, err := os.ReadFile(filepath.Join(root, "testdata", "query-records-list-order.json"))
	if err != nil {
		t.Fatalf("read shared order fixture: %v", err)
	}
	var shared struct {
		OrderBy string `json:"orderBy"`
	}
	if err := json.Unmarshal(b, &shared); err != nil {
		t.Fatalf("parse shared order fixture: %v", err)
	}
	if RecordsListOrderBy != shared.OrderBy {
		t.Fatalf("RecordsListOrderBy=%q shared=%q", RecordsListOrderBy, shared.OrderBy)
	}
	if RecordsListOrderBy != "happened_at ASC, id ASC" {
		t.Fatalf("RecordsListOrderBy=%q", RecordsListOrderBy)
	}
	// FetchFilteredRecords 经 orderByRecordsList 拼接（无 DESC / 无 order 参数）
	got := orderByRecordsList()
	if got != " ORDER BY happened_at ASC, id ASC" {
		t.Fatalf("orderByRecordsList=%q", got)
	}
	if strings.Contains(got, "DESC") {
		t.Fatalf("order must not use DESC: %q", got)
	}
}

func TestToQueryRecordJSON(t *testing.T) {
	todoText := "Buy milk"
	todo := record.Record{
		ID:                       "01900000-0000-7000-8000-000000000003",
		HappenedAt:               "2026-08-02T02:00:00.000Z",
		NumericValue:              nil,
		RawContent:                &todoText,
		Tags:                     []string{"todo:in_progress", "errand"},
		ObjectiveContext:         "weekend grocery list",
		SubjectiveInterpretation: nil,
	}
	got := ToQueryRecordJSON(todo)
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["created_at"]; !ok {
		t.Fatalf("todo missing created_at: %s", b)
	}
	if _, ok := m["content"]; !ok {
		t.Fatalf("todo missing content: %s", b)
	}
	if _, ok := m["happened_at"]; ok {
		t.Fatalf("todo must not have happenedAt: %s", b)
	}
	if _, ok := m["raw_content"]; ok {
		t.Fatalf("todo must not have rawContent: %s", b)
	}

	copyText := "Buy milk"
	audit := record.Record{
		ID:               "01900000-0000-7000-8000-000000000004",
		HappenedAt:       "2026-08-02T04:00:00.000Z",
		RawContent:        &copyText,
		Tags:             []string{"todo:transition"},
		ObjectiveContext: "Complete a to-do 01900000-0000-7000-8000-000000000003 created at 2026-08-02T02:00:00.000Z",
	}
	gotAudit := ToQueryRecordJSON(audit)
	ab, err := json.Marshal(gotAudit)
	if err != nil {
		t.Fatal(err)
	}
	var am map[string]any
	if err := json.Unmarshal(ab, &am); err != nil {
		t.Fatal(err)
	}
	if _, ok := am["happened_at"]; !ok {
		t.Fatalf("audit missing happenedAt: %s", ab)
	}
	if _, ok := am["raw_content"]; !ok {
		t.Fatalf("audit missing rawContent: %s", ab)
	}
	if _, ok := am["created_at"]; ok {
		t.Fatalf("audit must not have created_at: %s", ab)
	}

	dirty := todo
	dirty.Tags = []string{"todo:completed", "todo:transition"}
	gotDirty := ToQueryRecordJSON(dirty)
	db, err := json.Marshal(gotDirty)
	if err != nil {
		t.Fatal(err)
	}
	var dm map[string]any
	if err := json.Unmarshal(db, &dm); err != nil {
		t.Fatal(err)
	}
	if _, ok := dm["created_at"]; !ok {
		t.Fatalf("dirty state+transition should deform: %s", db)
	}
	if _, ok := dm["happened_at"]; ok {
		t.Fatalf("dirty must not keep happenedAt: %s", db)
	}

	out := RecordsForResponse([]record.Record{todo, audit})
	if len(out) != 2 {
		t.Fatalf("len=%d", len(out))
	}
}
