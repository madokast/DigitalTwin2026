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
	execSQL  []string
	execArgs [][]any
	row      *fakeRow
	rowsAff  int64
	execErr  error
}

func (f *fakeExecutor) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
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
func (f *fakeExecutor) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("Query not used")
}

func TestFindByIDNotFound(t *testing.T) {
	r := New(&fakeExecutor{row: &fakeRow{err: pgx.ErrNoRows}})
	res := r.FindByID(context.Background(), "01900000-0000-7000-8000-000000000003")
	if res.OK {
		t.Fatal("want not found")
	}
	if !errors.Is(res.Error, record.ErrNotFound) {
		t.Fatalf("err %v, want ErrNotFound", res.Error)
	}
}

func TestTransitionAffectedNotOne(t *testing.T) {
	f := &fakeExecutor{rowsAff: 2}
	r := New(f)
	res := r.Transition(context.Background(), "id", []string{"todo:completed"})
	if res.OK {
		t.Fatal("want error for rowsAffected != 1")
	}
	if !strings.Contains(res.Error.Error(), "todo update affected 2 rows") {
		t.Fatalf("err %v", res.Error)
	}
	if len(f.execSQL) != 1 || !strings.Contains(f.execSQL[0], "UPDATE records SET tags") {
		t.Fatalf("sql %v", f.execSQL)
	}
}
