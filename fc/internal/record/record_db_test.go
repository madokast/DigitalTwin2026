package record

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mdk/digitaltwin2026/fc/internal/draft"
)

// ---- 假 Querier / Row（断言 SQL + RETURNING 映射，不依赖真实 Neon）----

type fakeUpdateQuerier struct {
	sql      string
	args     []any
	scanVals []any
	scanErr  error
}

func (f *fakeUpdateQuerier) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("Query not used by Update")
}

func (f *fakeUpdateQuerier) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("Exec not used by Update")
}

func (f *fakeUpdateQuerier) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	f.sql = sql
	f.args = append([]any{}, args...)
	return &fakeRow{vals: f.scanVals, err: f.scanErr}
}

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

func sampleDraft() *draft.NormalizedRecordDraft {
	num := "80.0"
	return &draft.NormalizedRecordDraft{
		HappenedAt:               time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC),
		ValueNumber:              &num,
		ValueText:                nil,
		Tags:                     []string{"weight"},
		ObjectiveContext:         "morning",
		SubjectiveInterpretation: nil,
	}
}

func TestUpdate_successMapsReturning(t *testing.T) {
	outNum := "80.0"
	happened := time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC)
	q := &fakeUpdateQuerier{
		scanVals: []any{
			"01900000-0000-7000-8000-000000000001",
			happened,
			outNum,
			nil,
			`["weight"]`,
			"morning",
			nil,
		},
	}
	rec, status, err := Update(context.Background(), q, "01900000-0000-7000-8000-000000000001", sampleDraft())
	if err != nil {
		t.Fatal(err)
	}
	if status != 200 {
		t.Fatalf("status=%d want 200", status)
	}
	if !strings.Contains(q.sql, "UPDATE records SET") || !strings.Contains(q.sql, "RETURNING") {
		t.Fatalf("unexpected QueryRow SQL: %q", q.sql)
	}
	if rec.ID != "01900000-0000-7000-8000-000000000001" {
		t.Fatalf("id=%s", rec.ID)
	}
	if rec.HappenedAt != "2026-07-30T10:00:00.000Z" {
		t.Fatalf("happenedAt=%s", rec.HappenedAt)
	}
	if rec.ValueNumber == nil || *rec.ValueNumber != "80.0" {
		t.Fatalf("valueNumber=%v", rec.ValueNumber)
	}
	if rec.Tags != `["weight"]` || rec.ObjectiveContext != "morning" {
		t.Fatalf("rec=%+v", rec)
	}
	// args: happenedAt, valueNumber, valueText, tagsJSON, objective, subjective, id
	if len(q.args) != 7 {
		t.Fatalf("args len=%d want 7", len(q.args))
	}
	if q.args[3] != `["weight"]` {
		t.Fatalf("tags arg=%v", q.args[3])
	}
	if q.args[6] != "01900000-0000-7000-8000-000000000001" {
		t.Fatalf("id arg=%v", q.args[6])
	}
}

func TestUpdate_notFound(t *testing.T) {
	q := &fakeUpdateQuerier{scanErr: pgx.ErrNoRows}
	rec, status, err := Update(context.Background(), q, "missing-id", sampleDraft())
	if status != 404 {
		t.Fatalf("status=%d want 404", status)
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err=%v want ErrNotFound", err)
	}
	if err.Error() != "Record not found" {
		t.Fatalf("error message %q", err.Error())
	}
	if rec.ID != "" {
		t.Fatalf("expected empty record, got %+v", rec)
	}
}
