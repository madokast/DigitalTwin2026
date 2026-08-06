package logapi

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

// ---- 假 db.Tx / db.TxBeginner（四类域错误 + 成功路径，不依赖真实数据库）----

type fakeRow struct {
	vals []any
	err  error
}

func (r *fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.vals) {
		return errors.New("scan dest/vals length mismatch")
	}
	for i, d := range dest {
		switch p := d.(type) {
		case *string:
			*p = r.vals[i].(string)
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

type fakeTx struct {
	execSQL   []string
	execArgs  [][]any
	insertRow *fakeRow
	commitN   int
	rollbackN int
	execErr   error
	rowsAff   int64
}

func (t *fakeTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	t.execSQL = append(t.execSQL, sql)
	t.execArgs = append(t.execArgs, append([]any{}, args...))
	if t.execErr != nil {
		return pgconn.CommandTag{}, t.execErr
	}
	aff := t.rowsAff
	if aff == 0 {
		aff = 1
	}
	return pgconn.NewCommandTag("UPDATE " + strconv.FormatInt(aff, 10)), nil
}

func (t *fakeTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	_ = sql
	_ = args
	if t.insertRow != nil {
		return t.insertRow
	}
	return &fakeRow{err: errors.New("unexpected QueryRow on fakeTx")}
}

// Query 满足 db.Executor（transitionTodo 不用 Query，panic 暴露误用）
func (t *fakeTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("Query not used by transitionTodo")
}

func (t *fakeTx) Commit(context.Context) error {
	t.commitN++
	return nil
}

func (t *fakeTx) Rollback(context.Context) error {
	t.rollbackN++
	return nil
}

type fakeTransitionDB struct {
	selectRow *fakeRow
	tx        *fakeTx
	beginErr  error
}

func (f *fakeTransitionDB) QueryRow(context.Context, string, ...any) pgx.Row {
	if f.selectRow != nil {
		return f.selectRow
	}
	return &fakeRow{err: pgx.ErrNoRows}
}

// Exec / Query 满足 db.TxBeginner（transitionTodo 只用 QueryRow + Begin，误用 panic 暴露）
func (f *fakeTransitionDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("Exec not used by transitionTodo")
}

func (f *fakeTransitionDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("Query not used by transitionTodo")
}

func (f *fakeTransitionDB) Begin(context.Context) (db.Tx, error) {
	if f.beginErr != nil {
		return nil, f.beginErr
	}
	if f.tx == nil {
		f.tx = &fakeTx{}
	}
	return f.tx, nil
}

const (
	todoID   = "01900000-0000-7000-8000-000000000003"
	todoBody = `{
		"id":"01900000-0000-7000-8000-000000000003",
		"target":"completed",
		"happened_at":"2026-08-02T12:00:00+08:00"
	}`
)

// todoParsed transitionTodo 的 typed 入参（route 层经 tododraft.ParseTodoTransition 解析产物）。
var todoParsed = func() tododraft.NormalizedTodoTransition {
	parsed, err := tododraft.ParseTodoTransition([]byte(todoBody))
	if err != nil {
		panic(err)
	}
	return parsed
}()

func sampleTodoSelect(tags string, rawContent string) *fakeRow {
	happened := time.Date(2026, 8, 2, 2, 0, 0, 0, time.UTC)
	// 列序与 recordrepo.FindByID SELECT 对齐：id, happened_at, utc_offset, numeric_value,
	// raw_content, objective_context, ai_analysis, tags
	return &fakeRow{vals: []any{
		todoID,
		happened,
		"Z",
		nil,
		rawContent,
		"weekend grocery list",
		nil,
		tags,
	}}
}

func TestTransitionTodo_fourDomainErrors(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		db     *fakeTransitionDB
		want   string
		status int
	}{
		{
			name:   "not found",
			db:     &fakeTransitionDB{selectRow: &fakeRow{err: pgx.ErrNoRows}},
			want:   tododraft.ErrTodoNotFound.Error(),
			status: 404,
		},
		{
			name: "not a todo",
			db: &fakeTransitionDB{
				selectRow: sampleTodoSelect(`["note"]`, "plain note"),
			},
			want:   tododraft.ErrNotATodo.Error(),
			status: 400,
		},
		{
			name: "audit record",
			db: &fakeTransitionDB{
				selectRow: sampleTodoSelect(`["todo:transition"]`, "Buy milk"),
			},
			want:   tododraft.ErrAuditTransition.Error(),
			status: 400,
		},
		{
			name: "already target",
			db: &fakeTransitionDB{
				selectRow: sampleTodoSelect(`["todo:completed","errand"]`, "Buy milk"),
			},
			want:   tododraft.ErrAlreadyTarget.Error(),
			status: 400,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, status, err := transitionTodo(context.Background(), c.db, todoParsed)
			if status != c.status {
				t.Fatalf("status=%d want %d", status, c.status)
			}
			if err == nil || err.Error() != c.want {
				t.Fatalf("err=%v want %q", err, c.want)
			}
			if c.db.tx != nil && c.db.tx.commitN != 0 {
				t.Fatalf("must not commit on domain error")
			}
		})
	}
}

