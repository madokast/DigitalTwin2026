/**
 * Records 导入（与 Go `importapi` 同构）。
 *
 * POST /api/admin/import/records：multipart `file`（≤4MiB 有界读入）→ 逐行 parse
 * （recordjsonl）→ 单事务 upsert；可写保留 tag（不调 assertNoReservedTags）。
 * 成功 commit + Notify；失败 rollback、不 Notify。勿接 `readJsonBody`（须 bypass 256KiB）。
 */

import { eq } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'
import {
  formatLineError,
  parseLine,
  type RecordJsonlRow,
} from '@/lib/recordjsonl'
import { tagsJSON } from '@/lib/record'

/** 非空行上限（与 Go MaxImportLines 对齐） */
export const MAX_IMPORT_LINES = 1000

/** file part 原始字节上限 4 MiB（与 Go MaxImportFileBytes 对齐） */
export const MAX_IMPORT_FILE_BYTES = 4 * 1024 * 1024

/** 与 Go ImportLimitsError 同文案 */
export const IMPORT_LIMITS_ERROR =
  'import exceeds limits (max 1000 lines or 4 MiB); split the file'

/** 与 Go ErrMultipartRequired 同文案 */
export const MULTIPART_FILE_REQUIRED =
  'multipart form field "file" is required'

/** 与 Go ErrMultipartMultipleFile 同文案 */
export const MULTIPART_MULTIPLE_FILE =
  'multipart must contain exactly one "file" part'

/** 与 Go ErrMultipartContentType 同文案 */
export const MULTIPART_CONTENT_TYPE =
  'expected Content-Type multipart/form-data'

/**
 * 从 Content-Type 提取 multipart boundary；缺失 / 解析失败返回 null。
 * 与 Go mime.ParseMediaType 语义对齐：boundary 缺失或格式错误 → 400
 * （Next request.formData() 会抛错，若不前置检查会落 500 catch）。
 */
export function extractMultipartBoundary(contentType: string): string | null {
  const parts = contentType.split(';')
  for (let i = 1; i < parts.length; i++) {
    const param = parts[i].trim()
    const eq = param.indexOf('=')
    if (eq <= 0) continue
    if (param.slice(0, eq).trim().toLowerCase() !== 'boundary') continue
    let value = param.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    return value.length > 0 ? value : null
  }
  return null
}

/** 与 Go ErrUnsupportedFileContentType 同文案 */
export const UNSUPPORTED_FILE_CONTENT_TYPE =
  'unsupported file Content-Type; use application/x-ndjson, application/jsonl, or application/octet-stream with a .jsonl filename'

export type ImportCounts = {
  inserted: number
  updated: number
  total: number
}

export type ImportResult =
  | { ok: true; counts: ImportCounts }
  | { ok: false; error: string; status: number }

/** 可注入写库边界（单测）；生产走 drizzle 事务 */
export type ImportStore = {
  begin: <T>(fn: (tx: ImportTx) => Promise<T>) => Promise<T>
}

export type ImportTx = {
  exists: (id: string) => Promise<boolean>
  insert: (row: RecordJsonlRow) => Promise<void>
  update: (row: RecordJsonlRow) => Promise<void>
}

function duplicateIdError(id: string, lineNumber: number): string {
  return formatLineError(`duplicate record id ${id}`, lineNumber)
}

/**
 * 重复 id 错误文案（含 uuid + 可选行号）。与 Go FormatDuplicateIDError 同构。
 */
export function formatDuplicateIdError(
  id: string,
  lineNumber?: number,
): string {
  return formatLineError(
    `duplicate record id ${id}`,
    lineNumber !== undefined ? lineNumber : 0,
  )
}

/**
 * 导入成功 Notify 文案（含全 0）。
 * 例：`Imported 15 records (inserted 12, updated 3)`
 */
export function formatImportNotifyMessage(counts: ImportCounts): string {
  return `Imported ${counts.total} records (inserted ${counts.inserted}, updated ${counts.updated})`
}

