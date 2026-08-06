/** 领域错误类（终稿 §4）：Repository 返回、业务层 instanceof 映射 status；不 throw，放 res.error。
 * 阶段 B 追加 InternalError（吸收三方库错误）。 */

export class RecordNotFoundError extends Error {}

export class RecordConflictError extends Error {}
