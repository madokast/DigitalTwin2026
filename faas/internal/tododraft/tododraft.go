// Package tododraft：待办录入纯解析与对外 JSON 变形（与 src/lib/tododraft.ts 对齐）。
package tododraft

import (
	"fmt"
	"strings"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
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
	CreatedAt                any `json:"created_at"`
	Content                  any `json:"content"`
	ObjectiveContext         any `json:"objective_context"`
	SubjectiveInterpretation any `json:"subjective_interpretation"`
	Tags                     any `json:"tags"`
	SuppressNotification     any `json:"suppress_notification"`
}

var logTodoKeys = []string{
	"created_at", "content", "objective_context",
	"subjective_interpretation", "tags", "suppress_notification",
}

// NormalizedTodo 校验后的待办行（落库列语义）。
type NormalizedTodo struct {
	HappenedAt               time.Time
	ValueText                string
	Tags                     []string
	ObjectiveContext         string
	SubjectiveInterpretation any // string or nil
}

// TodoRecordJSON 待办行 HTTP JSON（别名键；其余与 Record camelCase 一致）。
type TodoRecordJSON struct {
	ID                       string  `json:"id"`
	CreatedAt                string  `json:"created_at"`
	ValueNumber              *string `json:"valueNumber"`
	Content                  string  `json:"content"`
	Tags                     string  `json:"tags"`
	ObjectiveContext         string  `json:"objectiveContext"`
	SubjectiveInterpretation *string `json:"subjectiveInterpretation"`
}

// ToTodoRecordJSON 将内部 Record 变形为待办对外形状（去掉 happenedAt / valueText）。
func ToTodoRecordJSON(rec record.Record) TodoRecordJSON {
	content := ""
	if rec.ValueText != nil {
		content = *rec.ValueText
	}
	return TodoRecordJSON{
		ID:                       rec.ID,
		CreatedAt:                rec.HappenedAt,
		ValueNumber:              nil,
		Content:                  content,
		Tags:                     rec.Tags,
		ObjectiveContext:         rec.ObjectiveContext,
		SubjectiveInterpretation: rec.SubjectiveInterpretation,
	}
}

// IsStrictTodoRecordTags 录入侧严判定：恰好一个四态 tag，且不含 todo:transition。
func IsStrictTodoRecordTags(tagList []string) bool {
	stateCount := 0
	for _, tag := range tagList {
		if tag == TodoTagTransition {
			return false
		}
		switch tag {
		case TodoTagInProgress, TodoTagCompleted, TodoTagCancelled, TodoTagPaused:
			stateCount++
		}
	}
	return stateCount == 1
}

func parseCreatedAt(raw any) (time.Time, error) {
	s, ok := raw.(string)
	if !ok || s == "" {
		return time.Time{}, fmt.Errorf("Missing required field: created_at")
	}
	t, err := draft.ParseHappenedAt(s)
	if err != nil {
		msg := strings.ReplaceAll(err.Error(), "happened_at", "created_at")
		return time.Time{}, fmt.Errorf("%s", msg)
	}
	return t, nil
}

func optionalSubjective(raw any) (any, error) {
	if raw == nil {
		return nil, nil
	}
	s, ok := raw.(string)
	if !ok {
		return nil, fmt.Errorf("Invalid subjective_interpretation")
	}
	if s == "" {
		return nil, nil
	}
	return s, nil
}

func parseOptionalClientTags(raw any) ([]string, error) {
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
			return nil, fmt.Errorf("tags must be an array of strings")
		}
	}
	if len(tagList) == 0 {
		return []string{}, nil
	}
	out := make([]string, 0, len(tagList))
	for _, item := range tagList {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("tags must be an array of strings")
		}
		out = append(out, s)
	}
	for _, tag := range out {
		if !tags.IsValidTag(tag) {
			return nil, fmt.Errorf(
				`Invalid tag: "%s". Tags must contain only letters, numbers, underscores, and cannot start with a number.`,
				tag,
			)
		}
	}
	if rv := tags.AssertNoReservedTags(out); !rv.Valid {
		return nil, fmt.Errorf("%s", rv.Error)
	}
	return out, nil
}

// ParseTodo 校验整单待办创建请求；落库 tags = [todo:in_progress, ...clientTags]。
func ParseTodo(raw []byte) (NormalizedTodo, error) {
	if err := jsonutil.RejectUnknownObjectKeys(raw, logTodoKeys); err != nil {
		return NormalizedTodo{}, err
	}
	var body LogTodoBody
	if err := jsonutil.DecodeUseNumber(raw, &body); err != nil {
		return NormalizedTodo{}, err
	}

	happenedAt, err := parseCreatedAt(body.CreatedAt)
	if err != nil {
		return NormalizedTodo{}, err
	}
	content, ok := body.Content.(string)
	if !ok || content == "" {
		return NormalizedTodo{}, fmt.Errorf("Missing required field: content")
	}
	objCtx, ok := body.ObjectiveContext.(string)
	if !ok || objCtx == "" {
		return NormalizedTodo{}, fmt.Errorf("Missing required field: objective_context")
	}
	subj, err := optionalSubjective(body.SubjectiveInterpretation)
	if err != nil {
		return NormalizedTodo{}, err
	}
	clientTags, err := parseOptionalClientTags(body.Tags)
	if err != nil {
		return NormalizedTodo{}, err
	}

	tagsOut := make([]string, 0, 1+len(clientTags))
	tagsOut = append(tagsOut, TodoTagInProgress)
	tagsOut = append(tagsOut, clientTags...)

	return NormalizedTodo{
		HappenedAt:               happenedAt,
		ValueText:                content,
		Tags:                     tagsOut,
		ObjectiveContext:         objCtx,
		SubjectiveInterpretation: subj,
	}, nil
}
