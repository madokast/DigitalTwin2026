package httpx

import (
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

// HTTP 响应 typed struct（禁止 map/any jsonify，见 docs/20260805-go-code-quality.md §2）。
// 字段声明顺序 = JSON key 顺序（success 恒第一；有 id 则第二；tags 恒最后），
// 与 Node 对象属性序对齐；参考 go-code-quality.md「统一模板」。

// SuccessOnly `{success}`（probe）。
type SuccessOnly struct {
	Success bool `json:"success"`
}

// RecordSuccess 单条 create 普通记录 `{success, record}`。
type RecordSuccess struct {
	Success bool          `json:"success"`
	Record  record.Record `json:"record"`
}

// TodoRecordSuccess 单条 create 待办（record 为 todo 变形键）。
type TodoRecordSuccess struct {
	Success bool                     `json:"success"`
	Record  tododraft.TodoRecordJSON `json:"record"`
}

// NumberBatchSuccess `{success, inserted, atomic}`。
type NumberBatchSuccess struct {
	Success  bool `json:"success"`
	Inserted int  `json:"inserted"`
	Atomic   bool `json:"atomic"`
}

// TransactionBatchSuccess `{success, inserted, type, sum, atomic}`。
type TransactionBatchSuccess struct {
	Success  bool   `json:"success"`
	Inserted int    `json:"inserted"`
	Type     string `json:"type"`
	Sum      string `json:"sum"`
	Atomic   bool   `json:"atomic"`
}

// TransitionInfo transition 内层 `{from, to}`。
type TransitionInfo struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// TransitionSuccess `{success, id, transition:{from, to}}`。
type TransitionSuccess struct {
	Success    bool           `json:"success"`
	ID         string         `json:"id"`
	Transition TransitionInfo `json:"transition"`
}

// QuerySuccess `{success, count, page, page_size, sort_by, sort_order, records[, hint]}`。
type QuerySuccess struct {
	Success   bool   `json:"success"`
	Count     int    `json:"count"`
	Page      int    `json:"page"`
	PageSize  int    `json:"page_size"`
	SortBy    string `json:"sort_by"`
	SortOrder string `json:"sort_order"`
	Records   []any  `json:"records"`
	Hint      string `json:"hint,omitempty"`
}

// SummarySuccess `{success, total, today, tz}`（admin records/stats）。
type SummarySuccess struct {
	Success bool   `json:"success"`
	Total   int    `json:"total"`
	Today   int    `json:"today"`
	TZ      string `json:"tz"`
}

// TimeSuccess `{success, now, tz}`。
type TimeSuccess struct {
	Success bool   `json:"success"`
	Now     string `json:"now"`
	TZ      string `json:"tz"`
}

// TagsSuccess `{success, tags}`。
type TagsSuccess struct {
	Success bool            `json:"success"`
	Tags    []tags.TagCount `json:"tags"`
}

// RenameTagsSuccess `{success, updated}`。
type RenameTagsSuccess struct {
	Success bool `json:"success"`
	Updated int  `json:"updated"`
}

// ImportRecordsSuccess `{success, inserted, updated, total, atomic}`。
type ImportRecordsSuccess struct {
	Success  bool `json:"success"`
	Inserted int  `json:"inserted"`
	Updated  int  `json:"updated"`
	Total    int  `json:"total"`
	Atomic   bool `json:"atomic"`
}
