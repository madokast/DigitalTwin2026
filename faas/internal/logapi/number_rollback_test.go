package logapi

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/numberdraft"
)

// fakeNumberTx 可控事务：QueryRow 第 failOn 次调用返回注入错误（INSERT 失败 → 触发回滚）。
// 满足自定义 db.Tx（QueryRow/Exec/Query/Commit/Rollback）。
type fakeNumberTx struct {
	queryCount int
	failOn     int
	committed  bool
	rollbackN  int
}

func (f *fakeNumberTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	f.queryCount++
	if f.queryCount == f.failOn {
		return &fakeRow{err: errors.New("injected insert failure")}
	}
	// 正常 INSERT RETURNING 行（列序与 recordrepo.Save Scan 对齐）
	return &fakeRow{vals: []any{
		"01900000-0000-7000-8000-000000000099",
		time.Date(2026, 8, 2, 4, 0, 0, 0, time.UTC),
		"+08:00",
		"42.5",
		nil,
		"some memo",
		nil,
		`["go_num"]`,
	}}
}
func (f *fakeNumberTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("Exec not used by createNumberBatch")
}
func (f *fakeNumberTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("Query not used by createNumberBatch")
}
func (f *fakeNumberTx) Commit(context.Context) error {
	f.committed = true
	return nil
}
func (f *fakeNumberTx) Rollback(context.Context) error {
	f.rollbackN++
	return nil
}

// fakeNumberBeginner 满足 db.TxBeginner（Begin 返回预置 fakeNumberTx）。
type fakeNumberBeginner struct {
	tx *fakeNumberTx
}

func (f *fakeNumberBeginner) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("QueryRow not used on beginner")
}
func (f *fakeNumberBeginner) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("Exec not used on beginner")
}
func (f *fakeNumberBeginner) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("Query not used on beginner")
}
func (f *fakeNumberBeginner) Begin(context.Context) (db.Tx, error) {
	if f.tx == nil {
		f.tx = &fakeNumberTx{}
	}
	return f.tx, nil
}

const numberBatchBody = `{
	"happened_at":"2026-08-02T12:00:00+08:00",
	"entries":[
		{"numeric_value":"42.5","memo":"first","tags":["go_num"]},
		{"numeric_value":"7.0","memo":"second","tags":["go_num"]}
	]
}`

// numberBatchParsed createNumberBatch 的 typed 入参（route 层经 numberdraft.ParseNumberBatch 解析产物）。
var numberBatchParsed = func() numberdraft.NormalizedNumberBatch {
	parsed, err := numberdraft.ParseNumberBatch([]byte(numberBatchBody))
	if err != nil {
		panic(err)
	}
	return parsed
}()

// 继承项 2：批量 create 事务回滚测试。第 2 条 INSERT 注入错误 →
// 全部回滚（无 Commit、Rollback 被调）、500、零成功半状态。
func TestCreateNumberBatchRollsBackOnInsertFailure(t *testing.T) {
	fx := &fakeNumberTx{failOn: 2}
	q := &fakeNumberBeginner{tx: fx}

	inserted, recs, err := createNumberBatch(context.Background(), q, numberBatchParsed)
	assertMyStatus(t, err, 500)
	if err == nil || !strings.Contains(err.Error(), "injected insert failure") {
		t.Fatalf("err=%v", err)
	}
	if inserted != 0 || len(recs) != 0 {
		t.Fatalf("must not return half-success: inserted=%d recs=%d", inserted, len(recs))
	}
	if fx.committed {
		t.Fatal("must not commit on insert failure")
	}
	if fx.rollbackN < 1 {
		t.Fatalf("expected Rollback, got %d", fx.rollbackN)
	}
	if fx.queryCount != 2 {
		t.Fatalf("queryCount=%d want 2 (second insert failed, loop stops)", fx.queryCount)
	}
}

func TestCreateNumberBatchSuccessCommits(t *testing.T) {
	fx := &fakeNumberTx{}
	q := &fakeNumberBeginner{tx: fx}

	inserted, recs, err := createNumberBatch(context.Background(), q, numberBatchParsed)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if inserted != 2 || len(recs) != 2 {
		t.Fatalf("inserted=%d recs=%d", inserted, len(recs))
	}
	if !fx.committed {
		t.Fatal("expected Commit on success")
	}
}
