package db

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeTx 可控事务：记录 Commit/Rollback 调用，满足自定义 Tx（5 方法）。
type fakeTx struct {
	committed  bool
	rolledBack bool
}

func (f *fakeTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return nil
}
func (f *fakeTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}
func (f *fakeTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return nil, nil
}
func (f *fakeTx) Commit(ctx context.Context) error {
	f.committed = true
	return nil
}
func (f *fakeTx) Rollback(ctx context.Context) error {
	f.rolledBack = true
	return nil
}

// fakeBeginner 可控事务起点：beginErr 非 nil 时 Begin 失败；否则返回预置 tx。
type fakeBeginner struct {
	beginErr error
	tx       *fakeTx
}

func (f *fakeBeginner) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return nil
}
func (f *fakeBeginner) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}
func (f *fakeBeginner) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return nil, nil
}
func (f *fakeBeginner) Begin(ctx context.Context) (Tx, error) {
	if f.beginErr != nil {
		return nil, f.beginErr
	}
	return f.tx, nil
}

func TestUoWDoCommitsOnNilError(t *testing.T) {
	tx := &fakeTx{}
	u := &UoW{pool: &fakeBeginner{tx: tx}}

	fnCalled := false
	err := u.Do(context.Background(), func(q Executor) error {
		fnCalled = true
		if q == nil {
			t.Fatalf("fn received nil executor")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Do error: %v", err)
	}
	if !fnCalled {
		t.Fatalf("fn not called")
	}
	if !tx.committed {
		t.Fatalf("expected Commit on nil error")
	}
}

func TestUoWDoRollsBackOnError(t *testing.T) {
	tx := &fakeTx{}
	u := &UoW{pool: &fakeBeginner{tx: tx}}

	wantErr := errors.New("injected failure")
	err := u.Do(context.Background(), func(q Executor) error {
		return wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("Do error %v, want %v", err, wantErr)
	}
	if tx.committed {
		t.Fatalf("unexpected Commit after fn error")
	}
	if !tx.rolledBack {
		t.Fatalf("expected Rollback after fn error")
	}
}

func TestUoWDoBeginFailureSkipsFn(t *testing.T) {
	beginErr := errors.New("begin failed")
	u := &UoW{pool: &fakeBeginner{beginErr: beginErr}}

	fnCalled := false
	err := u.Do(context.Background(), func(q Executor) error {
		fnCalled = true
		return nil
	})
	if !errors.Is(err, beginErr) {
		t.Fatalf("Do error %v, want %v", err, beginErr)
	}
	if fnCalled {
		t.Fatalf("fn should not be called when Begin fails")
	}
}
