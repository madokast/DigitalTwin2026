/**
 * 统一错误模块（决策 D）：HTTP status + 文案字符串，三层（repository/service/handler）一律经此抛出。
 * 与 Go `faas/internal/myerr` 同构。只存 status + message；驱动错误的诊断信息（类型名 + 消息）
 * 由 describe 烙进 message。见 docs/20260806-myerr-error-module.md。
 */

/** 带 HTTP status 的错误对象；message 即契约文案（小写开头）。 */
export class MyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'MyError'
  }

  /** 语义判等（内部按 status）：业务层区分「记录不存在」与驱动错误时使用，
   * 不直接比较 HTTP status 魔法数字（transitionTodo 预读 404 映射等）。 */
  isNotFound(): boolean {
    return this.status === 404
  }
}

/** 404（记录不存在等）。 */
export const newNotFound = (msg: string): MyError => new MyError(404, msg)

/** 400（请求校验失败，零 DB）。 */
export const newValidation = (msg: string): MyError => new MyError(400, msg)

/** 409（唯一约束冲突 / 重名等；暂未使用）。 */
export const newConflict = (msg: string): MyError => new MyError(409, msg)

/** 500（驱动错误等内部错误）：describe 拼 "类型名: 消息"（空消息 → 仅类型名，永不为空）。
 * 吸收原 httperror.errorMessage 的兜底职责；500 detail 透传驱动消息供 AI 诊断。
 * 防呆：cause 已是 MyError（误传）→ 原样返回，杜绝双重包装（describe 再烙一层类型名污染文案）。 */
export const newInternal = (cause: unknown): MyError => {
  if (cause instanceof MyError) return cause
  return new MyError(500, describe(cause))
}

function describe(cause: unknown): string {
  const name = cause instanceof Error ? cause.constructor.name : typeof cause
  const msg = cause instanceof Error ? cause.message : String(cause)
  return msg ? `${name}: ${msg}` : name
}
