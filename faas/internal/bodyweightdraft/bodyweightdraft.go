// Package bodyweightdraft：体重录入纯解析（与 src/lib/bodyweightdraft.ts 对齐）。
package bodyweightdraft

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/transactiondraft"
)

// 体重形态：正数、至多 3 位整数或至多两位小数；禁 +、负号、空格、残缺点、前导零。
var weightAmountPattern = regexp.MustCompile(`^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$`)

const ErrInvalidWeight = "invalid weight: positive decimal string from 1.00 to 500.00 inclusive, at most 2 fractional digits, no spaces; e.g. 75, 75.5, 75.50"

const weightMinCents = 100   // 1.00
const weightMaxCents = 50000 // 500.00

// LogBodyWeightBody POST /api/log/body/weight 请求体（any：字段级校验文案与 Next 对齐）。
type LogBodyWeightBody struct {
	HappenedAt       any `json:"happened_at"`
	NumericValue     any `json:"numeric_value"`
	ObjectiveContext any `json:"objective_context"`
	AiAnalysis       any `json:"ai_analysis"`
	Tags             any `json:"tags"`
}

var logBodyWeightKeys = []string{
	"happened_at", "numeric_value", "objective_context",
	"ai_analysis", "tags",
}

// NormalizedBodyWeight 校验后的体重行。HappenedAtRaw 为已校验的 happened_at 请求串。
type NormalizedBodyWeight struct {
	HappenedAtRaw    string
	NumericValue     string
	Tags             []string
	ObjectiveContext string
	AiAnalysis       *string
}

// WeightCentsInRange 已通过体重正则并规范为两位小数的字面量是否在 [1.00, 500.00]。
func WeightCentsInRange(normalized2 string) bool {
	parts := strings.Split(normalized2, ".")
	if len(parts) != 2 {
		return false
	}
	intPart, err1 := strconv.Atoi(parts[0])
	fracPart, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return false
	}
	cents := intPart*100 + fracPart
	return cents >= weightMinCents && cents <= weightMaxCents
}

// ParseWeightAmount 解析体重 numeric_value（trim 后校验；存 trim 后值）。
func ParseWeightAmount(raw any) (string, *myerr.MyError) {
	if raw == nil {
		return "", myerr.NewValidation("missing required field: numeric_value")
	}
	switch v := raw.(type) {
	case string:
		trimmed := strings.TrimSpace(v)
		if !weightAmountPattern.MatchString(trimmed) {
			return "", myerr.NewValidation(ErrInvalidWeight)
		}
		stored := transactiondraft.NormalizeMoneyAmount(trimmed)
		if !WeightCentsInRange(stored) {
			return "", myerr.NewValidation(ErrInvalidWeight)
		}
		return stored, nil
	case float64, json.Number:
		return "", myerr.NewValidation(draft.ErrNumericValueMustBeString)
	default:
		return "", myerr.NewValidation(ErrInvalidWeight)
	}
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

func happenedAtString(raw any) string {
	s, _ := raw.(string)
	return s
}

// ParseBodyWeight 校验整单体重请求；落库 tags = [body:weight, ...clientTags]。
func ParseBodyWeight(raw []byte) (NormalizedBodyWeight, *myerr.MyError) {
	if me := jsonutil.RejectUnknownObjectKeys(raw, logBodyWeightKeys); me != nil {
		return NormalizedBodyWeight{}, me
	}
	var body LogBodyWeightBody
	if me := jsonutil.DecodeUseNumber(raw, &body); me != nil {
		return NormalizedBodyWeight{}, me
	}

	happenedRaw := happenedAtString(body.HappenedAt)
	if me := draft.ValidateHappenedAt(happenedRaw); me != nil {
		return NormalizedBodyWeight{}, me
	}
	numericValue, me := ParseWeightAmount(body.NumericValue)
	if me != nil {
		return NormalizedBodyWeight{}, me
	}
	objCtx, me := draft.RequireTrimmedText(body.ObjectiveContext, "objective_context")
	if me != nil {
		return NormalizedBodyWeight{}, me
	}
	subj, me := draft.OptionalTrimmedNullable(body.AiAnalysis, "ai_analysis")
	if me != nil {
		return NormalizedBodyWeight{}, me
	}
	clientTags, me := parseOptionalClientTags(body.Tags)
	if me != nil {
		return NormalizedBodyWeight{}, me
	}

	tagsOut := make([]string, 0, 1+len(clientTags))
	tagsOut = append(tagsOut, tags.ReservedTagBodyWeight)
	tagsOut = append(tagsOut, clientTags...)

	return NormalizedBodyWeight{
		HappenedAtRaw:    happenedRaw,
		NumericValue:     numericValue,
		Tags:             tagsOut,
		ObjectiveContext: objCtx,
		AiAnalysis:       subj,
	}, nil
}
