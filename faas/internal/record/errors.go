package record

// 错误哨兵曾定义于此（ErrNotFound/ErrConflict）；决策 D（myerr 统一错误模块）后
// 领域错误改由 myerr.NewNotFound/NewConflict 携带 status 直接抛出，哨兵已删除。
// 见 docs/20260806-myerr-error-module.md。
