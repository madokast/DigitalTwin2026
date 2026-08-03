package recordjsonl

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

type validCase struct {
	Name                           string   `json:"name"`
	Line                           string   `json:"line"`
	ExpectTags                     []string `json:"expectTags"`
	ExpectValueNumber              *string  `json:"expectValueNumber"`
	ExpectValueText                *string  `json:"expectValueText"`
	ExpectObjectiveContext         string   `json:"expectObjectiveContext"`
	ExpectSubjectiveInterpretation *string  `json:"expectSubjectiveInterpretation"`
	ExpectHappenedAtUtcMs          int64    `json:"expectHappenedAtUtcMs"`
	Serialized                     string   `json:"serialized"`
}

type invalidCase struct {
	Name  string `json:"name"`
	Line  string `json:"line"`
	Error string `json:"error"`
}

type fixtureFile struct {
	Valid          []validCase   `json:"valid"`
	Invalid        []invalidCase `json:"invalid"`
	WithLineNumber struct {
		LineNumber int    `json:"lineNumber"`
		Line       string `json:"line"`
		Error      string `json:"error"`
	} `json:"withLineNumber"`
}

func loadCases(t *testing.T) fixtureFile {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	b, err := os.ReadFile(filepath.Join(root, "testdata", "record-jsonl-cases.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cases fixtureFile
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return cases
}

func ptrStrEq(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func TestFormatLineError(t *testing.T) {
	if got := FormatLineError("boom", 3); got != "line 3: boom" {
		t.Fatalf("got %q", got)
	}
	if got := FormatLineError("boom", 0); got != "boom" {
		t.Fatalf("got %q", got)
	}
}

func TestParseLineValid(t *testing.T) {
	cases := loadCases(t)
	for _, c := range cases.Valid {
		t.Run(c.Name, func(t *testing.T) {
			row, err := ParseLine(c.Line, 0)
			if err != nil {
				t.Fatal(err)
			}
			if len(row.Tags) != len(c.ExpectTags) {
				t.Fatalf("tags %#v want %#v", row.Tags, c.ExpectTags)
			}
			for i := range c.ExpectTags {
				if row.Tags[i] != c.ExpectTags[i] {
					t.Fatalf("tags %#v want %#v", row.Tags, c.ExpectTags)
				}
			}
			if !ptrStrEq(row.ValueNumber, c.ExpectValueNumber) {
				t.Fatalf("valueNumber %#v want %#v", row.ValueNumber, c.ExpectValueNumber)
			}
			if !ptrStrEq(row.ValueText, c.ExpectValueText) {
				t.Fatalf("valueText %#v want %#v", row.ValueText, c.ExpectValueText)
			}
			if row.ObjectiveContext != c.ExpectObjectiveContext {
				t.Fatalf("objectiveContext %q", row.ObjectiveContext)
			}
			if !ptrStrEq(row.SubjectiveInterpretation, c.ExpectSubjectiveInterpretation) {
				t.Fatalf("subjective %#v want %#v", row.SubjectiveInterpretation, c.ExpectSubjectiveInterpretation)
			}
			if row.HappenedAt.UTC().UnixMilli() != c.ExpectHappenedAtUtcMs {
				t.Fatalf("happenedAt ms %d want %d", row.HappenedAt.UTC().UnixMilli(), c.ExpectHappenedAtUtcMs)
			}
			got, err := SerializeLine(row)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.Serialized {
				t.Fatalf("serialized\n got %s\nwant %s", got, c.Serialized)
			}
		})
	}
}

func TestReservedTagsPassParse(t *testing.T) {
	cases := loadCases(t)
	var reserved *validCase
	for i := range cases.Valid {
		if cases.Valid[i].Name == "reserved-todo-tag-passes-parse" {
			reserved = &cases.Valid[i]
			break
		}
	}
	if reserved == nil {
		t.Fatal("missing reserved-todo-tag-passes-parse case")
	}
	row, err := ParseLine(reserved.Line, 0)
	if err != nil {
		t.Fatal(err)
	}
	if rv := tags.AssertNoReservedTags(row.Tags); rv.Valid {
		t.Fatal("expected AssertNoReservedTags to reject")
	}
}

func TestParseLineBOM(t *testing.T) {
	cases := loadCases(t)
	_, err := ParseLine("\ufeff"+cases.Valid[0].Line, 0)
	if err != nil {
		t.Fatal(err)
	}
}

func TestParseLineInvalid(t *testing.T) {
	cases := loadCases(t)
	for _, c := range cases.Invalid {
		t.Run(c.Name, func(t *testing.T) {
			_, err := ParseLine(c.Line, 0)
			if err == nil {
				t.Fatal("expected error")
			}
			if err.Error() != c.Error {
				t.Fatalf("got %q want %q", err.Error(), c.Error)
			}
		})
	}

	w := cases.WithLineNumber
	_, err := ParseLine(w.Line, w.LineNumber)
	if err == nil || err.Error() != w.Error {
		t.Fatalf("line number wrap: got %v want %q", err, w.Error)
	}

	if _, err := ParseLine("", 0); err == nil || err.Error() != InvalidJSONLine {
		t.Fatalf("empty: %v", err)
	}
	if _, err := ParseLine("   ", 0); err == nil || err.Error() != InvalidJSONLine {
		t.Fatalf("blank: %v", err)
	}
}

func TestSerializeRoundTrip(t *testing.T) {
	cases := loadCases(t)
	for _, c := range cases.Valid {
		t.Run(c.Name, func(t *testing.T) {
			once, err := ParseLine(c.Line, 0)
			if err != nil {
				t.Fatal(err)
			}
			line, err := SerializeLine(once)
			if err != nil {
				t.Fatal(err)
			}
			twice, err := ParseLine(line, 0)
			if err != nil {
				t.Fatal(err)
			}
			if twice.ID != once.ID {
				t.Fatal("id")
			}
			if !twice.HappenedAt.Equal(once.HappenedAt) {
				t.Fatal("happened_at")
			}
			if twice.UtcOffset != once.UtcOffset {
				t.Fatalf("utc_offset %q want %q", twice.UtcOffset, once.UtcOffset)
			}
			if !ptrStrEq(twice.ValueNumber, once.ValueNumber) {
				t.Fatal("value_number")
			}
			if !ptrStrEq(twice.ValueText, once.ValueText) {
				t.Fatal("value_text")
			}
			if len(twice.Tags) != len(once.Tags) {
				t.Fatal("tags len")
			}
			for i := range once.Tags {
				if twice.Tags[i] != once.Tags[i] {
					t.Fatal("tags")
				}
			}
			if twice.ObjectiveContext != once.ObjectiveContext {
				t.Fatal("objective_context")
			}
			if !ptrStrEq(twice.SubjectiveInterpretation, once.SubjectiveInterpretation) {
				t.Fatal("subjective")
			}
		})
	}
}
