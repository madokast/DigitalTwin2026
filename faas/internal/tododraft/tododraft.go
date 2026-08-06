// Package tododraft：待办录入纯解析与对外 JSON 变形（与 src/lib/tododraft.ts 对齐）。
package tododraft

import (
	"fmt"
	"strings"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

// TodoState 字面量（非完整 tag）。
const (
	TodoStateInProgress = "in_progress"
	TodoStateCompleted  = "completed"
	TodoStateCancelled  = "cancelled"
	TodoStatePaused     = "paused"
)

// 系统闭集 tag。
const (
	TodoTagInProgress = "todo:in_progress"
	TodoTagCompleted  = "todo:completed"
	TodoTagCancelled  = "todo:cancelled"
	TodoTagPaused     = "todo:paused"
	TodoTagTransition = "todo:transition"
)

// LogTodoBody POST /api/log/todo 请求体（any：字段级校验文案与 Next 对齐）。
type LogTodoBody struct {
	CreatedAt        any `json:"created_at"`
	Content          any `json:"content"`
	ObjectiveContext any `json:"objective_context"`
	AiAnalysis       any `json:"ai_analysis"`
	Tags             any `json:"tags"`
}

var logTodoKeys = []string{
	"created_at", "content", "objective_context",
	"ai_analysis", "tags",
}

// NormalizedTodo 校验后的待办行（落库列语义）。HappenedAtRaw 为已校验的 created_at 请求串。
type NormalizedTodo struct {
	HappenedAtRaw    string
	RawContent       string
	Tags             []string
	ObjectiveContext string
	AiAnalysis       *string
}

// TodoRecordJSON 待办行 HTTP JSON（别名键；其余与 Record snake_case 一致）。
type TodoRecordJSON struct {
	ID               string   `json:"id"`
	CreatedAt        string   `json:"created_at"`
	Content          string   `json:"content"`
	ObjectiveContext string   `json:"objective_context"`
	AiAnalysis       *string  `json:"ai_analysis"`
	Tags             []string `json:"tags"`
}

// ToTodoRecordJSON 将内部 Record 变形为待办对外形状（去掉 happened_at / raw_content）。
func ToTodoRecordJSON(rec record.Record) TodoRecordJSON {
	content := ""
	if rec.RawContent != nil {
		content = *rec.RawContent
	}
	return TodoRecordJSON{
		ID:               rec.ID,
		CreatedAt:        rec.HappenedAt,
		Content:          content,
		ObjectiveContext: rec.ObjectiveContext,
		AiAnalysis:       rec.AiAnalysis,
		Tags:             rec.Tags,
	}
}

// ShouldDeformTodoRecordTags 查询侧略宽（§1.3）：至少含一个四态 tag → 待办变形。
// 四态与 todo:transition 并存时仍变形（有四态优先）。与 TS 同规则。
func ShouldDeformTodoRecordTags(tagList []string) bool {
	for _, tag := range tagList {
		if isStateTag(tag) {
			return true
		}
	}
	return false
}

// Transition 四类可区分英文错误文案（与 TS tododraft 字节一致）。
// 字符串常量（非 error 哨兵）：仅作 myerr 构造文案 / draft 层错误文案，无 errors.Is 语义。
const (
	ErrTodoNotFound    = "to-do not found"
	ErrNotATodo        = "record is not a to-do"
	ErrAuditTransition = "cannot transition a to-do audit record"
	ErrAlreadyTarget   = "to-do is already in target state"
	ErrInvalidTarget   = "target must be one of: in_progress, completed, cancelled, paused"
)

// LogTodoTransitionBody POST /api/log/todo/transition 请求体。
type LogTodoTransitionBody struct {
	ID         any `json:"id"`
	Target     any `json:"target"`
	HappenedAt any `json:"happened_at"`
}

var logTodoTransitionKeys = []string{
	"id", "target", "happened_at",
}

// NormalizedTodoTransition 校验后的流转请求。
type NormalizedTodoTransition struct {
	ID            string
	Target        string // TodoState 字面量
	HappenedAtRaw string
}

func isStateTag(tag string) bool {
	switch tag {
	case TodoTagInProgress, TodoTagCompleted, TodoTagCancelled, TodoTagPaused:
		return true
	default:
		return false
	}
}

// TodoStateFromTag `todo:{state}` → TodoState；非状态 tag → ""。
func TodoStateFromTag(tag string) string {
	switch tag {
	case TodoTagInProgress:
		return TodoStateInProgress
	case TodoTagCompleted:
		return TodoStateCompleted
	case TodoTagCancelled:
		return TodoStateCancelled
	case TodoTagPaused:
		return TodoStatePaused
	default:
		return ""
	}
}

// TodoTagForState TodoState → `todo:{state}`。
func TodoTagForState(state string) string {
	return "todo:" + state
}

// IsStrictTodoRecordTags 录入侧严判定：恰好一个四态 tag，且不含 todo:transition。
func IsStrictTodoRecordTags(tagList []string) bool {
	stateCount := 0
	for _, tag := range tagList {
		if tag == TodoTagTransition {
			return false
		}
		if isStateTag(tag) {
			stateCount++
		}
	}
	return stateCount == 1
}

// IsTodoAuditRecordTags 审计行：含 todo:transition 且无四态代表 tag。
func IsTodoAuditRecordTags(tagList []string) bool {
	hasTransition := false
	hasState := false
	for _, tag := range tagList {
		if tag == TodoTagTransition {
			hasTransition = true
		}
		if isStateTag(tag) {
			hasState = true
		}
	}
	return hasTransition && !hasState
}

// TodoStateFromTags 严待办行上的唯一代表状态；否则 ""。
func TodoStateFromTags(tagList []string) string {
	if !IsStrictTodoRecordTags(tagList) {
		return ""
	}
	for _, tag := range tagList {
		if s := TodoStateFromTag(tag); s != "" {
			return s
		}
	}
	return ""
}

// ReplaceTodoStateInTags 仅替换唯一四态 tag；其余原样保留。
func ReplaceTodoStateInTags(tagList []string, target string) []string {
	targetTag := TodoTagForState(target)
	out := make([]string, len(tagList))
	for i, tag := range tagList {
		if isStateTag(tag) {
			out[i] = targetTag
		} else {
			out[i] = tag
		}
	}
	return out
}

// AuditObjectiveContext §3.1 审计行 objective_context 合成句。
// todoHappenedAt 为流转前待办行 fromDB 按 utc_offset 格式化后的带区串。
func AuditObjectiveContext(target, todoID, todoHappenedAt string) string {
	return verbFor(target) + " a to-do " + todoID + " created at " + todoHappenedAt
}

// TodoAuditNotifyText D6 通知正文：审计行 objective_context 句 + ": " + 待办正文逐字拷贝。
// 与审计行 objective_context / raw_content 两字段可还原，非字节级一致。
func TodoAuditNotifyText(target, todoID, todoHappenedAt, todoRawContent string) string {
	return AuditObjectiveContext(target, todoID, todoHappenedAt) + ": " + todoRawContent
}

func verbFor(target string) string {
	switch target {
	case TodoStateCompleted:
		return "Complete"
	case TodoStateCancelled:
		return "Cancel"
	case TodoStatePaused:
		return "Pause"
	default:
		return "Resume"
	}
}

func isValidTodoState(s string) bool {
	switch s {
	case TodoStateInProgress, TodoStateCompleted, TodoStateCancelled, TodoStatePaused:
		return true
	default:
		return false
	}
}

// ParseTodoTransition 校验 transition 请求体。
func ParseTodoTransition(raw []byte) (NormalizedTodoTransition, *myerr.MyError) {
	if me := jsonutil.RejectUnknownObjectKeys(raw, logTodoTransitionKeys); me != nil {
		return NormalizedTodoTransition{}, me
	}
	var body LogTodoTransitionBody
	if me := jsonutil.DecodeUseNumber(raw, &body); me != nil {
		return NormalizedTodoTransition{}, me
	}

	id, ok := body.ID.(string)
	if !ok || id == "" {
		return NormalizedTodoTransition{}, myerr.NewValidation("missing required field: id")
	}

	if body.Target == nil {
		return NormalizedTodoTransition{}, myerr.NewValidation("missing required field: target")
	}
	target, ok := body.Target.(string)
	if !ok || target == "" {
		if !ok {
			return NormalizedTodoTransition{}, myerr.NewValidation(ErrInvalidTarget)
		}
		return NormalizedTodoTransition{}, myerr.NewValidation("missing required field: target")
	}
	if !isValidTodoState(target) {
		return NormalizedTodoTransition{}, myerr.NewValidation(ErrInvalidTarget)
	}

	createdAt := happenedAtString(body.HappenedAt)
	if me := draft.ValidateHappenedAt(createdAt); me != nil {
		return NormalizedTodoTransition{}, me
	}

	return NormalizedTodoTransition{
		ID:            id,
		Target:        target,
		HappenedAtRaw: createdAt,
	}, nil
}

func happenedAtString(raw any) string {
	s, _ := raw.(string)
	return s
}

func parseCreatedAt(raw any) (string, *myerr.MyError) {
	s, ok := raw.(string)
	if !ok || s == "" {
		return "", myerr.NewValidation("missing required field: created_at")
	}
	if me := draft.ValidateHappenedAt(s); me != nil {
		msg := strings.ReplaceAll(me.Message, "happened_at", "created_at")
		return "", myerr.NewValidation(msg)
	}
	return s, nil
}

func parseOptionalClientTags(raw any) ([]string, *myerr.MyError) {
	if raw == nil {
		return []string{}, nil
	}
	tagList, ok := raw.([]any)
	if !ok {
		if sl, ok2 := raw.([]string); ok2 {
			tagList = make([]any, len(sl))
			for i, t := range sl {
				tagList[i] = t
			}
		} else {
			return nil, myerr.NewValidation("tags must be an array of strings")
		}
	}
	if len(tagList) == 0 {
		return []string{}, nil
	}
	out := make([]string, 0, len(tagList))
	for _, item := range tagList {
		s, ok := item.(string)
		if !ok {
			return nil, myerr.NewValidation("tags must be an array of strings")
		}
		out = append(out, s)
	}
	for _, tag := range out {
		if !tags.IsValidTag(tag) {
			return nil, myerr.NewValidation(fmt.Sprintf(
				`invalid tag: "%s". Tags must contain only letters, numbers, underscores, and cannot start with a number`,
				tag,
			))
		}
	}
	if rv := tags.AssertNoReservedTags(out); !rv.Valid {
		return nil, myerr.NewValidation(rv.Error)
	}
	if dup := tags.FirstDuplicateTag(out); dup != "" {
		return nil, myerr.NewValidation(fmt.Sprintf("duplicate tag \"%s\"", dup))
	}
	return out, nil
}

// ParseTodo 校验整单待办创建请求；落库 tags = [todo:in_progress, ...clientTags]。
func ParseTodo(raw []byte) (NormalizedTodo, *myerr.MyError) {
	if me := jsonutil.RejectUnknownObjectKeys(raw, logTodoKeys); me != nil {
		return NormalizedTodo{}, me
	}
	var body LogTodoBody
	if me := jsonutil.DecodeUseNumber(raw, &body); me != nil {
		return NormalizedTodo{}, me
	}

	createdAtRaw, me := parseCreatedAt(body.CreatedAt)
	if me != nil {
		return NormalizedTodo{}, me
	}
	content, me := draft.RequireTrimmedText(body.Content, "content")
	if me != nil {
		return NormalizedTodo{}, me
	}
	objCtx, me := draft.RequireTrimmedText(body.ObjectiveContext, "objective_context")
	if me != nil {
		return NormalizedTodo{}, me
	}
	subj, me := draft.OptionalTrimmedNullable(body.AiAnalysis, "ai_analysis")
	if me != nil {
		return NormalizedTodo{}, me
	}
	clientTags, me := parseOptionalClientTags(body.Tags)
	if me != nil {
		return NormalizedTodo{}, me
	}

	tagsOut := make([]string, 0, 1+len(clientTags))
	tagsOut = append(tagsOut, TodoTagInProgress)
	tagsOut = append(tagsOut, clientTags...)

	return NormalizedTodo{
		HappenedAtRaw:    createdAtRaw,
		RawContent:       content,
		Tags:             tagsOut,
		ObjectiveContext: objCtx,
		AiAnalysis:       subj,
	}, nil
}
