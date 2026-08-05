// Package numberdraft：数值批量（log/numbers）纯解析（与 src/lib/numberdraft.ts 对齐）。
// 对齐交易 transactiondraft 的批量模式：顶层共享 happened_at + entries 数组。
// 每条 entry：numeric_value / memo 必填，tags / ai_analysis 可选。
// 落库：numeric_value → numeric_value；memo → objective_context；raw_content = NULL。
package numberdraft

import (
	"fmt"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

const MaxNumberEntries = 100

// NumberEntryInput 单条 entry 原始输入（any：字段级校验文案与 Next 对齐）。
type NumberEntryInput struct {
	NumericValue any `json:"numeric_value"`
	Memo         any `json:"memo"`
	AiAnalysis   any `json:"ai_analysis"`
	Tags         any `json:"tags"`
}

// LogNumbersBody POST /api/log/numbers 请求体。
type LogNumbersBody struct {
	HappenedAt any `json:"happened_at"`
	Entries    any `json:"entries"`
}

var logNumbersKeys = []string{
	"happened_at", "entries",
}

var numberEntryKeys = []string{
	"numeric_value", "memo", "ai_analysis", "tags",
}

// NormalizedNumberEntry 校验后的单条 entry。
type NormalizedNumberEntry struct {
	NumericValue     string
	ObjectiveContext string
	AiAnalysis       *string
	Tags             []string
}

// NormalizedNumberBatch 校验后的整单。
type NormalizedNumberBatch struct {
	HappenedAt time.Time
	UtcOffset  string
	Entries    []NormalizedNumberEntry
}

// parseEntry 校验单条 entry，错误带 entries[i]: 前缀。
func parseEntry(raw any, index int) (NormalizedNumberEntry, error) {
	prefix := fmt.Sprintf("entries[%d]: ", index)
	if raw == nil {
		return NormalizedNumberEntry{}, fmt.Errorf("entries[%d] must be an object", index)
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return NormalizedNumberEntry{}, fmt.Errorf("entries[%d] must be an object", index)
	}
	if err := jsonutil.RejectUnknownMapKeys(m, numberEntryKeys, prefix); err != nil {
		return NormalizedNumberEntry{}, err
	}
	entry := NumberEntryInput{
		NumericValue: m["numeric_value"],
		Memo:         m["memo"],
		Tags:         m["tags"],
		AiAnalysis:   m["ai_analysis"],
	}

	// numeric_value 必填且非空（批量数值每条必须有值）
	if entry.NumericValue == nil {
		return NormalizedNumberEntry{}, fmt.Errorf("%sMissing required field: numeric_value", prefix)
	}
	numStr, err := draft.ParseNumericValue(entry.NumericValue)
	if err != nil {
		return NormalizedNumberEntry{}, fmt.Errorf("%s%w", prefix, err)
	}
	if numStr == nil {
		return NormalizedNumberEntry{}, fmt.Errorf("%sMissing required field: numeric_value", prefix)
	}

	// memo 必填 → objective_context（DB NOT NULL）
	memo, err := draft.RequireTrimmedText(entry.Memo, "memo")
	if err != nil {
		return NormalizedNumberEntry{}, fmt.Errorf("%s%w", prefix, err)
	}

	// tags 可选（省略 → []），传了则校验格式 + 拒保留前缀
	tagList, err := parseOptionalTags(entry.Tags)
	if err != nil {
		return NormalizedNumberEntry{}, fmt.Errorf("%s%w", prefix, err)
	}
	if tv := tags.ValidateTags(tagList); !tv.Valid {
		return NormalizedNumberEntry{}, fmt.Errorf("%s%s", prefix, tv.Error)
	}
	if rv := tags.AssertNoReservedTags(tagList); !rv.Valid {
		return NormalizedNumberEntry{}, fmt.Errorf("%s%s", prefix, rv.Error)
	}
	if dup := tags.FirstDuplicateTag(tagList); dup != "" {
		return NormalizedNumberEntry{}, fmt.Errorf("%sDuplicate tag \"%s\"", prefix, dup)
	}

	// ai_analysis 可选：省略/null → nil；空白 → 400
	ai, err := draft.OptionalTrimmedNullable(entry.AiAnalysis, "ai_analysis")
	if err != nil {
		return NormalizedNumberEntry{}, fmt.Errorf("%s%w", prefix, err)
	}

	return NormalizedNumberEntry{
		NumericValue:     *numStr,
		ObjectiveContext: memo,
		Tags:             tagList,
		AiAnalysis:       ai,
	}, nil
}

// parseOptionalTags 省略 / null / [] → []；非数组或元素非 string → 错误。
func parseOptionalTags(raw any) ([]string, error) {
	if raw == nil {
		return []string{}, nil
	}
	arr, ok := raw.([]any)
	if !ok {
		if sl, ok2 := raw.([]string); ok2 {
			return sl, nil
		}
		return nil, fmt.Errorf("tags must be an array of strings")
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("tags must be an array of strings")
		}
		out = append(out, s)
	}
	return out, nil
}

// ParseNumberBatch 解析 POST /api/log/numbers body（含 UseNumber JSON 解码）。
// 顶层 happened_at 必填整单共享；entries 长度 1..Max；
// 非数组 / 空 / 超上限 → 顶层错误（无 index）；逐条错误带 entries[i]: 前缀。
func ParseNumberBatch(raw []byte) (NormalizedNumberBatch, error) {
	if err := jsonutil.RejectUnknownObjectKeys(raw, logNumbersKeys); err != nil {
		return NormalizedNumberBatch{}, err
	}
	var body LogNumbersBody
	if err := jsonutil.DecodeUseNumber(raw, &body); err != nil {
		return NormalizedNumberBatch{}, err
	}
	happenedRaw, _ := body.HappenedAt.(string)
	happenedAt, utcOffset, err := draft.ParseHappenedAt(happenedRaw)
	if err != nil {
		return NormalizedNumberBatch{}, err
	}
	if body.Entries == nil {
		return NormalizedNumberBatch{}, fmt.Errorf("Missing required field: entries (non-empty array)")
	}
	entryList, ok := body.Entries.([]any)
	if !ok {
		return NormalizedNumberBatch{}, fmt.Errorf("Missing required field: entries (non-empty array)")
	}
	if len(entryList) == 0 {
		return NormalizedNumberBatch{}, fmt.Errorf("entries must be a non-empty array")
	}
	if len(entryList) > MaxNumberEntries {
		return NormalizedNumberBatch{}, fmt.Errorf("entries must contain at most %d items", MaxNumberEntries)
	}

	entries := make([]NormalizedNumberEntry, 0, len(entryList))
	for i, rawEntry := range entryList {
		parsed, err := parseEntry(rawEntry, i)
		if err != nil {
			return NormalizedNumberBatch{}, err
		}
		entries = append(entries, parsed)
	}

	return NormalizedNumberBatch{
		HappenedAt: happenedAt,
		UtcOffset:  utcOffset,
		Entries:    entries,
	}, nil
}
