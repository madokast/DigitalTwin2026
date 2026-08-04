package dbprobe

import (
	"context"
	"errors"
	"os"
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
	url := db.TestDatabaseURL(t)
	// Probe 从传入的 env 函数读 DATABASE_URL；.env.test 自动加载只作用于门闸，须显式注入
	t.Setenv("DATABASE_URL", url)
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

// D8：连接超时须与 Next connect_timeout:15 对齐（防不可达 DB 时双端等待时长分叉）。
func TestConnectTimeoutValue(t *testing.T) {
	if ConnectTimeout != 15*time.Second {
		t.Fatalf("ConnectTimeout=%v, want 15s (Next connect_timeout)", ConnectTimeout)
	}
}

// 实测：不可达地址连接在 ConnectTimeout 内失败（不依赖 OS TCP 超时）。
func TestProbeUnreachableBoundedByConnectTimeout(t *testing.T) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := connectWithTimeout(ctx, "postgresql://u:p@10.255.255.1:5432/db?sslmode=disable")
	if err == nil {
		t.Fatal("expected connect error for unroutable host")
	}
	if elapsed := time.Since(start); elapsed > 20*time.Second {
		t.Fatalf("connect took %v; ConnectTimeout=%v not honored", elapsed, ConnectTimeout)
	}
}
