// Package importapi：Records 导入（与 Next `src/lib/importapi.ts` 同构）。
//
// POST /api/admin/import/records：multipart file（≤4MiB 有界读入）→ 逐行 parse
// （recordjsonl）→ 单事务 upsert；可写保留 tag（不调 AssertNoReservedTags）。
// 成功 commit 且 200 写出后再 Notify；失败 rollback、不 Notify。勿接 readBody。
package importapi

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordjsonl"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
)

// MaxImportLines 非空行上限（与 Next MAX_IMPORT_LINES 对齐）。
const MaxImportLines = 1000

// MaxImportFileBytes file part 原始字节上限 4 MiB。
const MaxImportFileBytes = 4 * 1024 * 1024

// ErrImportLimitsError 与 Next IMPORT_LIMITS_ERROR 同文案（文案常量，非哨兵）。
const ErrImportLimitsError = "import exceeds limits (max 1000 lines or 4 MiB); split the file"

// ErrMultipartRequired 与 Next MULTIPART_FILE_REQUIRED 同文案。
const ErrMultipartRequired = `multipart form field "file" is required`

// ErrMultipartMultipleFile 与 Next MULTIPART_MULTIPLE_FILE 同文案。
const ErrMultipartMultipleFile = `multipart must contain exactly one "file" part`

// ErrMultipartContentType 与 Next MULTIPART_CONTENT_TYPE 同文案。
const ErrMultipartContentType = "expected Content-Type multipart/form-data"

// ErrUnsupportedFileContentType 与 Next UNSUPPORTED_FILE_CONTENT_TYPE 同文案。
const ErrUnsupportedFileContentType = "unsupported file Content-Type; use application/x-ndjson, application/jsonl, or application/octet-stream with a .jsonl filename"

// ErrMultipartPartTooLarge 非 file part 丢弃超限（与 MaxImportFileBytes 同量级）。
const ErrMultipartPartTooLarge = "multipart non-file part exceeds size limit (max 4 MiB)"

// FormatDuplicateIDError 重复 id 错误文案（含 uuid + 可选行号）。
func FormatDuplicateIDError(id string, lineNumber int) string {
	return recordjsonl.FormatLineError(fmt.Sprintf("duplicate record id %s", id), lineNumber)
}

// FormatImportNotifyMessage 导入成功 Notify 文案（含全 0）。
func FormatImportNotifyMessage(c record.ImportCounts) string {
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
func ImportRecordsJSONL(ctx context.Context, pool *pgxpool.Pool, r io.Reader) (record.ImportCounts, *myerr.MyError) {
	raw, err := io.ReadAll(io.LimitReader(r, int64(MaxImportFileBytes)+1))
	if err != nil {
		return record.ImportCounts{}, myerr.NewInternal(err)
	}
	if len(raw) > MaxImportFileBytes {
		return record.ImportCounts{}, myerr.NewValidation(ErrImportLimitsError)
	}

	var counts record.ImportCounts
	me := db.WithTx(ctx, db.NewPoolTxBeginner(pool), func(q db.Executor) *myerr.MyError {
		c, me := importTextInTx(ctx, q, string(raw))
		if me != nil {
			return me
		}
		counts = c
		return nil
	})
	if me != nil {
		return record.ImportCounts{}, me
	}
	return counts, nil
}

// ImportRecordsJSONLTx 同语义，使用已有 tx（单测注入假 tx / 真实 tx）。
func ImportRecordsJSONLTx(ctx context.Context, tx db.Tx, text string, fileBytes int) (record.ImportCounts, *myerr.MyError) {
	if fileBytes > MaxImportFileBytes {
		return record.ImportCounts{}, myerr.NewValidation(ErrImportLimitsError)
	}
	return importTextInTx(ctx, tx, text)
}

// importTextInTx 逐行 upsert（§10b 步骤 2 定案）：Exists 判存在 →
// 有则 Update（repo 内 ParseHappenedAt 重解析）/ 无则 Save（insert 分支复用，忽略返回行）。
// 竞态语义保留：并发同 id → 唯一索引拦截 → 500 整单回滚 = 正确失败语义。
func importTextInTx(ctx context.Context, q db.Executor, text string) (record.ImportCounts, *myerr.MyError) {
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
			return record.ImportCounts{}, myerr.NewValidation(ErrImportLimitsError)
		}

		row, me := recordjsonl.ParseLine(line, physicalLine)
		if me != nil {
			return record.ImportCounts{}, me
		}
		if _, ok := seen[row.ID]; ok {
			return record.ImportCounts{}, myerr.NewValidation(FormatDuplicateIDError(row.ID, physicalLine))
		}
		seen[row.ID] = struct{}{}

		rec := recordjsonl.ToDomainRecord(row)
		exists, me := recordrepo.Repo.Exists(ctx, q, row.ID)
		if me != nil {
			return record.ImportCounts{}, me
		}
		if exists {
			if me := recordrepo.Repo.Update(ctx, q, rec); me != nil {
				return record.ImportCounts{}, me
			}
			updated++
		} else {
			if _, me := recordrepo.Repo.Save(ctx, q, rec); me != nil {
				return record.ImportCounts{}, me
			}
			inserted++
		}
	}

	return record.ImportCounts{
		Inserted: inserted,
		Updated:  updated,
		Total:    inserted + updated,
	}, nil
}