/**
 * 校验 file part Content-Type / 文件名。
 * 接受 application/x-ndjson、application/jsonl；
 * 或 application/octet-stream（或空 type）且 filename 以 .jsonl 结尾。
 */
export function isAcceptedImportFilePart(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (ct === 'application/x-ndjson' || ct === 'application/jsonl') {
    return true
  }
  const name = (filename ?? '').toLowerCase()
  if (ct === 'application/octet-stream' || ct === '') {
    return name.endsWith('.jsonl')
  }
  return false
}

function rowValues(row: RecordJsonlRow) {
  return {
    id: row.id,
    happenedAt: row.happenedAt,
    utcOffset: row.utcOffset,
    valueNumber: row.valueNumber,
    valueText: row.valueText,
    tags: tagsJSON(row.tags),
    objectiveContext: row.objectiveContext,
    subjectiveInterpretation: row.subjectiveInterpretation,
  }
}

function defaultStore(): ImportStore {
  return {
    begin(fn) {
      return db.transaction(async (tx) => {
        const importTx: ImportTx = {
          async exists(id) {
            const rows = await tx
              .select({ id: records.id })
              .from(records)
              .where(eq(records.id, id))
              .limit(1)
            return rows.length > 0
          },
          async insert(row) {
            await tx.insert(records).values(rowValues(row))
          },
          async update(row) {
            const v = rowValues(row)
            await tx
              .update(records)
              .set({
                happenedAt: v.happenedAt,
                utcOffset: v.utcOffset,
                valueNumber: v.valueNumber,
                valueText: v.valueText,
                tags: v.tags,
                objectiveContext: v.objectiveContext,
                subjectiveInterpretation: v.subjectiveInterpretation,
              })
              .where(eq(records.id, row.id))
          },
        }
        return fn(importTx)
      })
    },
  }
}

class ImportDomainError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * 从已读入的 UTF-8 JSONL 文本做单事务逐行 upsert（有界缓冲，非 HTTP chunk 流）。
 * `fileBytes` 为 file part 原始字节数（超限直接 400）。
 * 空文件 / 仅空行 → 全 0 成功。
 */
export async function importRecordsJsonl(
  text: string,
  fileBytes: number,
  store: ImportStore = defaultStore(),
): Promise<ImportResult> {
  if (fileBytes > MAX_IMPORT_FILE_BYTES) {
    return { ok: false, error: IMPORT_LIMITS_ERROR, status: 400 }
  }

  try {
    const counts = await store.begin(async (tx) => {
      let inserted = 0
      let updated = 0
      const seen = new Set<string>()
      let physicalLine = 0
      let nonEmpty = 0

      const lines = text.length === 0 ? [] : text.split('\n')
      for (const raw of lines) {
        physicalLine += 1
        let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (physicalLine === 1 && line.charCodeAt(0) === 0xfeff) {
          line = line.slice(1)
        }
        if (line.trim() === '') {
          continue
        }
        nonEmpty += 1
        if (nonEmpty > MAX_IMPORT_LINES) {
          throw new ImportDomainError(IMPORT_LIMITS_ERROR, 400)
        }

        const parsed = parseLine(line, physicalLine)
        if ('error' in parsed) {
          throw new ImportDomainError(parsed.error, 400)
        }

        if (seen.has(parsed.id)) {
          throw new ImportDomainError(
            duplicateIdError(parsed.id, physicalLine),
            400,
          )
        }
        seen.add(parsed.id)

        const exists = await tx.exists(parsed.id)
        if (exists) {
          await tx.update(parsed)
          updated += 1
        } else {
          await tx.insert(parsed)
          inserted += 1
        }
      }

      return {
        inserted,
        updated,
        total: inserted + updated,
      } satisfies ImportCounts
    })

    return { ok: true, counts }
  } catch (err) {
    if (err instanceof ImportDomainError) {
      return { ok: false, error: err.message, status: err.status }
    }
    console.error('Error importing records:', err)
    return { ok: false, error: 'Internal server error', status: 500 }
  }
}
