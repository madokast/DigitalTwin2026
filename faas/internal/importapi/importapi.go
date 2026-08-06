// Package importapi：Records 导入（与 Next `src/lib/importapi.ts` 同构）。
//
// POST /api/admin/import/records：multipart file（≤4MiB 有界读入）→ 逐行 parse
// （recordjsonl）→ 单事务 upsert；可写保留 tag（不调 AssertNoReservedTags）。
// 成功 commit 且 200 写出后再 Notify；失败 rollback、不 Notify。勿接 readBody。
package importapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordjsonl"
)

// MaxImportLines 非空行上限（与 Next MAX_IMPORT_LINES 对齐）。
const MaxImportLines = 1000

// MaxImportFileBytes file part 原始字节上限 4 MiB。
const MaxImportFileBytes = 4 * 1024 * 1024

// ErrImportLimitsError 与 Next IMPORT_LIMITS_ERROR 同文案。
var ErrImportLimitsError = errors.New("import exceeds limits (max 1000 lines or 4 MiB); split the file")

// ErrMultipartRequired 与 Next MULTIPART_FILE_REQUIRED 同文案。
var ErrMultipartRequired = errors.New(`multipart form field "file" is required`)

// ErrMultipartMultipleFile 与 Next MULTIPART_MULTIPLE_FILE 同文案。
var ErrMultipartMultipleFile = errors.New(`multipart must contain exactly one "file" part`)

// ErrMultipartContentType 与 Next MULTIPART_CONTENT_TYPE 同文案。
var ErrMultipartContentType = errors.New("expected Content-Type multipart/form-data")

// ErrUnsupportedFileContentType 与 Next UNSUPPORTED_FILE_CONTENT_TYPE 同文案。
var ErrUnsupportedFileContentType = errors.New(
	"unsupported file Content-Type; use application/x-ndjson, application/jsonl, or application/octet-stream with a .jsonl filename",
)

// ErrMultipartPartTooLarge 非 file part 丢弃超限（与 MaxImportFileBytes 同量级）。
var ErrMultipartPartTooLarge = errors.New(
	"multipart non-file part exceeds size limit (max 4 MiB)",
)

// Counts 成功计数（与 Next ImportCounts 对齐）。
type Counts struct {
	Inserted int
	Updated  int
	Total    int
}

// FormatDuplicateIDError 重复 id 错误文案（含 uuid + 可选行号）。
func FormatDuplicateIDError(id string, lineNumber int) string {
	return recordjsonl.FormatLineError(fmt.Sprintf("duplicate record id %s", id), lineNumber)
}

// FormatImportNotifyMessage 导入成功 Notify 文案（含全 0）。
func FormatImportNotifyMessage(c Counts) string {
	return fmt.Sprintf("Imported %d records (inserted %d, updated %d)", c.Total, c.Inserted, c.Updated)
}

// IsAcceptedImportFilePart 校验 file part Content-Type / 文件名。
// 空 type + .jsonl 文件名按 octet-stream 接受（与部分运行时一致）。
func IsAcceptedImportFilePart(contentType, filename string) bool {
	ct := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if ct == "application/x-ndjson" || ct == "application/jsonl" {
		return true
	}
	name := strings.ToLower(filename)
	if ct == "application/octet-stream" || ct == "" {
		return strings.HasSuffix(name, ".jsonl")
	}
	return false
}

