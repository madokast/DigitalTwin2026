/**
 * tag 校验与纯 JSON 变换（可被 Client Component 安全导入）。
 * 写库（renameAcrossRecords）在 `@/lib/tagsdb`，勿在此文件 import `@/db`。
 */

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
 * 当前 P：`transaction_entry`、`body:weight`、`todo`、`review`。
 * 仅专用 API 可写入带此前缀的 tag；通用 log / Admin 草稿 / rename 的 from/to 均拒绝。
 */
export const RESERVED_TAG_PREFIXES = [
  'transaction_entry',
  'body:weight',
  'todo',
  'review',
] as const

export type ReservedTagPrefix = (typeof RESERVED_TAG_PREFIXES)[number]

export const RESERVED_TAG_TRANSACTION_ENTRY: ReservedTagPrefix = 'transaction_entry'
export const RESERVED_TAG_BODY_WEIGHT: ReservedTagPrefix = 'body:weight'
export const RESERVED_TAG_TODO: ReservedTagPrefix = 'todo'
export const RESERVED_TAG_REVIEW: ReservedTagPrefix = 'review'

/** 保留 tag 错误后缀：不指向具体端点路径，AI 自行查 OpenAPI（端点改名/新增不会过时） */
const RESERVED_TAG_HINT =
  'use the dedicated log API for this record type'

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

/** 英文错误：指明保留 tag 应走专用记录 API（不指向具体端点） */
export function reservedTagError(tag: string): string {
  return `tag "${tag}" is reserved; ${RESERVED_TAG_HINT}`
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
 * - 可为空数组（[] 合法）
 * - 每个 tag 都符合格式
 */
export function validateTags(tags: string[]): ValidationResult {
  if (!Array.isArray(tags)) {
    return { valid: false, error: 'tags must be an array of strings' }
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

/** 单个 tag 的计数（JSON `tag`/`count` snake_case） */
export type TagCount = { tag: string; count: number }

/**
 * 从 records.tags（JSON 字符串数组）汇总「记录条数」，按「计数降序、同名 tag 升序」返回数组。
 * prefix 非空时仅保留以 prefix 开头的 tag（真前缀，自动补全语义）。
 * 排序与 Go `sort.Slice`（计数降序，同名升序）一致；tag 名比较用字节序（ASCII 下大写在小写前），勿用 localeCompare。
 * 非法 JSON / 非数组抛错（由 HTTP 映射 500）。
 */
export function aggregateTagCounts(
  tagFields: string[],
  prefix = '',
): TagCount[] {
  const counts = new Map<string, number>()

  for (const field of tagFields) {
    const parsed = parseTagsJsonArray(field)
    for (const tag of parsed) {
      if (typeof tag !== 'string') continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  const list: TagCount[] = []
  for (const [tag, count] of counts) {
    if (prefix && !tag.startsWith(prefix)) continue
    list.push({ tag, count })
  }
  list.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0
  })
  return list
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
