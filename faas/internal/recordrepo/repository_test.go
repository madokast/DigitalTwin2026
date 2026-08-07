package recordrepo

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

type fakeRow struct {
	vals []any
	err  error
}

func (r *fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, d := range dest {
		switch p := d.(type) {
		case *string:
			*p = r.vals[i].(string)
		case *bool:
			*p = r.vals[i].(bool)
		case *int:
			*p = r.vals[i].(int)
		case *time.Time:
			*p = r.vals[i].(time.Time)
		case **string:
			if r.vals[i] == nil {
				*p = nil
			} else {
				s := r.vals[i].(string)
				*p = &s
			}
		default:
			return errors.New("unsupported scan dest type")
		}
	}
	return nil
}

type fakeExecutor struct {
	execSQL      []string
	execArgs     [][]any
	row          *fakeRow
	rowsAff      int64
	execErr      error
	querySQL     string
	queryArgs    []any
	queryRows    [][]any
	queryErr     error
	queryRowSQL  string
	queryRowArgs []any
	queryRowErr  error
}

func (f *fakeExecutor) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	f.queryRowSQL = sql
	f.queryRowArgs = append([]any{}, args...)
	if f.queryRowErr != nil {
		return &fakeRow{err: f.queryRowErr}
	}
	return f.row
}
func (f *fakeExecutor) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execSQL = append(f.execSQL, sql)
	f.execArgs = append(f.execArgs, append([]any{}, args...))
	if f.execErr != nil {
		return pgconn.CommandTag{}, f.execErr
	}
	return pgconn.NewCommandTag("UPDATE " + strconv.FormatInt(f.rowsAff, 10)), nil
}
func (f *fakeExecutor) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	f.querySQL = sql
	f.queryArgs = append([]any{}, args...)
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	return &fakeRows{data: f.queryRows}, nil
}

type fakeRows struct {
	data [][]any
	i    int // 已消费条数；Next 后指向 data[i-1]
	err  error
}

func (r *fakeRows) Next() bool {
	if r.i >= len(r.data) {
		return false
	}
	r.i++
	return true
}

func (r *fakeRows) Scan(dest ...any) error {
	row := r.data[r.i-1]
	if len(dest) != len(row) {
		return errors.New("scan dest/row length mismatch")
	}
	for i, d := range dest {
		switch p := d.(type) {
		case *string:
			*p = row[i].(string)
		case *time.Time:
			*p = row[i].(time.Time)
		case **string:
			if row[i] == nil {
				*p = nil
			} else {
				s := row[i].(string)
				*p = &s
			}
		default:
			return errors.New("unsupported scan dest type")
		}
	}
	return nil
}

func (r *fakeRows) Close()                                       {}
func (r *fakeRows) Err() error                                   { return r.err }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) Values() ([]any, error)                       { return nil, nil }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }

func TestFindByIDNotFound(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{err: pgx.ErrNoRows}}
	_, me := Repo.FindByID(context.Background(), f, "01900000-0000-7000-8000-000000000003")
	if me == nil {
		t.Fatal("want not found")
	}
	if me.Status != 404 {
		t.Fatalf("err %v, want myerr 404", me)
	}
	if !strings.Contains(me.Message, "not found") {
		t.Fatalf("msg %q", me.Message)
	}
}

