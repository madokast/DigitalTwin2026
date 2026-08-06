// 领域错误类曾定义于此（RecordNotFoundError / RecordConflictError）；决策 D（myerr 统一错误模块）后
// 领域错误改由 myerr.newNotFound / newConflict 携带 status 直接抛出，本文件已无引用。
// 见 docs/20260806-myerr-error-module.md。
