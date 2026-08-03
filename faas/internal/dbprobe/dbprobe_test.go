package dbprobe

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
)

func TestSanitizeProbeError(t *testing.T) {
	got := SanitizeProbeError(errors.New("postgresql://user:secret@host/db"))
	if got != DatabaseUnreachable {
		t.Fatalf("got %q", got)
	}
}

func TestProbeMissingURL(t *testing.T) {
	_, status, errMsg := probeWith(context.Background(), func(string) string { return "" }, nil)
	if status != 503 || errMsg != DatabaseURLNotSet {
		t.Fatalf("status=%d err=%q", status, errMsg)
	}
}

func TestProbeConnectFailure(t *testing.T) {
	_, status, errMsg := probeWith(
		context.Background(),
		func(string) string { return "postgresql://u:p@test-host/db" },
		func(context.Context, string) (*pgx.Conn, error) {
			return nil, errors.New("postgresql://secret boom")
		},
	)
	if status != 503 || errMsg != DatabaseUnreachable {
		t.Fatalf("status=%d err=%q", status, errMsg)
	}
}

// 有安全 DATABASE_URL 时真实连库；无则 Skip；unsafe 则 Fatal（与 httpx integration 一致）。
func TestProbeIntegration(t *testing.T) {
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping dbprobe integration. " + db.TestDatabaseURLHint)
	}
	if err := db.AssertSafeTestDatabaseURL(url); err != nil {
		t.Fatalf("%v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	res, status, errMsg := Probe(ctx, os.Getenv)
	if status != 200 {
		t.Fatalf("status=%d err=%q", status, errMsg)
	}
	if !res.DatabaseReachable {
		t.Fatal("expected reachable")
	}
	if res.ConnectMs < 0 || res.Select1FirstMs < 0 || res.Select1SecondMs < 0 {
		t.Fatalf("negative timings: %+v", res)
	}
}