// ImportRecordsJSONL 读 file part（≤4MiB）后单事务逐行 upsert。
// 不把整文件解析成 []Record；空内容 → 全 0。
func ImportRecordsJSONL(ctx context.Context, pool *pgxpool.Pool, r io.Reader) (Counts, *myerr.MyError) {
	raw, err := io.ReadAll(io.LimitReader(r, int64(MaxImportFileBytes)+1))
	if err != nil {
		return Counts{}, myerr.NewInternal(err)
	}
	if len(raw) > MaxImportFileBytes {
		return Counts{}, myerr.NewValidation(ErrImportLimitsError.Error())
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return Counts{}, myerr.NewInternal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	counts, me := importTextInTx(ctx, tx, string(raw))
	if me != nil {
		return Counts{}, me
	}
	if err := tx.Commit(ctx); err != nil {
		return Counts{}, myerr.NewInternal(err)
	}
	return counts, nil
}

// ImportRecordsJSONLTx 同语义，使用已有 tx（单测注入假 tx / 真实 tx）。
func ImportRecordsJSONLTx(ctx context.Context, tx pgx.Tx, text string, fileBytes int) (Counts, *myerr.MyError) {
	if fileBytes > MaxImportFileBytes {
		return Counts{}, myerr.NewValidation(ErrImportLimitsError.Error())
	}
	return importTextInTx(ctx, tx, text)
}

func importTextInTx(ctx context.Context, tx pgx.Tx, text string) (Counts, *myerr.MyError) {
	var (
		inserted, updated int
		seen              = make(map[string]struct{})
		physicalLine      int
		nonEmpty          int
	)

	var lines []string
	if text != "" {
		lines = strings.Split(text, "\n")
	}

	for _, raw := range lines {
		physicalLine++
		line := strings.TrimSuffix(raw, "\r")
		if physicalLine == 1 {
			line = strings.TrimPrefix(line, "\ufeff")
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		nonEmpty++
		if nonEmpty > MaxImportLines {
			return Counts{}, myerr.NewValidation(ErrImportLimitsError.Error())
		}

		row, err := recordjsonl.ParseLine(line, physicalLine)
		if err != nil {
			return Counts{}, myerr.NewValidation(err.Error())
		}
		if _, ok := seen[row.ID]; ok {
			return Counts{}, myerr.NewValidation(FormatDuplicateIDError(row.ID, physicalLine))
		}
		seen[row.ID] = struct{}{}

		exists, me := rowExists(ctx, tx, row.ID)
		if me != nil {
			return Counts{}, me
		}
		if exists {
			if err := updateRow(ctx, tx, row); err != nil {
				return Counts{}, myerr.NewInternal(err)
			}
			updated++
		} else {
			if err := insertRow(ctx, tx, row); err != nil {
				return Counts{}, myerr.NewInternal(err)
			}
			inserted++
		}
	}

	return Counts{
		Inserted: inserted,
		Updated:  updated,
		Total:    inserted + updated,
	}, nil
}

func rowExists(ctx context.Context, q interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, id string) (bool, *myerr.MyError) {
	var exists bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM records WHERE id = $1)`, id).Scan(&exists)
	if err != nil {
		return exists, myerr.NewInternal(err)
	}
	return exists, nil
}

func insertRow(ctx context.Context, tx pgx.Tx, row *recordjsonl.Row) error {
	tagsJSON, err := record.TagsJSON(row.Tags)
	if err != nil {
		return myerr.NewInternal(err)
	}
	_, err = tx.Exec(ctx, `
INSERT INTO records (id, happened_at, utc_offset, numeric_value, raw_content, tags, objective_context, ai_analysis)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)
`, row.ID, row.HappenedAt, row.UtcOffset, row.NumericValue, row.RawContent, tagsJSON, row.ObjectiveContext, row.AiAnalysis)
	if err != nil {
		return myerr.NewInternal(err)
	}
	return nil
}

func updateRow(ctx context.Context, tx pgx.Tx, row *recordjsonl.Row) error {
	tagsJSON, err := record.TagsJSON(row.Tags)
	if err != nil {
		return myerr.NewInternal(err)
	}
	_, err = tx.Exec(ctx, `
UPDATE records SET
  happened_at = $1,
  utc_offset = $2,
  numeric_value = $3,
  raw_content = $4,
  tags = $5,
  objective_context = $6,
  ai_analysis = $7
WHERE id = $8
`, row.HappenedAt, row.UtcOffset, row.NumericValue, row.RawContent, tagsJSON, row.ObjectiveContext, row.AiAnalysis, row.ID)
	if err != nil {
		return myerr.NewInternal(err)
	}
	return nil
}
