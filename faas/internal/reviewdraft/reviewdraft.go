// Package reviewdraft：复盘记录纯解析与落库 tags 组装（与 src/lib/reviewdraft.ts 同构）。
package reviewdraft

import (
	"errors"
	"fmt"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

// cadences 复盘周期枚举（严格小写；与 Next REVIEW_CADENCES 一致）。
var cadences = []string{"daily", "weekly", "monthly", "quarterly", "semiannually", "yearly"}

// ErrInvalidCadenceMessage 与 Next INVALID_CADENCE_MESSAGE 同文案：回显全部可用值。
var ErrInvalidCadenceMessage = errors.New("invalid cadence: must be one of daily, weekly, monthly, quarterly, semiannually, yearly")

// ErrMissingCadenceMessage 与 Next MISSING_CADENCE_MESSAGE 同文案。
var ErrMissingCadenceMessage = errors.New("missing required field: cadence")

// logReviewKeys 允许的请求键（strict unknown-key）。
var logReviewKeys = []string{
	"happened_at", "cadence", "raw_content",
	"objective_context", "ai_analysis", "tags",
}

type ReviewBody struct {
	HappenedAt       any `json:"happened_at"`
	Cadence          any `json:"cadence"`
	RawContent       any `json:"raw_content"`
	ObjectiveContext any `json:"objective_context"`
	AiAnalysis       any `json:"ai_analysis"`
	Tags             any `json:"tags"`
}

// NormalizedReview 归一化复盘草稿（不含自动附加的 review:* tag；由组装函数负责）。
type NormalizedReview struct {
	HappenedAt       time.Time
	UtcOffset        string
	Cadence          string
	RawContent       string
	ObjectiveContext string
	AiAnalysis       *string
	Tags             []string
}

// ReviewTagForCadence 组装 review:{cadence} 落库 tag。
func ReviewTagForCadence(cadence string) string {
	return "review:" + cadence
}

// ReviewTagsForCadence 落库 tags：review:{cadence} 在最前 + 客户端附加 tag（服务端专用，不再过保留前缀校验）。
func ReviewTagsForCadence(cadence string, clientTags []string) []string {
	out := make([]string, 0, 1+len(clientTags))
	out = append(out, ReviewTagForCadence(cadence))
	out = append(out, clientTags...)
	return out
}

func isCadence(s string) bool {
	for _, c := range cadences {
		if s == c {
			return true
		}
	}
	return false
}

// ParseReview 校验复盘创建请求并归一化（纯解析，不落库）。
// cadence 必填、严格小写、不 trim。
func ParseReview(raw []byte) (NormalizedReview, error) {
	if err := jsonutil.RejectUnknownObjectKeys(raw, logReviewKeys); err != nil {
		return NormalizedReview{}, err
	}
	var body ReviewBody
	if err := jsonutil.DecodeUseNumber(raw, &body); err != nil {
		return NormalizedReview{}, err
	}

	happenedRaw, ok := body.HappenedAt.(string)
	if !ok {
		happenedRaw = ""
	}
	happenedAt, utcOffset, err := draft.ParseHappenedAt(happenedRaw)
	if err != nil {
		return NormalizedReview{}, err
	}

	cadenceStr, ok := body.Cadence.(string)
	if !ok || cadenceStr == "" {
		return NormalizedReview{}, fmt.Errorf("%w", ErrMissingCadenceMessage)
	}
	if !isCadence(cadenceStr) {
		return NormalizedReview{}, fmt.Errorf("%w", ErrInvalidCadenceMessage)
	}

	rawContent, err := draft.RequireTrimmedText(body.RawContent, "raw_content")
	if err != nil {
		return NormalizedReview{}, err
	}

	objCtx, err := draft.RequireTrimmedText(body.ObjectiveContext, "objective_context")
	if err != nil {
		return NormalizedReview{}, err
	}

	aiAnalysis, err := draft.OptionalTrimmedNullable(body.AiAnalysis, "ai_analysis")
	if err != nil {
		return NormalizedReview{}, err
	}

	clientTags, err := parseOptionalClientTags(body.Tags)
	if err != nil {
		return NormalizedReview{}, err
	}

	return NormalizedReview{
		HappenedAt:       happenedAt,
		UtcOffset:        utcOffset,
		Cadence:          cadenceStr,
		RawContent:       rawContent,
		ObjectiveContext: objCtx,
		AiAnalysis:       aiAnalysis,
		Tags:             clientTags,
	}, nil
}

// parseOptionalClientTags 客户端附加 tag（省略 / null / [] → 空）；拒绝非法与保留前缀。
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
				`invalid tag: "%s". Tags must contain only letters, numbers, underscores, and cannot start with a number`,
				tag,
			)
		}
	}
	if rv := tags.AssertNoReservedTags(out); !rv.Valid {
		return nil, fmt.Errorf("%s", rv.Error)
	}
	if dup := tags.FirstDuplicateTag(out); dup != "" {
		return nil, fmt.Errorf("duplicate tag \"%s\"", dup)
	}
	return out, nil
}
