package record

import "errors"

// 领域错误哨兵（终稿 §4）：Repository 返回，业务层 errors.Is 映射 status。
// 阶段 B 追加 ErrInternal（InternalError 类型 + Unwrap 保链，吸收三方库错误）。
var (
	ErrNotFound = errors.New("record not found")                        // 固定 message
	ErrConflict = errors.New("record tags changed concurrently, retry") // 固定 message
)
