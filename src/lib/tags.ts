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
 * 验证 tags 数组
 * - 非空数组
 * - 每个 tag 都符合格式
 */
export function validateTags(tags: string[]): { valid: boolean; error?: string } {
  if (!Array.isArray(tags) || tags.length === 0) {
    return { valid: false, error: 'tags must be a non-empty array' }
  }
  
  for (const tag of tags) {
    if (!isValidTag(tag)) {
      return { 
        valid: false, 
        error: `Invalid tag: "${tag}". Tags must contain only letters, numbers, underscores, and cannot start with a number.` 
      }
    }
  }
  
  return { valid: true }
}

/**
 * 从 records.tags（JSON 字符串数组）汇总「记录条数」，按 tag 名字典序返回。
 */
export function aggregateTagCounts(tagFields: string[]): Record<string, number> {
  const counts = new Map<string, number>()

  for (const field of tagFields) {
    const parsed = JSON.parse(field) as unknown
    if (!Array.isArray(parsed)) continue
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
 */
export function renameTagInTagsJson(
  tagsJson: string,
  from: string,
  to: string,
): string | null {
  const parsed = JSON.parse(tagsJson) as unknown
  if (!Array.isArray(parsed)) return null

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
