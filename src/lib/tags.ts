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