func TestFindByIDDriverErrorInternal(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{err: errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`)}}
	_, me := Repo.FindByID(context.Background(), f, "01900000-0000-7000-8000-000000000003")
	if me == nil {
		t.Fatal("want error")
	}
	if me.Status != 500 {
		t.Fatalf("err %v, want myerr 500", me)
	}
	if !strings.Contains(me.Message, `ERROR: relation "records" does not exist (SQLSTATE 42P01)`) {
		t.Fatalf("driver message not embedded: %q", me.Message)
	}
}

func TestTransitionAffectedNotOne(t *testing.T) {
	f := &fakeExecutor{rowsAff: 2}
	me := Repo.Transition(context.Background(), f, "id", []string{"todo:completed"})
	if me == nil {
		t.Fatal("want error for rowsAffected != 1")
	}
	if me.Status != 500 {
		t.Fatalf("err %v, want myerr 500", me)
	}
	if !strings.Contains(me.Message, "todo update affected 2 rows") {
		t.Fatalf("err %v", me)
	}
	if len(f.execSQL) != 1 || !strings.Contains(f.execSQL[0], "UPDATE records SET tags") {
		t.Fatalf("sql %v", f.execSQL)
	}
}

func criteriaRow(id, tags string) []any {
	return []any{
		id,
		time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC),
		"+00:00",
		"12.34",
		"raw",
		tags,
		"obj",
		"ai",
	}
}

func TestFindByCriteriaValidation400(t *testing.T) {
	base := func() FindCriteria {
		return FindCriteria{Page: 1, PageSize: 20, SortBy: "happened_at", SortOrder: "asc"}
	}
	cases := []struct {
		name string
		c    FindCriteria
		want string
	}{
		{"page zero", func() FindCriteria { c := base(); c.Page = 0; return c }(), "page must be a positive integer"},
		{"page negative", func() FindCriteria { c := base(); c.Page = -1; return c }(), "page must be a positive integer"},
		{"pageSize zero", func() FindCriteria { c := base(); c.PageSize = 0; return c }(), "page_size must be a positive integer"},
		{"sortBy empty", func() FindCriteria { c := base(); c.SortBy = ""; return c }(), "sort_by must be one of: happened_at, id"},
		{"sortBy invalid", func() FindCriteria { c := base(); c.SortBy = "foo"; return c }(), "sort_by must be one of: happened_at, id"},
		{"sortOrder empty", func() FindCriteria { c := base(); c.SortOrder = ""; return c }(), "sort_order must be one of: asc, desc"},
		{"sortOrder invalid", func() FindCriteria { c := base(); c.SortOrder = "foo"; return c }(), "sort_order must be one of: asc, desc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeExecutor{}
			_, me := Repo.FindByCriteria(context.Background(), f, tc.c)
			if me == nil {
				t.Fatal("want validation error")
			}
			if me.Status != 400 {
				t.Fatalf("status=%d want 400 (%s)", me.Status, me.Message)
			}
			if me.Message != tc.want {
				t.Fatalf("msg %q want %q", me.Message, tc.want)
			}
			if f.querySQL != "" {
				t.Fatalf("no query expected on validation failure, got %q", f.querySQL)
			}
		})
	}
}

func TestFindByCriteriaBuildsConditions(t *testing.T) {
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)
	f := &fakeExecutor{queryRows: [][]any{criteriaRow("id-1", `["work"]`)}}
	_, me := Repo.FindByCriteria(context.Background(), f, FindCriteria{
		Criteria: Criteria{
			From: &from,
			To:   &to,
			Tags: []string{"work", "family:*"},
			Q:    "hello world",
		},
		Page:      1,
		PageSize:  100,
		SortBy:    "id",
		SortOrder: "asc",
	})
	if me != nil {
		t.Fatal(me)
	}
	sql := f.querySQL
	for _, want := range []string{
		"happened_at >= $1",
		"happened_at < $2",
		"tags LIKE $3",
		"tags LIKE $4",
		`raw_content LIKE $5 OR objective_context LIKE $6 OR ai_analysis LIKE $7 OR tags LIKE $8`,
		"ORDER BY id ASC",
		"LIMIT 100 OFFSET 0",
	} {
		if !strings.Contains(sql, want) {
			t.Fatalf("SQL missing %q:\n%s", want, sql)
		}
	}
	if len(f.queryArgs) != 8 {
		t.Fatalf("args=%v want 8", f.queryArgs)
	}
	// 模式在参数中（SQL 侧仅占位符）：精确 tag → %"work"%；族通配 → %"family:%
	if got := f.queryArgs[2]; got != `%"work"%` {
		t.Fatalf("tag arg=%v want %%\"work\"%%", got)
	}
	if got := f.queryArgs[3]; got != `%"family:%` {
		t.Fatalf("wildcard arg=%v want %%\"family:\"%%", got)
	}
	if got := f.queryArgs[4]; got != `%hello world%` {
		t.Fatalf("q arg=%v want %%hello world%%", got)
	}
}