// D7：UPDATE 影响行数 ≠ 1（SELECT 与 UPDATE 间记录被删的并发竞态）→ 500、回滚、不插审计行。
// 与 Next transitionTodo（logapi.ts）对齐：同样 500 + "todo update affected N rows"。
func TestTransitionTodo_updateAffectedNotOne(t *testing.T) {
	fdb := &fakeTransitionDB{
		selectRow: sampleTodoSelect(`["todo:in_progress"]`, "Buy milk"),
		tx:        &fakeTx{rowsAff: 2},
	}
	_, status, err := transitionTodo(context.Background(), fdb, todoParsed)
	if status != 500 || err == nil || !strings.Contains(err.Error(), "todo update affected 2 rows") {
		t.Fatalf("status=%d err=%v", status, err)
	}
	if fdb.tx.commitN != 0 {
		t.Fatal("must not commit when affected != 1")
	}
	if fdb.tx.rollbackN == 0 {
		t.Fatal("expected rollback")
	}
}

func TestTransitionTodo_successShapeAndAuditText(t *testing.T) {
	t.Parallel()
	happened := time.Date(2026, 8, 2, 2, 0, 0, 0, time.UTC)
	// D6 通知正文；审计行客观上下文句（todoID + 带区时间，无正文）
	wantNotify := tododraft.TodoAuditNotifyText(
		"completed", todoID, "2026-08-02T02:00:00.000Z", "Buy milk",
	)
	wantObjCtx := tododraft.AuditObjectiveContext(
		"completed", todoID, "2026-08-02T02:00:00.000Z",
	)
	tx := &fakeTx{
		insertRow: &fakeRow{vals: []any{
			"01900000-0000-7000-8000-000000000099",
			time.Date(2026, 8, 2, 4, 0, 0, 0, time.UTC),
			"+08:00",
			nil,
			"Buy milk", // 审计行 raw_content = 待办原文逐字拷贝
			wantObjCtx,
			nil, // ai_analysis 恒 null
			`["todo:transition"]`,
		}},
	}
	db := &fakeTransitionDB{
		selectRow: &fakeRow{vals: []any{
			todoID,
			happened,
			"Z",
			nil,
			"Buy milk",
			"weekend grocery list",
			nil,
			`["todo:in_progress","errand"]`,
		}},
		tx: tx,
	}

	result, status, err := transitionTodo(context.Background(), db, todoParsed)
	if err != nil {
		t.Fatal(err)
	}
	if status != 200 {
		t.Fatalf("status=%d", status)
	}
	if result.ID != todoID || result.From != "in_progress" || result.To != "completed" {
		t.Fatalf("result=%+v", result)
	}
	if result.TodoAuditNotifyText != wantNotify {
		t.Fatalf("notify=%q want %q", result.TodoAuditNotifyText, wantNotify)
	}
	if tx.commitN != 1 {
		t.Fatalf("commitN=%d", tx.commitN)
	}
	if len(tx.execSQL) != 1 || !strings.Contains(tx.execSQL[0], "UPDATE records SET tags") {
		t.Fatalf("exec SQL=%v", tx.execSQL)
	}
	if got := tx.execArgs[0][0]; got != `["todo:completed","errand"]` {
		t.Fatalf("new tags=%v", got)
	}
}

// UPDATE 成功、审计 INSERT 失败：defer Rollback、未 Commit，无半提交语义。
func TestTransitionTodo_updateOkInsertFailRollsBack(t *testing.T) {
	t.Parallel()
	insertBoom := errors.New("audit insert failed")
	tx := &fakeTx{
		insertRow: &fakeRow{err: insertBoom},
	}
	db := &fakeTransitionDB{
		selectRow: sampleTodoSelect(`["todo:in_progress","errand"]`, "Buy milk"),
		tx:        tx,
	}

	result, status, err := transitionTodo(context.Background(), db, todoParsed)
	if status != 500 {
		t.Fatalf("status=%d want 500", status)
	}
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "insert todo audit") {
		t.Fatalf("err=%v want wrap of insert todo audit", err)
	}
	if !errors.Is(err, insertBoom) {
		t.Fatalf("err=%v want errors.Is insertBoom", err)
	}
	if result != (TransitionResult{}) {
		t.Fatalf("result=%+v want zero (no half-success)", result)
	}
	if len(tx.execSQL) != 1 || !strings.Contains(tx.execSQL[0], "UPDATE records SET tags") {
		t.Fatalf("UPDATE must run before INSERT fail; execSQL=%v", tx.execSQL)
	}
	if tx.commitN != 0 {
		t.Fatalf("commitN=%d want 0 (no half-commit)", tx.commitN)
	}
	if tx.rollbackN < 1 {
		t.Fatalf("rollbackN=%d want >=1", tx.rollbackN)
	}
}
