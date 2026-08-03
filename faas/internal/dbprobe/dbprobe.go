// 短命 DB 探测：独立连接测 connect / 两次 select 1 / public.records。
// 与 Next src/lib/dbprobe 同构；不查 __drizzle_migrations。
package dbprobe

import (
	"context"
	"math"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	DatabaseURLNotSet  = "DATABASE_URL is not set"
	DatabaseUnreachable = "Database unreachable"
)

// Result 成功探测体（HTTP 200）；ok = reachable ∧ records 存在。
type Result struct {
	Ok                   bool    `json:"ok"`
	DatabaseReachable    bool    `json:"database_reachable"`
	RecordsTableExists   bool    `json:"records_table_exists"`
	ConnectMs            float64 `json:"connect_ms"`
	Select1FirstMs       float64 `json:"select1_first_ms"`
	Select1SecondMs      float64 `json:"select1_second_ms"`
}

func roundMs(d time.Duration) float64 {
	ms := float64(d) / float64(time.Millisecond)
	return math.Round(ms*10) / 10
}

// SanitizeProbeError 错误文案不得回显连接串。
func SanitizeProbeError(_ error) string {
	return DatabaseUnreachable
}

type connectFunc func(ctx context.Context, connString string) (*pgx.Conn, error)

// Probe 打开短命连接并测三段延迟。失败时返回 status=503 与英文 error。
func Probe(ctx context.Context, getenv func(string) string) (result Result, status int, errMsg string) {
	return probeWith(ctx, getenv, pgx.Connect)
}

func probeWith(ctx context.Context, getenv func(string) string, connect connectFunc) (Result, int, string) {
	if getenv == nil {
		getenv = os.Getenv
	}
	url := strings.TrimSpace(getenv("DATABASE_URL"))
	if url == "" {
		return Result{}, 503, DatabaseURLNotSet
	}

	t0 := time.Now()
	conn, err := connect(ctx, url)
	if err != nil {
		return Result{}, 503, SanitizeProbeError(err)
	}
	connectMs := roundMs(time.Since(t0))
	defer conn.Close(ctx)

	t1 := time.Now()
	if _, err := conn.Exec(ctx, "select 1"); err != nil {
		return Result{}, 503, SanitizeProbeError(err)
	}
	select1FirstMs := roundMs(time.Since(t1))

	t2 := time.Now()
	if _, err := conn.Exec(ctx, "select 1"); err != nil {
		return Result{}, 503, SanitizeProbeError(err)
	}
	select1SecondMs := roundMs(time.Since(t2))

	var reg *string
	if err := conn.QueryRow(ctx, "select to_regclass('public.records')::text").Scan(&reg); err != nil {
		return Result{}, 503, SanitizeProbeError(err)
	}
	recordsExists := reg != nil && *reg != ""

	return Result{
		Ok:                 recordsExists,
		DatabaseReachable:  true,
		RecordsTableExists: recordsExists,
		ConnectMs:          connectMs,
		Select1FirstMs:     select1FirstMs,
		Select1SecondMs:    select1SecondMs,
	}, 200, ""
}