func TestFindByCriteriaIDNoPagination(t *testing.T) {
	f := &fakeExecutor{queryRows: [][]any{criteriaRow("id-1", `["work"]`)}}
	_, me := Repo.FindByCriteria(context.Background(), f, FindCriteria{
		Criteria:  Criteria{ID: "01900000-0000-7000-8000-000000000003"},
		Page:      2,
		PageSize:  20,
		SortBy:    "happened_at",
		SortOrder: "asc",
	})
	if me != nil {
		t.Fatal(me)
	}
	if strings.Contains(f.querySQL, "LIMIT") {
		t.Fatalf("id path must not paginate: %q", f.querySQL)
	}
}

func TestFindByCriteriaNoConditions(t *testing.T) {
	f := &fakeExecutor{queryRows: [][]any{criteriaRow("id-1", `[]`)}}
	_, me := Repo.FindByCriteria(context.Background(), f, FindCriteria{
		Page:      1,
		PageSize:  20,
		SortBy:    "happened_at",
		SortOrder: "desc",
	})
	if me != nil {
		t.Fatal(me)
	}
	if strings.Contains(f.querySQL, "WHERE") {
		t.Fatalf("no WHERE expected: %q", f.querySQL)
	}
	if !strings.Contains(f.querySQL, "ORDER BY happened_at DESC, id ASC") {
		t.Fatalf("unexpected order: %q", f.querySQL)
	}
	if !strings.Contains(f.querySQL, "LIMIT 20 OFFSET 0") {
		t.Fatalf("unexpected pagination: %q", f.querySQL)
	}
}

func TestFindByCriteriaFromDB(t *testing.T) {
	f := &fakeExecutor{queryRows: [][]any{criteriaRow("01900000-0000-7000-8000-000000000003", `["work","urgent"]`)}}
	recs, me := Repo.FindByCriteria(context.Background(), f, FindCriteria{
		Page:      1,
		PageSize:  20,
		SortBy:    "happened_at",
		SortOrder: "asc",
	})
	if me != nil {
		t.Fatal(me)
	}
	if len(recs) != 1 {
		t.Fatalf("recs=%d want 1", len(recs))
	}
	if recs[0].ID != "01900000-0000-7000-8000-000000000003" {
		t.Fatalf("id %q", recs[0].ID)
	}
	if recs[0].HappenedAt != "2026-08-01T12:00:00.000+00:00" {
		t.Fatalf("happened_at %q", recs[0].HappenedAt)
	}
	if len(recs[0].Tags) != 2 || recs[0].Tags[0] != "work" || recs[0].Tags[1] != "urgent" {
		t.Fatalf("tags %v", recs[0].Tags)
	}
}

func TestFindByCriteriaDriverErrorInternal(t *testing.T) {
	f := &fakeExecutor{queryErr: errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`)}
	_, me := Repo.FindByCriteria(context.Background(), f, FindCriteria{
		Page:      1,
		PageSize:  20,
		SortBy:    "happened_at",
		SortOrder: "asc",
	})
	if me == nil {
		t.Fatal("want error")
	}
	if me.Status != 500 {
		t.Fatalf("status=%d want 500", me.Status)
	}
	if !strings.Contains(me.Message, `ERROR: relation "records" does not exist (SQLSTATE 42P01)`) {
		t.Fatalf("driver message not embedded: %q", me.Message)
	}
}

func TestExistsTrue(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{vals: []any{true}}}
	exists, me := Repo.Exists(context.Background(), f, "01900000-0000-7000-8000-000000000003")
	if me != nil {
		t.Fatal(me)
	}
	if !exists {
		t.Fatal("want exists=true")
	}
}

func TestExistsFalse(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{vals: []any{false}}}
	exists, me := Repo.Exists(context.Background(), f, "01900000-0000-7000-8000-000000000003")
	if me != nil {
		t.Fatal(me)
	}
	if exists {
		t.Fatal("want exists=false")
	}
}

func TestExistsDriverErrorInternal(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{err: errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`)}}
	_, me := Repo.Exists(context.Background(), f, "id")
	if me == nil {
		t.Fatal("want error")
	}
	if me.Status != 500 {
		t.Fatalf("status=%d want 500", me.Status)
	}
}

