package tags

import (
	"encoding/json"
	"errors"
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
	if got["weight"] != 2 || got["morning"] != 1 || got["study"] != 1 || got["physics"] != 1 {
		t.Fatalf("counts: %#v", got)
	}
}

func TestAggregateTagCountsKeyOrderBytewise(t *testing.T) {
	got, err := AggregateTagCounts([]string{
		`["weight","Weight","apple","Apple"]`,
	})
	if err != nil {
		t.Fatal(err)
	}
	// encoding/json 与 AggregateTagCounts 均按 sort.Strings：大写在小写前
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"Apple":1,"Weight":1,"apple":1,"weight":1}`
	if string(raw) != want {
		t.Fatalf("json order:\n got %s\nwant %s", raw, want)
	}
}

func TestAggregateTagCountsDirtyJSON(t *testing.T) {
	if _, err := AggregateTagCounts([]string{`not-json`}); err == nil {
		t.Fatal("expected invalid JSON error")
	}
	for _, field := range []string{`{}`, `null`, `"weight"`} {
		_, err := AggregateTagCounts([]string{field})
		if !errors.Is(err, ErrTagsNotJSONArray) {
			t.Fatalf("%q: want ErrTagsNotJSONArray, got %v", field, err)
		}
	}
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

	var arr []string
	if err := json.Unmarshal([]byte(out), &arr); err != nil {
		t.Fatal(err)
	}
}

func TestRenameTagInTagsJSONDirty(t *testing.T) {
	_, _, err := RenameTagInTagsJSON(`{`, "a", "b")
	if err == nil {
		t.Fatal("expected invalid JSON error")
	}
	_, _, err = RenameTagInTagsJSON(`{}`, "a", "b")
	if !errors.Is(err, ErrTagsNotJSONArray) {
		t.Fatalf("got %v", err)
	}
	_, _, err = RenameTagInTagsJSON(`null`, "a", "b")
	if !errors.Is(err, ErrTagsNotJSONArray) {
		t.Fatalf("null: got %v", err)
	}
}

func TestValidateRename(t *testing.T) {
	if r := ValidateRename("", "to_tag"); r.Valid || r.Error != "Missing required fields: from, to" {
		t.Fatalf("empty from: %+v", r)
	}
	if r := ValidateRename("from_tag", ""); r.Valid || r.Error != "Missing required fields: from, to" {
		t.Fatalf("empty to: %+v", r)
	}
	if r := ValidateRename("bad-tag", "ok"); r.Valid || r.Error != "from and to must be valid tag names" {
		t.Fatalf("invalid: %+v", r)
	}
	if r := ValidateRename("transaction_entry", "weight"); r.Valid || r.Error != ReservedTagError("transaction_entry") {
		t.Fatalf("reserved from: %+v", r)
	}
	if r := ValidateRename("weight", "transaction_entry:income"); r.Valid || r.Error != ReservedTagError("transaction_entry:income") {
		t.Fatalf("reserved to: %+v", r)
	}
	if r := ValidateRename("weight", "weight"); r.Valid || r.Error != "from and to must be different" {
		t.Fatalf("same: %+v", r)
	}
	if r := ValidateRename("exercise", "workout"); !r.Valid {
		t.Fatalf("expected valid: %+v", r)
	}
}

// renameAcrossQuerier 写库路径见 tags_db_test.go（假 Querier）。
// 生产 RenameAcrossRecords 另包事务 + advisory lock。
// 此处保留纯逻辑契约：脏 JSON 与 RenameTagInTagsJSON 对齐。
func TestRenameAcrossRecordsPureLogicContract(t *testing.T) {
	_, _, err := RenameTagInTagsJSON(`{"not":"array"}`, "a", "b")
	if !errors.Is(err, ErrTagsNotJSONArray) {
		t.Fatalf("dirty row must abort rename: %v", err)
	}
}
