package tags

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
)

// ---- 假 TxBeginner / Tx / Rows（断言 SQL，不依赖真实数据库）----

type recordedExec struct {
	sql  string
	args []any
}

type fakeTx struct {
	queryPages [][][]any // 每页一行组（FindByCriteria 的 Query 返回序列）
	pageIdx    int
	querySQLs  []string
	queryArgs  [][]any
	execs      []recordedExec
	queryErr   error
	execErr    error
	committed  bool
	rolledBack bool
}

func (t *fakeTx) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	t.querySQLs = append(t.querySQLs, sql)
	t.queryArgs = append(t.queryArgs, append([]any{}, args...))
	if t.queryErr != nil {
		return nil, t.queryErr
	}
	if t.pageIdx >= len(t.queryPages) {
		return &fakeRows{}, nil
	}
	page := t.queryPages[t.pageIdx]
	t.pageIdx++
	return &fakeRows{data: page}, nil
}

func (t *fakeTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	t.execs = append(t.execs, recordedExec{sql: sql, args: append([]any{}, args...)})
	if t.execErr != nil {
		return pgconn.CommandTag{}, t.execErr
	}
	return pgconn.CommandTag{}, nil
}

func (t *fakeTx) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("QueryRow not used by RenameAcrossRecords")
}
func (t *fakeTx) Commit(context.Context) error   { t.committed = true; return nil }
func (t *fakeTx) Rollback(context.Context) error { t.rolledBack = true; return nil }

type fakeTxBeginner struct{ tx *fakeTx }

func (b *fakeTxBeginner) Begin(context.Context) (db.Tx, error) { return b.tx, nil }
func (b *fakeTxBeginner) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return b.tx.Query(ctx, sql, args...)
}
func (b *fakeTxBeginner) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return b.tx.Exec(ctx, sql, args...)
}
func (b *fakeTxBeginner) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return b.tx.QueryRow(ctx, sql, args...)
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

