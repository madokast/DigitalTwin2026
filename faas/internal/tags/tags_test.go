package tags

import (
	"encoding/json"
	"reflect"
	"strings"
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
	if r := ValidateTags(nil); !r.Valid {
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
	if !IsReservedTag("body:weight") {
		t.Fatal("expected body:weight reserved")
	}
	if !IsReservedTag("body:weight:x") {
		t.Fatal("expected body:weight:x reserved")
	}
	if IsReservedTag("body:weightx") {
		t.Fatal("colon boundary: body:weightx must not be reserved")
	}
	if !IsReservedTag("todo") {
		t.Fatal("expected todo reserved")
	}
	if !IsReservedTag("todo:in_progress") {
		t.Fatal("expected todo:in_progress reserved")
	}
	if !IsReservedTag("todo:completed") {
		t.Fatal("expected todo:completed reserved")
	}
	if IsReservedTag("todolist") {
		t.Fatal("colon boundary: todolist must not be reserved")
	}
	if !IsReservedTag("review") {
		t.Fatal("expected review reserved")
	}
	if !IsReservedTag("review:weekly") {
		t.Fatal("expected review:weekly reserved")
	}
	if !IsReservedTag("review:weekly:extra") {
		t.Fatal("expected review:weekly:extra reserved")
	}
	if IsReservedTag("reviewpoint") {
		t.Fatal("colon boundary: reviewpoint must not be reserved")
	}
	r := AssertNoReservedTags([]string{"weight", "transaction_entry"})
	if r.Valid || r.Error != ReservedTagError("transaction_entry") {
		t.Fatalf("%+v", r)
	}
	r = AssertNoReservedTags([]string{"transaction_entry:expense"})
	if r.Valid || r.Error != ReservedTagError("transaction_entry:expense") {
		t.Fatalf("%+v", r)
	}
	r = AssertNoReservedTags([]string{"body:weight"})
	if r.Valid || r.Error != ReservedTagError("body:weight") {
		t.Fatalf("%+v", r)
	}
	r = AssertNoReservedTags([]string{"todo"})
	if r.Valid || r.Error != ReservedTagError("todo") {
		t.Fatalf("%+v", r)
	}
	r = AssertNoReservedTags([]string{"todo:in_progress"})
	if r.Valid || r.Error != ReservedTagError("todo:in_progress") {
		t.Fatalf("%+v", r)
	}
	r = AssertNoReservedTags([]string{"review"})
	if r.Valid || r.Error != ReservedTagError("review") {
		t.Fatalf("%+v", r)
	}
	r = AssertNoReservedTags([]string{"review:weekly"})
	if r.Valid || r.Error != ReservedTagError("review:weekly") {
		t.Fatalf("%+v", r)
	}
	if r := AssertNoReservedTags([]string{"weight"}); !r.Valid {
		t.Fatalf("%+v", r)
	}
	if r := AssertNoReservedTags([]string{"transaction_entrypoint"}); !r.Valid {
		t.Fatalf("%+v", r)
	}
	if r := AssertNoReservedTags([]string{"todolist"}); !r.Valid {
		t.Fatalf("%+v", r)
	}
	if r := AssertNoReservedTags([]string{"reviewpoint"}); !r.Valid {
		t.Fatalf("%+v", r)
	}

	wantTx := `tag "transaction_entry" is reserved; use the dedicated log API for this record type`
	if ReservedTagError("transaction_entry") != wantTx {
		t.Fatalf("tx hint: %q", ReservedTagError("transaction_entry"))
	}
	wantWt := `tag "body:weight" is reserved; use the dedicated log API for this record type`
	if ReservedTagError("body:weight") != wantWt {
		t.Fatalf("weight hint: %q", ReservedTagError("body:weight"))
	}
	wantTodo := `tag "todo" is reserved; use the dedicated log API for this record type`
	if ReservedTagError("todo") != wantTodo {
		t.Fatalf("todo hint: %q", ReservedTagError("todo"))
	}
	wantTodoPrefixed := `tag "todo:in_progress" is reserved; use the dedicated log API for this record type`
	if ReservedTagError("todo:in_progress") != wantTodoPrefixed {
		t.Fatalf("todo prefixed hint: %q", ReservedTagError("todo:in_progress"))
	}
	wantReview := `tag "review" is reserved; use the dedicated log API for this record type`
	if ReservedTagError("review") != wantReview {
		t.Fatalf("review hint: %q", ReservedTagError("review"))
	}
	wantReviewPrefixed := `tag "review:weekly" is reserved; use the dedicated log API for this record type`
	if ReservedTagError("review:weekly") != wantReviewPrefixed {
		t.Fatalf("review prefixed hint: %q", ReservedTagError("review:weekly"))
	}
}

func TestAggregateTagCounts(t *testing.T) {
	got, err := AggregateTagCounts([]string{
		`["weight","morning"]`,
		`["study","physics"]`,
		`["weight"]`,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []TagCount{
		{Tag: "weight", Count: 2},
		{Tag: "morning", Count: 1},
		{Tag: "physics", Count: 1},
		{Tag: "study", Count: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("counts:\n got %#v\nwant %#v", got, want)
	}
}

func TestAggregateTagCountsEmptyReturnsEmptySlice(t *testing.T) {
	// 与 TS `returns empty array for no rows` 对齐：空输入返回空非 nil slice（JSON []）
	got, err := AggregateTagCounts(nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(got) != 0 {
		t.Fatalf("empty input must return empty non-nil slice, got %#v", got)
	}
}

func TestAggregateTagCountsOrderCountDescThenName(t *testing.T) {
	got, err := AggregateTagCounts([]string{
		`["a","b","b","c","c","c"]`,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	// 计数降序：c(3) → b(2) → a(1)；同计数按名升序
	want := []TagCount{
		{Tag: "c", Count: 3},
		{Tag: "b", Count: 2},
		{Tag: "a", Count: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order:\n got %#v\nwant %#v", got, want)
	}
}

func TestAggregateTagCountsTieBreakByNameAsc(t *testing.T) {
	// 同计数次级按 tag 名升序（字节序：大写在小写前）
	got, err := AggregateTagCounts([]string{
		`["weight","Weight","apple","Apple","banana","Banana"]`,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []TagCount{
		{Tag: "Apple", Count: 1},
		{Tag: "Banana", Count: 1},
		{Tag: "Weight", Count: 1},
		{Tag: "apple", Count: 1},
		{Tag: "banana", Count: 1},
		{Tag: "weight", Count: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tie-break:\n got %#v\nwant %#v", got, want)
	}
}

func TestAggregateTagCountsPrefix(t *testing.T) {
	got, err := AggregateTagCounts([]string{
		`["body:weight","body:weight","workout:arm","morning"]`,
	}, "body:")
	if err != nil {
		t.Fatal(err)
	}
	// 真前缀：只留 body: 开头；workout:arm、morning 排除
	want := []TagCount{{Tag: "body:weight", Count: 2}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("prefix:\n got %#v\nwant %#v", got, want)
	}
}

func TestAggregateTagCountsPrefixTreatsStarLiterally(t *testing.T) {
	// prefix 是纯字面前缀，`*` 不做通配解析：`*` 不是合法 tag 字符，
	// 故无任何 tag 以字面 `*` 开头 → 返回空；若被当通配则会返回全部。
	got, err := AggregateTagCounts([]string{
		`["workout:arm","morning"]`,
	}, "*")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("literal star prefix should match nothing, got %#v", got)
	}
}

func TestAggregateTagCountsDirtyJSON(t *testing.T) {
	if _, me := AggregateTagCounts([]string{`not-json`}, ""); me == nil {
		t.Fatal("expected invalid JSON error")
	}
	for _, field := range []string{`{}`, `null`, `"weight"`} {
		_, me := AggregateTagCounts([]string{field}, "")
		if me == nil || me.Status != 500 || !strings.Contains(me.Message, ErrTagsNotJSONArray) {
			t.Fatalf("%q: want 500 ErrTagsNotJSONArray, got %v", field, me)
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
	_, _, me := RenameTagInTagsJSON(`{`, "a", "b")
	if me == nil {
		t.Fatal("expected invalid JSON error")
	}
	_, _, me = RenameTagInTagsJSON(`{}`, "a", "b")
	if me == nil || me.Status != 500 || !strings.Contains(me.Message, ErrTagsNotJSONArray) {
		t.Fatalf("got %v", me)
	}
	_, _, me = RenameTagInTagsJSON(`null`, "a", "b")
	if me == nil || me.Status != 500 || !strings.Contains(me.Message, ErrTagsNotJSONArray) {
		t.Fatalf("null: got %v", me)
	}
}

func TestValidateRename(t *testing.T) {
	if r := ValidateRename("", "to_tag"); r.Valid || r.Error != "missing required fields: from, to" {
		t.Fatalf("empty from: %+v", r)
	}
	if r := ValidateRename("from_tag", ""); r.Valid || r.Error != "missing required fields: from, to" {
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
	if r := ValidateRename("todo", "errand"); r.Valid || r.Error != ReservedTagError("todo") {
		t.Fatalf("reserved todo from: %+v", r)
	}
	if r := ValidateRename("errand", "todo:in_progress"); r.Valid || r.Error != ReservedTagError("todo:in_progress") {
		t.Fatalf("reserved todo to: %+v", r)
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
	_, _, me := RenameTagInTagsJSON(`{"not":"array"}`, "a", "b")
	if me == nil || me.Status != 500 || !strings.Contains(me.Message, ErrTagsNotJSONArray) {
		t.Fatalf("dirty row must abort rename: %v", me)
	}
}

func TestFirstDuplicateTag(t *testing.T) {
	if got := FirstDuplicateTag([]string{"a", "b", "a"}); got != "a" {
		t.Fatalf("first dup: got %q want a", got)
	}
	if got := FirstDuplicateTag([]string{"a", "b", "b", "c", "b"}); got != "b" {
		t.Fatalf("first dup: got %q want b", got)
	}
	if got := FirstDuplicateTag(nil); got != "" {
		t.Fatalf("nil: got %q", got)
	}
	if got := FirstDuplicateTag([]string{"a", "b", "c"}); got != "" {
		t.Fatalf("no dup: got %q", got)
	}
}