func TestUpdateAllColumns(t *testing.T) {
	numVal := "12.34"
	raw := "raw"
	ai := "ai"
	f := &fakeExecutor{rowsAff: 1}
	me := Repo.Update(context.Background(), f, record.Record{
		ID:               "01900000-0000-7000-8000-000000000003",
		HappenedAt:       "2026-08-01T12:00:00.000+08:00",
		NumericValue:     &numVal,
		RawContent:       &raw,
		Tags:             []string{"work", "urgent"},
		ObjectiveContext: "obj",
		AiAnalysis:       &ai,
	})
	if me != nil {
		t.Fatal(me)
	}
	if len(f.execSQL) != 1 {
		t.Fatalf("exec count=%d want 1", len(f.execSQL))
	}
	sql := f.execSQL[0]
	for _, want := range []string{
		"UPDATE records SET",
		"happened_at = $1::timestamptz",
		"utc_offset = $2",
		"numeric_value = $3",
		"raw_content = $4",
		"tags = $5",
		"objective_context = $6",
		"ai_analysis = $7",
		"WHERE id = $8",
	} {
		if !strings.Contains(sql, want) {
			t.Fatalf("SQL missing %q:\n%s", want, sql)
		}
	}
	if len(f.execArgs) != 1 || len(f.execArgs[0]) != 8 {
		t.Fatalf("exec args=%v want 1 exec of 8 args", f.execArgs)
	}
	// utc_offset 由 repo 内 ParseHappenedAt 重解析（带区串 → offset 字面量）
	if got := f.execArgs[0][1].(string); got != "+08:00" {
		t.Fatalf("utc_offset arg=%v want +08:00", got)
	}
	if got := f.execArgs[0][4].(string); got != `["work","urgent"]` {
		t.Fatalf("tags arg=%v want JSON", got)
	}
}

func TestUpdateInvalidHappenedAt400(t *testing.T) {
	f := &fakeExecutor{}
	me := Repo.Update(context.Background(), f, record.Record{
		ID:         "01900000-0000-7000-8000-000000000003",
		HappenedAt: "not-a-datetime",
	})
	if me == nil {
		t.Fatal("want validation error")
	}
	if me.Status != 400 {
		t.Fatalf("status=%d want 400", me.Status)
	}
	if len(f.execSQL) != 0 {
		t.Fatalf("no exec expected, got %q", f.execSQL)
	}
}

func TestUpdateDriverErrorInternal(t *testing.T) {
	f := &fakeExecutor{execErr: errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`)}
	me := Repo.Update(context.Background(), f, record.Record{
		ID:         "01900000-0000-7000-8000-000000000003",
		HappenedAt: "2026-08-01T12:00:00.000+08:00",
		Tags:       []string{"work"},
	})
	if me == nil {
		t.Fatal("want error")
	}
	if me.Status != 500 {
		t.Fatalf("status=%d want 500", me.Status)
	}
	if !strings.Contains(me.Message, `ERROR: relation "records" does not exist (SQLSTATE 42P01)`) {
		t.Fatalf("driver message not embedded: %q", me.Message)
	}
}

func TestAcquireRenameLockExecutes(t *testing.T) {
	f := &fakeExecutor{}
	me := Repo.AcquireRenameLock(context.Background(), f)
	if me != nil {
		t.Fatal(me)
	}
	if len(f.execSQL) != 1 || !strings.Contains(f.execSQL[0], "pg_advisory_xact_lock") {
		t.Fatalf("sql=%v", f.execSQL)
	}
	if len(f.execArgs[0]) != 1 || f.execArgs[0][0].(int64) != 726478478 {
		t.Fatalf("lock key arg=%v", f.execArgs[0])
	}
}

func TestAcquireRenameLockDriverErrorInternal(t *testing.T) {
	f := &fakeExecutor{execErr: errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`)}
	me := Repo.AcquireRenameLock(context.Background(), f)
	if me == nil {
		t.Fatal("want error")
	}
	if me.Status != 500 {
		t.Fatalf("status=%d want 500", me.Status)
	}
}

