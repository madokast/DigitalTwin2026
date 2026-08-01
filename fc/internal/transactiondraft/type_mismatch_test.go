package transactiondraft

import "testing"

func TestParseTransactionBatchTypeMismatchMessages(t *testing.T) {
	t.Parallel()
	cases := []struct {
		raw  string
		want string
	}{
		{`{"happened_at":"2026-07-30T08:00:00Z","type":123,"entries":[{"amount":"1","memo":"m","category":"food","subcategory":"lunch"}]}`, `type must be "income" or "expense"`},
		{`{"happened_at":"2026-07-30T08:00:00Z","type":"expense","entries":"x"}`, "Missing required field: entries (non-empty array)"},
	}
	for _, c := range cases {
		_, err := ParseTransactionBatch([]byte(c.raw))
		if err == nil || err.Error() != c.want {
			t.Fatalf("%s: err=%v want %q", c.raw, err, c.want)
		}
	}
}
