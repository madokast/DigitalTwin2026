// Package exportapi：Records 导出（与 Next `src/lib/exportapi.ts` 同构）。
//
// GET /api/export/records：解析 from?/limit、按 id ASC LIMIT 拉取、有界组 NDJSON /
// Content-Disposition 文件名 / Notify 文案。HTTP 层负责响应头与 notify 调度
// （写出成功后再 Notify）。本路由无 JSON body，勿接 readBody。
package exportapi

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordjsonl"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
)

// ErrExportLimitError 与 Next EXPORT_LIMIT_ERROR 同文案（数据/格式问题 → 400）。
const ErrExportLimitError = "limit must be an integer between 1 and 1000"

// ErrExportFromNotFound 与 Next EXPORT_FROM_NOT_FOUND 同文案（文案常量）。
const ErrExportFromNotFound = "export from id not found"

var digitsOnly = regexp.MustCompile(`^\d+$`)

// ParsedExport 与 Next ParsedExport 对齐；From 空串 = 从表中最小 id 起。
type ParsedExport struct {
	From  string
	Limit int
}

func parseRequiredLimit(raw string) (int, *myerr.MyError) {
	if raw == "" || !digitsOnly.MatchString(raw) {
		return 0, myerr.NewValidation(ErrExportLimitError)
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 1000 {
		return 0, myerr.NewValidation(ErrExportLimitError)
	}
	// 与 Next Number.MAX_SAFE_INTEGER 对齐
	const maxSafeInt = 9007199254740991
	if n > maxSafeInt {
		return 0, myerr.NewValidation(ErrExportLimitError)
	}
	return n, nil
}

// ParseExportRecordsParams 解析导出 query；失败可映射为 400。
// ParseExportRecordsParams 校验导出参数（400 类 myerr）；from 不存在由 FetchExportRecords 返 404。
func ParseExportRecordsParams(q url.Values) (*ParsedExport, *myerr.MyError) {
	limit, me := parseRequiredLimit(q.Get("limit"))
	if me != nil {
		return nil, me
	}
	from := q.Get("from")
	if from == "" {
		return &ParsedExport{From: "", Limit: limit}, nil
	}
	if !record.IsValidID(from) {
		return nil, myerr.NewValidation(record.ErrInvalidID)
	}
	return &ParsedExport{From: from, Limit: limit}, nil
}

const selectCols = `id, happened_at, utc_offset, numeric_value, raw_content, tags, objective_context, ai_analysis`

// FetchExportRecords keyset 游标导出（§10b 步骤 3 定案：Exists 404 + FindByCriteria.IDFrom）。
// from 不存在 → myerr 404；无 from → 全表 id ASC LIMIT。
func FetchExportRecords(ctx context.Context, pool *pgxpool.Pool, p *ParsedExport) ([]record.Record, *myerr.MyError) {
	if p.From != "" {
		exists, me := recordrepo.Repo.Exists(ctx, pool, p.From)
		if me != nil {
			return nil, me
		}
		if !exists {
			return nil, myerr.NewNotFound(ErrExportFromNotFound)
		}
	}

	return recordrepo.Repo.FindByCriteria(ctx, pool, recordrepo.FindCriteria{
		Criteria:  recordrepo.Criteria{IDFrom: p.From},
		Page:      1,
		PageSize:  p.Limit,
		SortBy:    "id",
		SortOrder: "asc",
	})
}

// BuildExportNdjson 每行一条 Record JSON + 换行；0 行 → 空字符串。
func BuildExportNdjson(recs []record.Record) (string, *myerr.MyError) {
	if len(recs) == 0 {
		return "", nil
	}
	var b strings.Builder
	for _, rec := range recs {
		line, err := recordjsonl.SerializeRecord(rec)
		if err != nil {
			return "", myerr.NewInternal(err)
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String(), nil
}

// ExportFilename：records-from-{uuid|start}-limit-{n}-{YYYYMMDDTHHMMSSZ}.jsonl
func ExportFilename(from string, limit int, now time.Time) string {
	cursor := from
	if cursor == "" {
		cursor = "start"
	}
	ts := now.UTC().Format("20060102T150405Z")
	return fmt.Sprintf("records-from-%s-limit-%d-%s.jsonl", cursor, limit, ts)
}

// FormatExportNotifyMessage 导出成功 Notify 文案（含 0 行）。
func FormatExportNotifyMessage(count int, from string, limit int) string {
	cursor := from
	if cursor == "" {
		cursor = "start"
	}
	return fmt.Sprintf("Exported %d records (from %s, limit %d)", count, cursor, limit)
}

// ExportContentDisposition Content-Disposition 值。
func ExportContentDisposition(from string, limit int, now time.Time) string {
	return fmt.Sprintf(`attachment; filename="%s"`, ExportFilename(from, limit, now))
}
