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
