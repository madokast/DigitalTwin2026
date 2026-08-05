// Package contract：用共享 openapi/fixtures + kin-openapi 锁 Go 与契约对齐。
// 无 DB、不发 Telegram；与 Vitest tests/openapi 共用同一套 fixture。
package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// faas/internal/contract → 仓库根
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

func loadDoc(t *testing.T) *openapi3.T {
	t.Helper()
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = true // openapi/ 多文件 $ref
	doc, err := loader.LoadFromFile(filepath.Join(repoRoot(t), "openapi", "openapi.yaml"))
	if err != nil {
		t.Fatalf("load openapi: %v", err)
	}
	// 不调用 doc.Validate：kin-openapi 对 OAS 3.1（如 schema examples）仍偏严；
	// 契约断言靠 Schema.VisitJSON + Redocly lint。
	return doc
}

func schema(t *testing.T, doc *openapi3.T, name string) *openapi3.Schema {
	t.Helper()
	ref, ok := doc.Components.Schemas[name]
	if !ok || ref == nil || ref.Value == nil {
		t.Fatalf("schema %s missing", name)
	}
	return ref.Value
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoRoot(t), "openapi", "fixtures", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return b
}

func visitJSON(t *testing.T, s *openapi3.Schema, data any) {
	t.Helper()
	if err := s.VisitJSON(data); err != nil {
		t.Fatalf("VisitJSON: %v\ndata=%v", err, data)
	}
}

func visitJSONExpectFail(t *testing.T, s *openapi3.Schema, data any) {
	t.Helper()
	if err := s.VisitJSON(data); err == nil {
		t.Fatalf("VisitJSON unexpectedly accepted: %v", data)
	}
}

func TestFixturesMatchSchemas(t *testing.T) {
	doc := loadDoc(t)
	cases := []struct {
		fixture string
		schema  string
	}{
		{"record-number-success.json", "RecordSuccess"},
		{"record-text-success.json", "RecordSuccess"},
		{"error-unauthorized.json", "Error"},
		{"error-value-number-type.json", "Error"},
		{"error-export-invalid-from.json", "Error"},
		{"error-export-limit.json", "Error"},
		{"error-export-from-not-found.json", "Error"},
		{"import-records-success.json", "ImportRecordsSuccess"},
		{"error-import-limits.json", "Error"},
		{"error-import-duplicate-id.json", "Error"},
		{"error-import-multipart.json", "Error"},
		{"error-import-non-file-part-too-large.json", "Error"},
		{"query-success.json", "QuerySuccess"},
		{"summary-success.json", "SummarySuccess"},
		{"transaction-summary-success.json", "TransactionSummarySuccess"},
		{"log-number-request-valid.json", "LogNumberRequest"},
		{"number-batch-success.json", "NumberBatchSuccess"},
		{"log-body-weight-request-valid.json", "LogBodyWeightRequest"},
		{"log-todo-request-valid.json", "LogTodoRequest"},
		{"record-todo-success.json", "TodoRecordSuccess"},
		{"log-todo-transition-request-valid.json", "LogTodoTransitionRequest"},
		{"todo-transition-success.json", "TodoTransitionSuccess"},
		{"log-text-request-valid.json", "LogTextRequest"},
		{"review-request-valid.json", "ReviewRequest"},
		{"error-invalid-cadence.json", "Error"},
		{"tags-success.json", "TagsSuccess"},
		{"rename-tags-request-valid.json", "RenameTagsRequest"},
		{"rename-tags-success.json", "RenameTagsSuccess"},
		{"telegram-probe-request.json", "TelegramProbeRequest"},
		{"telegram-probe-success.json", "SuccessOnly"},
		{"qqbot-probe-request.json", "QqbotProbeRequest"},
		{"qqbot-probe-success.json", "SuccessOnly"},
		{"db-probe-success.json", "DbProbeSuccess"},
		{"db-probe-missing-table.json", "DbProbeSuccess"},
		{"db-probe-error.json", "Error"},
		{"log-transaction-request-valid.json", "LogTransactionRequest"},
		{"transaction-batch-success.json", "TransactionBatchSuccess"},
	}
	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			var data any
			if err := json.Unmarshal(readFixture(t, tc.fixture), &data); err != nil {
				t.Fatal(err)
			}
			visitJSON(t, schema(t, doc, tc.schema), data)
		})
	}
}

