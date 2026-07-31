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
