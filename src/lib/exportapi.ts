/**
 * Records 导出（与 Go `exportapi` 同构）。
 *
 * GET /api/export/records：解析 from?/limit、按 id ASC `LIMIT` 拉取、有界组 NDJSON /
 * Content-Disposition 文件名 / Notify 文案。HTTP 层负责响应头与 notify 调度
 * （写出成功后再 schedule）。本路由无 JSON body，勿接 `readJsonBody`。
 */

import { asc, eq, gte } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'
import { newNotFound } from '@/lib/myerr'
import { Repo } from '@/lib/recordrepo'
import {
  fromDB,
  INVALID_RECORD_ID,
  isValidRecordId,
  type Record as DomainRecord,
} from '@/lib/record'
import { serializeRecord } from '@/lib/recordjsonl'

/** 与 Go `exportapi.ExportLimitError` 同文案 */
export const EXPORT_LIMIT_ERROR =
  'limit must be an integer between 1 and 1000'

/** 与 Go `exportapi.ExportFromNotFound` 同文案 */
export const EXPORT_FROM_NOT_FOUND = 'export from id not found'

export type ParsedExport = {
  /** null = 从表中最小 id 起 */
  from: string | null
  limit: number
}

export type ParseExportError = { error: string }

export type FetchExportResult = { records: DomainRecord[]; status: 200 }

function parseRequiredLimit(raw: string | null): number | null {
  if (raw === null || raw === '') return null
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000) return null
  return n
}

/**
 * 解析导出 query：必填 limit∈[1,1000]；可选 from 须为合法 UUID。
 * 失败一律可映射为 400（from 不存在由 `fetchExportRecords` 返 404）。
 */
export function parseExportRecordsParams(
  searchParams: URLSearchParams,
): ParsedExport | ParseExportError {
  const limit = parseRequiredLimit(searchParams.get('limit'))
  if (limit === null) {
    return { error: EXPORT_LIMIT_ERROR }
  }

  const fromRaw = searchParams.get('from')
  if (fromRaw === null || fromRaw === '') {
    return { from: null, limit }
  }
  if (!isValidRecordId(fromRaw)) {
    return { error: INVALID_RECORD_ID }
  }
  return { from: fromRaw, limit }
}

/**
 * 有 from 时先确认该 id 存在，再 `id >= from` + `ORDER BY id ASC` + LIMIT。
 * 无 from：全表按 id ASC 取 limit 行（空库 → 0 行）。from 不存在 → throw myerr 404。
 */
export async function fetchExportRecords(
  parsed: ParsedExport,
): Promise<FetchExportResult> {
  if (parsed.from !== null) {
    const exists = await Repo.exists(db, parsed.from)
    if (!exists) {
      throw newNotFound(EXPORT_FROM_NOT_FOUND)
    }
  }

  const records = await Repo.findByCriteria(db, {
    idFrom: parsed.from ?? undefined,
    tags: [],
    page: 1,
    pageSize: parsed.limit,
    sortBy: 'id',
    sortOrder: 'asc',
  })
  return { records, status: 200 }
}

/** 每行一条 Record JSON + 换行；0 行 → 空字符串 */
export function buildExportNdjson(recs: DomainRecord[]): string {
  if (recs.length === 0) return ''
  return recs.map((r) => serializeRecord(r)).join('\n') + '\n'
}

/**
 * `records-from-{uuid|start}-limit-{n}-{YYYYMMDDTHHMMSSZ}.jsonl`
 * `now` 按 UTC 格式化。
 */
export function exportFilename(
  from: string | null,
  limit: number,
  now: Date,
): string {
  const cursor = from ?? 'start'
  const ts = formatExportTimestamp(now)
  return `records-from-${cursor}-limit-${limit}-${ts}.jsonl`
}

/** UTC `YYYYMMDDTHHMMSSZ`（与 Go `ExportFilename` 对齐） */
export function formatExportTimestamp(now: Date): string {
  const y = now.getUTCFullYear().toString().padStart(4, '0')
  const mo = (now.getUTCMonth() + 1).toString().padStart(2, '0')
  const d = now.getUTCDate().toString().padStart(2, '0')
  const h = now.getUTCHours().toString().padStart(2, '0')
  const mi = now.getUTCMinutes().toString().padStart(2, '0')
  const s = now.getUTCSeconds().toString().padStart(2, '0')
  return `${y}${mo}${d}T${h}${mi}${s}Z`
}

/**
 * 导出成功 Notify 文案（含 0 行）。
 * 例：`Exported 3 records (from start, limit 100)` /
 * `Exported 0 records (from 0190…, limit 50)`
 */
export function formatExportNotifyMessage(
  count: number,
  from: string | null,
  limit: number,
): string {
  const cursor = from ?? 'start'
  return `Exported ${count} records (from ${cursor}, limit ${limit})`
}

/** Content-Disposition 值（含引号文件名） */
export function exportContentDisposition(
  from: string | null,
  limit: number,
  now: Date,
): string {
  return `attachment; filename="${exportFilename(from, limit, now)}"`
}