// renameRow 构造 FindByCriteria 的一行（8 列，与 scanRecordRow 顺序一致）。
func renameRow(id, tags string) []any {
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

func TestRenameAcrossRecords_updatesMatchingRows(t *testing.T) {
	tx := &fakeTx{
		queryPages: [][][]any{
			{renameRow("id-1", `["weight","morning"]`), renameRow("id-2", `["weight"]`)},
		},
	}
	updated, me := RenameAcrossRecords(context.Background(), &fakeTxBeginner{tx: tx}, "weight", "mass")
	if me != nil {
		t.Fatal(me)
	}
	if updated != 2 {
		t.Fatalf("updated=%d want 2", updated)
	}
	// 锁 + 2 次 Update
	if len(tx.execs) != 3 {
		t.Fatalf("Exec count=%d want 3 (lock + 2 updates), got %+v", len(tx.execs), tx.execs)
	}
	if !strings.Contains(tx.execs[0].sql, "pg_advisory_xact_lock") {
		t.Fatalf("first Exec must be advisory lock, got %q", tx.execs[0].sql)
	}
	for _, e := range tx.execs[1:] {
		if !strings.Contains(e.sql, "UPDATE records SET") {
			t.Fatalf("unexpected Exec SQL: %q", e.sql)
		}
	}
	// Update 全列写回：tags JSON 在参数位 4（$5），id 在末位（$8）
	if got := tx.execs[1].args[4]; got != `["mass","morning"]` {
		t.Fatalf("exec[1] tags arg=%v", got)
	}
	if got := tx.execs[2].args[4]; got != `["mass"]` {
		t.Fatalf("exec[2] tags arg=%v", got)
	}
	if !strings.Contains(tx.querySQLs[0], `tags LIKE $1`) || len(tx.queryArgs[0]) != 1 || tx.queryArgs[0][0] != `%"weight"%` {
		t.Fatalf("Query must filter tag=from: %q args=%v", tx.querySQLs[0], tx.queryArgs[0])
	}
	if !strings.Contains(tx.querySQLs[0], "ORDER BY id ASC") || !strings.Contains(tx.querySQLs[0], "LIMIT 100 OFFSET 0") {
		t.Fatalf("Query must page by id: %q", tx.querySQLs[0])
	}
	if !tx.committed {
		t.Fatalf("committed=%v", tx.committed)
	}
}

func TestRenameAcrossRecords_paginatesUntilShortPage(t *testing.T) {
	page1 := make([][]any, RenamePageSize)
	for i := range page1 {
		page1[i] = renameRow("id-"+string(rune('a'+i)), `["weight"]`)
	}
	tx := &fakeTx{
		queryPages: [][][]any{
			page1,
			{renameRow("id-z", `["weight","weight:extra"]`)},
		},
	}
	updated, me := RenameAcrossRecords(context.Background(), &fakeTxBeginner{tx: tx}, "weight", "mass")
	if me != nil {
		t.Fatal(me)
	}
	if updated != RenamePageSize+1 {
		t.Fatalf("updated=%d want %d", updated, RenamePageSize+1)
	}
	if len(tx.querySQLs) != 2 {
		t.Fatalf("Query count=%d want 2 pages", len(tx.querySQLs))
	}
	if !strings.Contains(tx.querySQLs[1], "OFFSET 100") {
		t.Fatalf("second page must OFFSET 100: %q", tx.querySQLs[1])
	}
	if !tx.committed {
		t.Fatalf("committed=%v", tx.committed)
	}
}

func TestRenameAcrossRecords_noMatchSkipsUpdate(t *testing.T) {
	tx := &fakeTx{
		queryPages: [][][]any{
			{renameRow("id-1", `["alpha"]`)},
		},
	}
	updated, me := RenameAcrossRecords(context.Background(), &fakeTxBeginner{tx: tx}, "weight", "mass")
	if me != nil {
		t.Fatal(me)
	}
	if updated != 0 {
		t.Fatalf("updated=%d want 0", updated)
	}
	if len(tx.execs) != 1 {
		t.Fatalf("Exec count=%d want 1 (lock only)", len(tx.execs))
	}
	if !tx.committed {
		t.Fatalf("committed=%v", tx.committed)
	}
}

func TestRenameAcrossRecords_driverErrorRollsBack(t *testing.T) {
	tx := &fakeTx{
		queryPages: [][][]any{
			{renameRow("id-1", `["weight"]`)},
		},
		execErr: errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`),
	}
	_, me := RenameAcrossRecords(context.Background(), &fakeTxBeginner{tx: tx}, "weight", "mass")
	if me == nil {
		t.Fatal("want error")
	}
	if me.Status != 500 {
		t.Fatalf("status=%d want 500", me.Status)
	}
	if tx.committed || !tx.rolledBack {
		t.Fatalf("driver error must roll back (committed=%v rolledBack=%v)", tx.committed, tx.rolledBack)
	}
}

func TestRenameTagsTransform(t *testing.T) {
	cases := []struct {
		name string
		tags []string
		from string
		to   string
		want []string
		ok   bool
	}{
		{"replace", []string{"work", "urgent"}, "work", "job", []string{"job", "urgent"}, true},
		{"to exists removes from", []string{"job", "work", "x"}, "work", "job", []string{"job", "x"}, true},
		{"to exists single", []string{"work", "job"}, "work", "job", []string{"job"}, true},
		{"from absent unchanged", []string{"alpha"}, "weight", "mass", []string{"alpha"}, false},
		{"empty tags", []string{}, "weight", "mass", []string{}, false},
		{"order preserved", []string{"a", "work", "b", "work"}, "work", "job", []string{"a", "job", "b", "job"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := renameTags(tc.tags, tc.from, tc.to)
			if ok != tc.ok {
				t.Fatalf("ok=%v want %v", ok, tc.ok)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v want %v", got, tc.want)
				}
			}
		})
	}
}