func TestFindByCriteriaIDFromKeyset(t *testing.T) {
	f := &fakeExecutor{queryRows: [][]any{criteriaRow("id-1", `["work"]`)}}
	_, me := Repo.FindByCriteria(context.Background(), f, FindCriteria{
		Criteria:  Criteria{IDFrom: "01900000-0000-7000-8000-000000000003"},
		Page:      1,
		PageSize:  20,
		SortBy:    "id",
		SortOrder: "asc",
	})
	if me != nil {
		t.Fatal(me)
	}
	if !strings.Contains(f.querySQL, "id >= $1") {
		t.Fatalf("keyset SQL missing id >=: %q", f.querySQL)
	}
	if !strings.Contains(f.querySQL, "LIMIT 20 OFFSET 0") {
		t.Fatalf("IDFrom must paginate: %q", f.querySQL)
	}
	if len(f.queryArgs) != 1 || f.queryArgs[0] != "01900000-0000-7000-8000-000000000003" {
		t.Fatalf("args=%v", f.queryArgs)
	}
}

func TestFindByCriteriaIDAndIDFromMutuallyExclusive(t *testing.T) {
	f := &fakeExecutor{}
	_, me := Repo.FindByCriteria(context.Background(), f, FindCriteria{
		Criteria:  Criteria{ID: "01900000-0000-7000-8000-000000000001", IDFrom: "01900000-0000-7000-8000-000000000002"},
		Page:      1,
		PageSize:  20,
		SortBy:    "happened_at",
		SortOrder: "asc",
	})
	if me == nil || me.Status != 400 {
		t.Fatalf("want 400 mutual exclusion, got %v", me)
	}
	if f.querySQL != "" {
		t.Fatalf("no query expected, got %q", f.querySQL)
	}
}

func TestCountNoFilter(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{vals: []any{42}}}
	total, me := Repo.Count(context.Background(), f, Criteria{})
	if me != nil {
		t.Fatal(me)
	}
	if total != 42 {
		t.Fatalf("total=%d want 42", total)
	}
	if !strings.Contains(f.queryRowSQL, "SELECT count(*) FROM records") || strings.Contains(f.queryRowSQL, "WHERE") {
		t.Fatalf("unexpected SQL: %q", f.queryRowSQL)
	}
}

func TestCountWithConditions(t *testing.T) {
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	f := &fakeExecutor{row: &fakeRow{vals: []any{7}}}
	total, me := Repo.Count(context.Background(), f, Criteria{
		From: &from,
		Tags: []string{"work", "family:*"},
	})
	if me != nil {
		t.Fatal(me)
	}
	if total != 7 {
		t.Fatalf("total=%d want 7", total)
	}
	for _, want := range []string{"happened_at >= $1", "tags LIKE $2", "tags LIKE $3"} {
		if !strings.Contains(f.queryRowSQL, want) {
			t.Fatalf("SQL missing %q:\n%s", want, f.queryRowSQL)
		}
	}
	if len(f.queryRowArgs) != 3 {
		t.Fatalf("args=%v want 3", f.queryRowArgs)
	}
}

