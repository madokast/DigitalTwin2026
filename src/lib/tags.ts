import { eq, sql } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'

/**
 * 验证 tag 格式
 * 规则：
 * - 只能用：英文字母、数字、下划线、冒号
 * - 不能以数字开头
 * - 冒号不能开头、不能结尾、不能连续
 * - 至少一个字符
 * - 类似标识符命名规则，允许冒号表示层级（如 source:device、review:weekly）
 */
export function isValidTag(tag: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+)*$/.test(tag)
}

/**
 * 保留 tag **前缀**列表（非仅精确匹配）。
 * 某 tag 视为保留当且仅当：`tag === P` 或 `tag.startsWith(P + ":")`
 *（冒号边界，避免误伤 `transaction_entrypoint`）。
 * 当前 P：`transaction_entry` → 同时禁止 `transaction_entry:income` 等。
 * 仅专用 API（POST /api/log/transaction）可写入带此前缀的 tag；
 * 通用 log / Admin 草稿 / rename 的 from/to 均拒绝。
 */
export const RESERVED_TAG_PREFIXES = ['transaction_entry'] as const

export type ReservedTagPrefix = (typeof RESERVED_TAG_PREFIXES)[number]

export const RESERVED_TAG_TRANSACTION_ENTRY: ReservedTagPrefix = 'transaction_entry'

/** 组装落库用的类型 tag：`transaction_entry:income` / `transaction_entry:expense` */
export function transactionEntryTypeTag(
  type: 'income' | 'expense',
): string {
  return `${RESERVED_TAG_TRANSACTION_ENTRY}:${type}`
}

export function isReservedTag(tag: string): boolean {
  for (const p of RESERVED_TAG_PREFIXES) {
    if (tag === p || tag.startsWith(`${p}:`)) {
      return true
    }
  }
  return false
}

/** 英文错误：指明保留 tag 与正确录入路径 */
export function reservedTagError(tag: string): string {
  return `tag "${tag}" is reserved; use POST /api/log/transaction for transaction line entries`
}

/** 与 Go `tags.ValidationResult` 同构 */
export type ValidationResult = { valid: boolean; error?: string }

/**
 * 客户端传入的 tags 不得含保留前缀。
 * 服务端写入的 transaction 行可含保留 tag，不要对本函数传入那些组装结果来「拒绝」。
 */
export function assertNoReservedTags(tags: string[]): ValidationResult {
  for (const tag of tags) {
    if (isReservedTag(tag)) {
      return { valid: false, error: reservedTagError(tag) }
    }
  }
  return { valid: true }
}

/**
 * 验证 tags 数组
 * - 非空数组
 * - 每个 tag 都符合格式
 */
export function validateTags(tags: string[]): ValidationResult {
  if (!Array.isArray(tags) || tags.length === 0) {
    return { valid: false, error: 'tags must be a non-empty array' }
  }

  for (const tag of tags) {
    if (!isValidTag(tag)) {
      return {
        valid: false,
        error: `Invalid tag: "${tag}". Tags must contain only letters, numbers, underscores, and cannot start with a number.`,
      }
    }
  }

  return { valid: true }
}

/** 与 Go `tags.ErrTagsNotJSONArray` 同文案：解析成功但根不是数组 */
export const TAGS_NOT_JSON_ARRAY = 'tags field is not a JSON array'

/** 解析 records.tags JSON；非法 JSON 抛出；根非数组抛出 TAGS_NOT_JSON_ARRAY */
function parseTagsJsonArray(tagsJson: string): unknown[] {
  const parsed: unknown = JSON.parse(tagsJson)
  if (!Array.isArray(parsed)) {
    throw new Error(TAGS_NOT_JSON_ARRAY)
  }
  return parsed
}

/**
 * 从 records.tags（JSON 字符串数组）汇总「记录条数」，按 tag 名字典序返回。
 * 与 Go `AggregateTagCounts` 对齐：非法 JSON / 非数组抛错（由 HTTP 映射 500）。
 */
