package query

import (
	"encoding/json"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

func TestEscapeLikePattern(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"a_b":     `a\_b`,
		"100%":    `100\%`,
		`a\b`:     `a\\b`,
		`a_%\x`:   `a\_\%\\x`,
		"plain":   "plain",
	}
	for in, want := range cases {
		if got := EscapeLikePattern(in); got != want {
			t.Fatalf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestBuildWhereEscapesTagAndQ(t *testing.T) {
	t.Parallel()
	p := &ParsedQuery{Tags: []string{"a_b"}, Q: "x%y_z", Page: 1, PageSize: 20}
	_, args := buildWhere(p)
	if len(args) < 1 || args[0] != `%"a\_b"%` {
		t.Fatalf("tag pattern: %#v", args)
	}
	if len(args) < 2 || args[1] != `%x\%y\_z%` {
		t.Fatalf("q pattern: %#v", args)
	}
}

func TestEmptyIDResultRecordsJSONIsArrayNotNull(t *testing.T) {
	t.Parallel()
	// 与 Next / OpenAPI 对齐：id 未命中时 records 必须是 []，不能是 null
	recs := []record.Record{} // 与 FetchFilteredRecords id 分支初始化一致
	raw, err := json.Marshal(map[string]any{"records": recs})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"records":[]}` {
		t.Fatalf("got %s", raw)
	}
	var nilRecs []record.Record
	rawNil, _ := json.Marshal(map[string]any{"records": nilRecs})
	if string(rawNil) != `{"records":null}` {
		t.Fatalf("sanity: nil slice should be null, got %s", rawNil)
	}
}

func TestBuildWhereGroupsQOrWithAnd(t *testing.T) {
	t.Parallel()
	p := &ParsedQuery{Tags: []string{"x"}, Q: "foo", Page: 1, PageSize: 20}
	where, _ := buildWhere(p)
	// AND 优先于 OR：无括号会变成 (tag AND vt) OR obj OR …
	want := `tags LIKE $1 AND (raw_content LIKE $2 OR objective_context LIKE $3 OR ai_analysis LIKE $4 OR tags LIKE $5)`
	if where != want {
		t.Fatalf("where:\n got %q\nwant %q", where, want)
	}
}