func TestCountDriverErrorInternal(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{err: errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`)}}
	_, me := Repo.Count(context.Background(), f, Criteria{})
	if me == nil || me.Status != 500 {
		t.Fatalf("me=%v want 500", me)
	}
}

func TestAttachTagAppend(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{vals: []any{`["exercise"]`}}, rowsAff: 1}
	res, me := Repo.AttachTag(context.Background(), f, "id-1", "workout:arm")
	if me != nil {
		t.Fatalf("err %v", me)
	}
	if !res.Changed || len(res.From) != 1 || res.From[0] != "exercise" {
		t.Fatalf("from %v changed %v", res.From, res.Changed)
	}
	wantTo := []string{"exercise", "workout:arm"}
	if len(res.To) != 2 || res.To[0] != wantTo[0] || res.To[1] != wantTo[1] {
		t.Fatalf("to %v", res.To)
	}
	if !strings.Contains(f.queryRowSQL, "FOR UPDATE") {
		t.Fatalf("want FOR UPDATE lock, got %s", f.queryRowSQL)
	}
	if len(f.execSQL) != 1 {
		t.Fatalf("want 1 exec, got %d", len(f.execSQL))
	}
	wantTags := `["exercise","workout:arm"]`
	if f.execArgs[0][0] != wantTags || f.execArgs[0][1] != "id-1" {
		t.Fatalf("args %v", f.execArgs[0])
	}
}

func TestAttachTagDuplicateNoUpdate(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{vals: []any{`["a","b"]`}}}
	res, me := Repo.AttachTag(context.Background(), f, "id-1", "b")
	if me != nil {
		t.Fatalf("err %v", me)
	}
	if res.Changed {
		t.Fatal("want changed=false for duplicate")
	}
	if len(res.To) != 2 || res.To[0] != "a" || res.To[1] != "b" {
		t.Fatalf("to %v", res.To)
	}
	if len(f.execSQL) != 0 {
		t.Fatalf("want no UPDATE on duplicate, got %d", len(f.execSQL))
	}
}

func TestAttachTagNotFound(t *testing.T) {
	f := &fakeExecutor{queryRowErr: pgx.ErrNoRows}
	_, me := Repo.AttachTag(context.Background(), f, "missing", "t")
	if me == nil {
		t.Fatal("want error")
	}
	if me.Status != 404 || me.Message != "record missing not found" {
		t.Fatalf("%v", me)
	}
}

func TestAttachTagDirtyTagsRecover(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{vals: []any{`{"not":"array"}`}}, rowsAff: 1}
	res, me := Repo.AttachTag(context.Background(), f, "id-1", "t")
	if me != nil {
		t.Fatalf("err %v", me)
	}
	if !res.Changed || len(res.From) != 0 || len(res.To) != 1 || res.To[0] != "t" {
		t.Fatalf("res %+v", res)
	}
}

func TestDetachTagRemove(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{vals: []any{`["a","b","c"]`}}, rowsAff: 1}
	res, me := Repo.DetachTag(context.Background(), f, "id-1", "b")
	if me != nil {
		t.Fatalf("err %v", me)
	}
	if !res.Changed {
		t.Fatal("want changed=true")
	}
	// 删除原地、保持剩余顺序
	if len(res.To) != 2 || res.To[0] != "a" || res.To[1] != "c" {
		t.Fatalf("to %v", res.To)
	}
	if f.execArgs[0][0] != `["a","c"]` {
		t.Fatalf("args %v", f.execArgs[0])
	}
}

func TestDetachTagAbsentNoUpdate(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{vals: []any{`["a"]`}}}
	res, me := Repo.DetachTag(context.Background(), f, "id-1", "zzz")
	if me != nil {
		t.Fatalf("err %v", me)
	}
	if res.Changed || len(res.To) != 1 {
		t.Fatalf("res %+v", res)
	}
	if len(f.execSQL) != 0 {
		t.Fatalf("want no UPDATE, got %d", len(f.execSQL))
	}
}

func TestEditTagAffectedZeroInternal(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{vals: []any{`["a"]`}}, rowsAff: 0}
	_, me := Repo.AttachTag(context.Background(), f, "id-1", "b")
	if me == nil {
		t.Fatal("want error for rowsAffected != 1")
	}
	if me.Status != 500 || !strings.Contains(me.Message, "tag edit affected 0 rows") {
		t.Fatalf("%v", me)
	}
}
