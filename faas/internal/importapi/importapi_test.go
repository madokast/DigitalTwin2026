package importapi_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mdk/digitaltwin2026/faas/internal/importapi"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

func TestFormatImportNotifyAndDuplicate(t *testing.T) {
	got := importapi.FormatImportNotifyMessage(record.ImportCounts{Inserted: 12, Updated: 3, Total: 15})
	if got != "Imported 15 records (inserted 12, updated 3)" {
		t.Fatalf("notify %q", got)
	}
	zero := importapi.FormatImportNotifyMessage(record.ImportCounts{})
	if zero != "Imported 0 records (inserted 0, updated 0)" {
		t.Fatalf("zero notify %q", zero)
	}
	id := "01900000-0000-7000-8000-000000000001"
	dup := importapi.FormatDuplicateIDError(id, 2)
	want := "line 2: duplicate record id " + id
	if dup != want {
		t.Fatalf("dup %q want %q", dup, want)
	}
}

func TestIsAcceptedImportFilePart(t *testing.T) {
	cases := []struct {
		ct, name string
		ok       bool
	}{
		{"application/x-ndjson", "x.bin", true},
		{"application/jsonl; charset=utf-8", "x", true},
		{"application/octet-stream", "records.JSONL", true},
		{"application/octet-stream", "records.txt", false},
		{"text/plain", "records.jsonl", false},
	}
	for _, tc := range cases {
		if importapi.IsAcceptedImportFilePart(tc.ct, tc.name) != tc.ok {
			t.Fatalf("%q %q → want %v", tc.ct, tc.name, tc.ok)
		}
	}
}

func TestImportLimitsConstant(t *testing.T) {
	if importapi.MaxImportLines != 1000 {
		t.Fatalf("lines %d", importapi.MaxImportLines)
	}
	if importapi.MaxImportFileBytes != 4*1024*1024 {
		t.Fatalf("bytes %d", importapi.MaxImportFileBytes)
	}
	if !strings.Contains(importapi.ErrImportLimitsError, "split the file") {
		t.Fatalf("limits msg %v", importapi.ErrImportLimitsError)
	}
}

// ---- importTextInTx 两分支 fake（Exists → Update / Save）----

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
		case *bool:
			*p = r.vals[i].(bool)
		default:
			return errors.New("unsupported scan dest type")
		}
	}
	return nil
}

type importFakeTx struct {
	rows    []*fakeRow // QueryRow 返回序列（Exists false 行 + Save RETURNING 行）
	rowIdx  int
	execSQL []string
	execErr error
}

func (t *importFakeTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if t.rowIdx < len(t.rows) {
		r := t.rows[t.rowIdx]
		t.rowIdx++
		return r
	}
	return &fakeRow{}
}
func (t *importFakeTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	t.execSQL = append(t.execSQL, sql)
	if t.execErr != nil {
		return pgconn.CommandTag{}, t.execErr
	}
	return pgconn.CommandTag{}, nil
}
func (t *importFakeTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("Query not used by import")
}
func (t *importFakeTx) Commit(context.Context) error   { return nil }
func (t *importFakeTx) Rollback(context.Context) error { return nil }

func saveReturnRow(id string) *fakeRow {
	return &fakeRow{vals: []any{
		id,
		time.Date(2026, 8, 1, 4, 0, 0, 0, time.UTC),
		"+08:00",
		"12.34",
		"raw",
		"obj",
		"ai",
		`["work"]`,
	}}
}

func TestImportRecordsJSONLTxInsertThenUpdate(t *testing.T) {
	tx := &importFakeTx{
		rows: []*fakeRow{
			&fakeRow{vals: []any{false}},                          // 行 1 Exists → false
			saveReturnRow("01900000-0000-7000-8000-000000000001"), // 行 1 Save RETURNING
			&fakeRow{vals: []any{true}},                           // 行 2 Exists → true
		},
	}
	text := `{"id":"01900000-0000-7000-8000-000000000001","happened_at":"2026-08-01T12:00:00+08:00","raw_content":"raw","objective_context":"obj","ai_analysis":null,"tags":["work"]}` + "\n" +
		`{"id":"01900000-0000-7000-8000-000000000002","happened_at":"2026-08-01T12:00:00+08:00","raw_content":"raw","objective_context":"obj","ai_analysis":null,"tags":["work"]}`
	counts, me := importapi.ImportRecordsJSONLTx(context.Background(), tx, text, 0)
	if me != nil {
		t.Fatal(me)
	}
	if counts.Inserted != 1 || counts.Updated != 1 || counts.Total != 2 {
		t.Fatalf("counts=%+v want inserted 1 updated 1 total 2", counts)
	}
	if len(tx.execSQL) != 1 || !strings.Contains(tx.execSQL[0], "UPDATE records SET") {
		t.Fatalf("expected 1 UPDATE Exec, got %v", tx.execSQL)
	}
}

func TestImportRecordsJSONLTxExistsErrorRollsBack(t *testing.T) {
	tx := &importFakeTx{
		rows: []*fakeRow{{err: errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`)}},
	}
	text := `{"id":"01900000-0000-7000-8000-000000000001","happened_at":"2026-08-01T12:00:00+08:00","raw_content":"raw","objective_context":"obj","ai_analysis":null,"tags":["work"]}`
	_, me := importapi.ImportRecordsJSONLTx(context.Background(), tx, text, 0)
	if me == nil || me.Status != 500 {
		t.Fatalf("me=%v want 500", me)
	}
}

func TestImportRecordsJSONLTxUpdateError(t *testing.T) {
	tx := &importFakeTx{
		rows:    []*fakeRow{{vals: []any{true}}},
		execErr: errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`),
	}
	text := `{"id":"01900000-0000-7000-8000-000000000001","happened_at":"2026-08-01T12:00:00+08:00","raw_content":"raw","objective_context":"obj","ai_analysis":null,"tags":["work"]}`
	_, me := importapi.ImportRecordsJSONLTx(context.Background(), tx, text, 0)
	if me == nil || me.Status != 500 {
		t.Fatalf("me=%v want 500", me)
	}
}
