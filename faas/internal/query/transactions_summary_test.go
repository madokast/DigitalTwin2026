package query

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// faas/internal/query → 仓库根
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

type sharedSummaryCases struct {
	Cases []struct {
		Name     string             `json:"name"`
		From     string             `json:"from"`
		To       string             `json:"to"`
		Rows     []sharedSummaryRow `json:"rows"`
		Expected json.RawMessage    `json:"expected"`
	} `json:"cases"`
	ParseErrors []struct {
		Name  string            `json:"name"`
		Query map[string]string `json:"query"`
		Error string            `json:"error"`
	} `json:"parse_errors"`
}

type sharedSummaryRow struct {
	Tags         string  `json:"tags"`
	NumericValue *string `json:"numeric_value"`
}

func loadTransactionsSummaryCases(t *testing.T) sharedSummaryCases {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoRoot(t), "testdata", "transaction-summary-cases.json"))
	if err != nil {
		t.Fatalf("read transaction-summary-cases: %v", err)
	}
	var cases sharedSummaryCases
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatalf("parse transaction-summary-cases: %v", err)
	}
	return cases
}

func TestParseTransactionsSummaryParamsSharedFixtures(t *testing.T) {
	cases := loadTransactionsSummaryCases(t)
	for _, tc := range cases.ParseErrors {
		t.Run(tc.Name, func(t *testing.T) {
			q := url.Values{}
			for k, v := range tc.Query {
				q.Set(k, v)
			}
			_, err := ParseTransactionsSummaryParams(q)
			if err == nil || err.Message != tc.Error {
				t.Fatalf("got %v want %q", err, tc.Error)
			}
		})
	}

	t.Run("accepts-valid", func(t *testing.T) {
		q := url.Values{}
		q.Set("from", "2026-07-01T00:00:00+08:00")
		q.Set("to", "2026-08-01T00:00:00+08:00")
		p, err := ParseTransactionsSummaryParams(q)
		if err != nil {
			t.Fatal(err)
		}
		if p.FromRaw != "2026-07-01T00:00:00+08:00" || p.ToRaw != "2026-08-01T00:00:00+08:00" {
			t.Fatalf("%+v", p)
		}
		if !p.From.Before(p.To) {
			t.Fatal("from should be before to")
		}
	})
}

func TestAggregateTransactionsSummarySharedFixtures(t *testing.T) {
	cases := loadTransactionsSummaryCases(t)
	money2 := regexp.MustCompile(`^-?(?:0|[1-9]\d*)\.\d{2}$`)

	for _, tc := range cases.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			acc := newTxSummaryAcc()
			for _, r := range tc.Rows {
				var tagList []string
				if err := json.Unmarshal([]byte(r.Tags), &tagList); err != nil {
					t.Fatalf("%s: fixture tags %q not a JSON array: %v", tc.Name, r.Tags, err)
				}
				if me := acc.addRow(tagList, r.NumericValue); me != nil {
					t.Fatal(me)
				}
			}
			got := acc.finalize(tc.From, tc.To)
			gotJSON, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var gotObj, wantObj any
			if err := json.Unmarshal(gotJSON, &gotObj); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(tc.Expected, &wantObj); err != nil {
				t.Fatal(err)
			}
			gotNorm, _ := json.Marshal(gotObj)
			wantNorm, _ := json.Marshal(wantObj)
			if string(gotNorm) != string(wantNorm) {
				t.Fatalf("mismatch\ngot  %s\nwant %s", gotNorm, wantNorm)
			}

			if !money2.MatchString(got.Income.Sum) || !money2.MatchString(got.Expense.Sum) || !money2.MatchString(got.Net) {
				t.Fatalf("money format: income=%q expense=%q net=%q", got.Income.Sum, got.Expense.Sum, got.Net)
			}
			for _, cat := range append(got.IncomeCategories, got.ExpenseCategories...) {
				if !money2.MatchString(cat.Sum) {
					t.Fatalf("cat sum %q", cat.Sum)
				}
				for _, sub := range cat.Subcategories {
					if !money2.MatchString(sub.Sum) {
						t.Fatalf("sub sum %q", sub.Sum)
					}
				}
			}
		})
	}
}
