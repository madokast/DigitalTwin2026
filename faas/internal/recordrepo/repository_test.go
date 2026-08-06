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
	f := &fakeExecutor{row: &fakeRow{err: pgx.ErrNoRows}}
	res := Repo.FindByID(context.Background(), f, "01900000-0000-7000-8000-000000000003")
	if res.OK {
		t.Fatal("want not found")
	}
	if res.Error.Status != 404 {
		t.Fatalf("err %v, want myerr 404", res.Error)
	}
	if !strings.Contains(res.Error.Message, "not found") {
		t.Fatalf("msg %q", res.Error.Message)
	}
}

func TestFindByIDDriverErrorInternal(t *testing.T) {
	f := &fakeExecutor{row: &fakeRow{err: errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`)}}
	res := Repo.FindByID(context.Background(), f, "01900000-0000-7000-8000-000000000003")
	if res.OK {
		t.Fatal("want error")
	}
	if res.Error.Status != 500 {
		t.Fatalf("err %v, want myerr 500", res.Error)
	}
	if !strings.Contains(res.Error.Message, `ERROR: relation "records" does not exist (SQLSTATE 42P01)`) {
		t.Fatalf("driver message not embedded: %q", res.Error.Message)
	}
}

func TestTransitionAffectedNotOne(t *testing.T) {
	f := &fakeExecutor{rowsAff: 2}
	res := Repo.Transition(context.Background(), f, "id", []string{"todo:completed"})
	if res.OK {
		t.Fatal("want error for rowsAffected != 1")
	}
	if res.Error.Status != 500 {
		t.Fatalf("err %v, want myerr 500", res.Error)
	}
	if !strings.Contains(res.Error.Message, "todo update affected 2 rows") {
		t.Fatalf("err %v", res.Error)
	}
	if len(f.execSQL) != 1 || !strings.Contains(f.execSQL[0], "UPDATE records SET tags") {
		t.Fatalf("sql %v", f.execSQL)
	}
}
