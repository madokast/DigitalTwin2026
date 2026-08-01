package query

import (
	"net/url"
	"testing"
	"time"
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
	_, err = ParseRecordQueryParams(url.Values{"pageSize": {"101"}})
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
		t.Fatalf("compact offset: %v", err)
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
