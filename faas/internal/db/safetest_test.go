package db_test

import (
	"strings"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/db"
)

func TestAssertSafeTestDatabaseURL(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		url     string
		wantErr string // 子串；空表示须通过
	}{
		{
			name: "hostname containing test",
			url:  "postgresql://u:p@db-test.example.com/appdb",
		},
		{
			name: "database name containing test",
			url:  "postgresql://u:p@ep-long-pine.example.com/my_test_db",
		},
		{
			name: "TestDigitalTwin in database name",
			url:  "postgresql://u:p@ep.example.com/TestDigitalTwin",
		},
		{
			name:    "production-looking URL",
			url:     "postgresql://u:p@db.example.com/proddb",
			wantErr: `must contain "test"`,
		},
		{
			name:    "username test alone is not enough",
			url:     "postgresql://testuser:p@db.example.com/proddb",
			wantErr: `must contain "test"`,
		},
		{
			name:    "empty",
			url:     "  ",
			wantErr: "empty",
		},
		{
			name:    "invalid URL",
			url:     "not-a-url",
			wantErr: "valid URL",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := db.AssertSafeTestDatabaseURL(tc.url)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q", tc.wantErr)
			}
			if !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tc.wantErr)) {
				t.Fatalf("error %q does not contain %q", err.Error(), tc.wantErr)
			}
		})
	}
}