export function aggregateTagCounts(tagFields: string[]): Record<string, number> {
  const counts = new Map<string, number>()

  for (const field of tagFields) {
    const parsed = parseTagsJsonArray(field)
    for (const tag of parsed) {
      if (typeof tag !== 'string') continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  )
}

/**
 * 在单条 records.tags JSON 中精确替换 tag 名。
 * 若 from 不存在返回 null；若 to 已存在则去重，保持首次出现顺序。
 * 非法 JSON / 非数组抛错（与 Go `RenameTagInTagsJSON` 的 error 通道对齐）。
 */
export function renameTagInTagsJson(
  tagsJson: string,
  from: string,
  to: string,
): string | null {
  const parsed = parseTagsJsonArray(tagsJson)

  let found = false
  const next: string[] = []
  const seen = new Set<string>()

  for (const item of parsed) {
    if (typeof item !== 'string') continue
    const mapped = item === from ? to : item
    if (item === from) found = true
    if (seen.has(mapped)) continue
    seen.add(mapped)
    next.push(mapped)
  }

  if (!found) return null
  return JSON.stringify(next)
}

/**
 * rename 业务校验：非空、合法 tag、非保留、from≠to。
 * 与 Go `ValidateRename` 同构；调用方应先 trim。
 */
export function validateRename(from: string, to: string): ValidationResult {
  if (!from || !to) {
    return { valid: false, error: 'Missing required fields: from, to' }
  }
  if (!isValidTag(from) || !isValidTag(to)) {
    return { valid: false, error: 'from and to must be valid tag names' }
  }
  if (isReservedTag(from)) {
    return { valid: false, error: reservedTagError(from) }
  }
  if (isReservedTag(to)) {
    return { valid: false, error: reservedTagError(to) }
  }
  if (from === to) {
    return { valid: false, error: 'from and to must be different' }
  }
  return { valid: true }
}

/**
 * renameAcrossRecords 可注入的写库边界（与 Go renameAcrossQuerier / 假 Querier 对称）。
 * 注入时跳过事务与 advisory lock（单测）；生产省略 store，走事务+锁。
 */
export type RenameAcrossRecordsDb = {
  listIdAndTags: () => Promise<{ id: string; tags: string }[]>
  updateTags: (id: string, tags: string) => Promise<void>
}

/** 与 Go tags.TagRenameAdvisoryLockKey 一致 */
export const TAG_RENAME_ADVISORY_LOCK_KEY = 726478478

async function renameAcrossStore(
  from: string,
  to: string,
  store: RenameAcrossRecordsDb,
): Promise<number> {
  const rows = await store.listIdAndTags()
  let updated = 0

  for (const row of rows) {
    const nextTags = renameTagInTagsJson(row.tags, from, to)
    if (nextTags === null) continue
    await store.updateTags(row.id, nextTags)
    updated += 1
  }
  return updated
}

/**
 * 全表扫描 records，将 tags JSON 中 from 重命名为 to。
 * 生产路径：单事务 + pg_advisory_xact_lock（与 Go RenameAcrossRecords 对齐）—
 * 中途失败全滚；并发 rename 互斥。
 * 脏 tags JSON 向上抛错（HTTP 映射 500）。
 * 可选 `store`：测试注入（无真实锁/事务）；生产调用方省略。
 */
export async function renameAcrossRecords(
  from: string,
  to: string,
  store?: RenameAcrossRecordsDb,
): Promise<number> {
  if (store) {
    return renameAcrossStore(from, to, store)
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${TAG_RENAME_ADVISORY_LOCK_KEY})`,
    )
    return renameAcrossStore(from, to, {
      async listIdAndTags() {
        return tx.select({ id: records.id, tags: records.tags }).from(records)
      },
      async updateTags(id, tagsJson) {
        await tx
          .update(records)
          .set({ tags: tagsJson })
          .where(eq(records.id, id))
      },
    })
  })
}
