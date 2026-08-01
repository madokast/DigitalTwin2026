package tags

import (
	"encoding/json"
	"testing"
)

func TestIsValidTag(t *testing.T) {
	valid := []string{"weight", "source:device", "review:weekly", "a", "A1_b:c2"}
	for _, tag := range valid {
		if !IsValidTag(tag) {
			t.Errorf("expected valid: %q", tag)
		}
	}
	invalid := []string{"", "体重", ":device", "source:", "source::device", "1weight", "source:device:", "has space", "has-dash"}
	for _, tag := range invalid {
		if IsValidTag(tag) {
			t.Errorf("expected invalid: %q", tag)
		}
	}
}

func TestValidateTags(t *testing.T) {
	if r := ValidateTags(nil); r.Valid || r.Error != "tags must be a non-empty array" {
		t.Fatalf("empty: %+v", r)
	}
	r := ValidateTags([]string{"weight", "体重"})
	if r.Valid || r.Error == "" {
		t.Fatalf("invalid tag: %+v", r)
	}
	if r := ValidateTags([]string{"weight", "source:device"}); !r.Valid {
		t.Fatalf("expected valid: %+v", r)
	}
}

func TestAssertNoReservedTags(t *testing.T) {
	if !IsReservedTag("transaction_entry") {
		t.Fatal("expected reserved")
	}
	if !IsReservedTag("transaction_entry:income") {
		t.Fatal("expected reserved prefix")
	}
	if !IsReservedTag("transaction_entry:a:b") {
		t.Fatal("expected reserved nested prefix")
	}
	if IsReservedTag("transaction_entrypoint") {
		t.Fatal("colon boundary: transaction_entrypoint must not be reserved")
	}
	r := AssertNoReservedTags([]string{"weight", "transaction_entry"})
	if r.Valid || r.Error != ReservedTagError("transaction_entry") {
		t.Fatalf("%+v", r)
	}
	r = AssertNoReservedTags([]string{"transaction_entry:expense"})
	if r.Valid || r.Error != ReservedTagError("transaction_entry:expense") {
		t.Fatalf("%+v", r)
	}
	if r := AssertNoReservedTags([]string{"weight"}); !r.Valid {
		t.Fatalf("%+v", r)
	}
	if r := AssertNoReservedTags([]string{"transaction_entrypoint"}); !r.Valid {
		t.Fatalf("%+v", r)
	}
}

func TestAggregateTagCounts(t *testing.T) {
	got, err := AggregateTagCounts([]string{
		`["weight","morning"]`,
		`["study","physics"]`,
		`["weight"]`,
	})
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(got))
	for k := range got {
		keys = append(keys, k)
	}
	wantOrder := []string{"morning", "physics", "study", "weight"}
	// map iteration order is not guaranteed for keys slice we built from range —
	// AggregateTagCounts returns map; JSON marshal of maps in Go sorts keys, but
	// for equality check compare values and that all keys exist.
	if got["weight"] != 2 || got["morning"] != 1 || got["study"] != 1 || got["physics"] != 1 {
		t.Fatalf("counts: %#v", got)
	}
	_ = wantOrder
	_ = keys
}

func TestRenameTagInTagsJSON(t *testing.T) {
	_, ok, err := RenameTagInTagsJSON(`["weight"]`, "exercise", "workout")
	if err != nil || ok {
		t.Fatalf("absent from: ok=%v err=%v", ok, err)
	}

	out, ok, err := RenameTagInTagsJSON(`["exercise","morning"]`, "exercise", "workout")
	if err != nil || !ok {
		t.Fatal(err, ok)
	}
	if out != `["workout","morning"]` {
		t.Fatalf("got %s", out)
	}

	out, ok, err = RenameTagInTagsJSON(`["exercise","workout"]`, "exercise", "workout")
	if err != nil || !ok {
		t.Fatal(err, ok)
	}
	if out != `["workout"]` {
		t.Fatalf("dedupe got %s", out)
	}

	// ensure valid JSON
	var arr []string
	if err := json.Unmarshal([]byte(out), &arr); err != nil {
		t.Fatal(err)
	}
}
