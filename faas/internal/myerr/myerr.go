// Package myerr 统一错误模块（决策 D）：HTTP status + 文案字符串，三层（repository/service/handler）一律经此抛出。
//
// 只存 Status + Message（不存原始 error、不保链、不引入堆栈）——驱动错误的诊断信息
// （类型名 + 消息）在构造时由 describe 烙进 Message。见 docs/20260806-myerr-error-module.md。
package myerr

import "fmt"

// MyError 带 HTTP status 的错误对象；Error() 即契约文案（小写开头）。
type MyError struct {
	Status  int
	Message string
}

func (e *MyError) Error() string { return e.Message }

// NewNotFound 404（记录不存在等）。
func NewNotFound(msg string) *MyError { return &MyError{Status: 404, Message: msg} }

// NewValidation 400（请求校验失败，零 DB）。
func NewValidation(msg string) *MyError { return &MyError{Status: 400, Message: msg} }

// NewConflict 409（唯一约束冲突 / 重名等；暂未使用）。
func NewConflict(msg string) *MyError { return &MyError{Status: 409, Message: msg} }

// NewInternal 500（驱动错误等内部错误）：describe 拼 "类型名: 消息"（空消息 → 仅类型名，永不为空）。
// 吸收原 httpx.errorDetail；500 detail 透传驱动消息供 AI 诊断。
func NewInternal(cause error) *MyError {
	return &MyError{Status: 500, Message: describe(cause)}
}

func describe(cause error) string {
	if msg := cause.Error(); msg != "" {
		return fmt.Sprintf("%T: %s", cause, msg)
	}
	return fmt.Sprintf("%T", cause)
}
