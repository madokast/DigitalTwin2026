package tags

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ---- 假 Querier / Rows（断言 SQL，不依赖真实数据库）----

type recordedExec struct {
	sql  string
	args []any
}

type fakeQuerier struct {
	querySQL string
	rows     [][]any
	queryErr error
	execs    []recordedExec
	execErr  error
}

func (f *fakeQuerier) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	f.querySQL = sql
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	return &fakeRows{data: f.rows}, nil
}

func (f *fakeQuerier) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execs = append(f.execs, recordedExec{sql: sql, args: append([]any{}, args...)})
	if f.execErr != nil {
		return pgconn.CommandTag{}, f.execErr
	}
	return pgconn.CommandTag{}, nil
}

func (f *fakeQuerier) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("QueryRow not used by renameAcrossQuerier")
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

func TestRenameAcrossRecords_updatesMatchingRows(t *testing.T) {
	q := &fakeQuerier{
		rows: [][]any{
			{"id-1", `["weight","morning"]`},
			{"id-2", `["weight"]`},
			{"id-3", `["other"]`},
		},
	}
	updated, err := renameAcrossQuerier(context.Background(), q, "weight", "mass")
	if err != nil {
		t.Fatal(err)
	}
	if updated != 2 {
		t.Fatalf("updated=%d want 2", updated)
	}
	if !strings.Contains(q.querySQL, "SELECT id, tags FROM records") {
		t.Fatalf("unexpected Query SQL: %q", q.querySQL)
	}
	if len(q.execs) != 2 {
		t.Fatalf("Exec count=%d want 2", len(q.execs))
	}
	for _, e := range q.execs {
		if !strings.Contains(e.sql, "UPDATE records SET tags") {
			t.Fatalf("unexpected Exec SQL: %q", e.sql)
		}
	}
	if q.execs[0].args[0] != `["mass","morning"]` || q.execs[0].args[1] != "id-1" {
		t.Fatalf("exec[0] args=%v", q.execs[0].args)
	}
	if q.execs[1].args[0] != `["mass"]` || q.execs[1].args[1] != "id-2" {
		t.Fatalf("exec[1] args=%v", q.execs[1].args)
	}
}

func TestRenameAcrossRecords_noMatchSkipsExec(t *testing.T) {
	q := &fakeQuerier{
		rows: [][]any{
			{"id-1", `["alpha"]`},
			{"id-2", `["beta"]`},
		},
	}
	updated, err := renameAcrossQuerier(context.Background(), q, "weight", "mass")
	if err != nil {
		t.Fatal(err)
	}
	if updated != 0 {
		t.Fatalf("updated=%d want 0", updated)
	}
	if len(q.execs) != 0 {
		t.Fatalf("expected no Exec, got %d: %+v", len(q.execs), q.execs)
	}
}

func TestRenameAcrossRecords_dirtyTagsJSONError(t *testing.T) {
	q := &fakeQuerier{
		rows: [][]any{
			{"id-1", `{"not":"array"}`},
		},
	}
	updated, err := renameAcrossQuerier(context.Background(), q, "a", "b")
	if !errors.Is(err, ErrTagsNotJSONArray) {
		t.Fatalf("err=%v want ErrTagsNotJSONArray", err)
	}
	if updated != 0 {
		t.Fatalf("updated=%d want 0", updated)
	}
	if len(q.execs) != 0 {
		t.Fatalf("dirty JSON must not Exec, got %d", len(q.execs))
	}
}