func TestLogTransactionRequestRejectsEmptyAndNumberAmount(t *testing.T) {
	doc := loadDoc(t)
	for _, name := range []string{
		"log-transaction-request-empty-entries.json",
		"log-transaction-request-amount-number.json",
		"log-transaction-request-missing-type.json",
	} {
		t.Run(name, func(t *testing.T) {
			var data any
			if err := json.Unmarshal(readFixture(t, name), &data); err != nil {
				t.Fatal(err)
			}
			visitJSONExpectFail(t, schema(t, doc, "LogTransactionRequest"), data)
		})
	}
}

func TestLogNumberRequestRejectsJSONNumber(t *testing.T) {
	doc := loadDoc(t)
	var data any
	if err := json.Unmarshal(readFixture(t, "log-number-request-json-number.json"), &data); err != nil {
		t.Fatal(err)
	}
	visitJSONExpectFail(t, schema(t, doc, "LogNumberRequest"), data)
}

func TestLogBodyWeightRequestRejectsJSONNumber(t *testing.T) {
	doc := loadDoc(t)
	var data any
	if err := json.Unmarshal(readFixture(t, "log-body-weight-request-json-number.json"), &data); err != nil {
		t.Fatal(err)
	}
	visitJSONExpectFail(t, schema(t, doc, "LogBodyWeightRequest"), data)
}

func TestLogTodoRequestRejectsUnknownHappenedAt(t *testing.T) {
	doc := loadDoc(t)
	var data any
	if err := json.Unmarshal(readFixture(t, "log-todo-request-unknown-happened-at.json"), &data); err != nil {
		t.Fatal(err)
	}
	visitJSONExpectFail(t, schema(t, doc, "LogTodoRequest"), data)
}

func TestLogTodoTransitionRequestRejectsUnknownCreatedAt(t *testing.T) {
	doc := loadDoc(t)
	var data any
	if err := json.Unmarshal(readFixture(t, "log-todo-transition-request-unknown-created-at.json"), &data); err != nil {
		t.Fatal(err)
	}
	visitJSONExpectFail(t, schema(t, doc, "LogTodoTransitionRequest"), data)
}

func TestLogNumberRequestRejectsNoTzAndScientific(t *testing.T) {
	doc := loadDoc(t)
	for _, name := range []string{
		"log-number-request-no-tz.json",
		"log-number-request-scientific.json",
	} {
		t.Run(name, func(t *testing.T) {
			var data any
			if err := json.Unmarshal(readFixture(t, name), &data); err != nil {
				t.Fatal(err)
			}
			visitJSONExpectFail(t, schema(t, doc, "LogNumberRequest"), data)
		})
	}
}

func TestRecordRejectsNumericNumericValue(t *testing.T) {
	doc := loadDoc(t)
	bad := map[string]any{
		"id":                       "01900000-0000-7000-8000-000000000001",
		"happened_at":               "2026-07-30T00:00:00.000Z",
		"numeric_value":              75.5,
		"raw_content":                nil,
		"tags":                     `["weight"]`,
		"objective_context":         "x",
		"ai_analysis": nil,
	}
	visitJSONExpectFail(t, schema(t, doc, "Record"), bad)
}

func TestGoFromDBMatchesNumberSuccessFixture(t *testing.T) {
	doc := loadDoc(t)
	raw := readFixture(t, "record-number-success.json")
	var fixture struct {
		Success bool           `json:"success"`
		Record  record.Record  `json:"record"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}

	vn := "75.5"
	subj := "a bit heavy"
	got := record.FromDB(
		fixture.Record.ID,
		time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC),
		"+08:00",
		&vn,
		nil,
		`["weight"]`,
		"morning weigh-in",
		&subj,
	)
	if got.HappenedAt != fixture.Record.HappenedAt {
		t.Fatalf("happenedAt: got %q want %q", got.HappenedAt, fixture.Record.HappenedAt)
	}
	if got.NumericValue == nil || *got.NumericValue != "75.5" {
		t.Fatalf("numericValue: %#v", got.NumericValue)
	}
	if got.HappenedAt != "2026-07-30T08:00:00.000+08:00" {
		t.Fatalf("happenedAt format: %q", got.HappenedAt)
	}

	body := map[string]any{"success": true, "record": mustJSONObj(t, got)}
	visitJSON(t, schema(t, doc, "RecordSuccess"), body)
}

func mustJSONObj(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}
