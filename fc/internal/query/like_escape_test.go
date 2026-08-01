package query

import "testing"

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
