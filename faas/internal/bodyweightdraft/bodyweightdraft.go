// Package bodyweightdraft：体重录入纯解析（与 src/lib/bodyweightdraft.ts 对齐）。
package bodyweightdraft

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/transactiondraft"
)

// 体重形态：正数、至多 3 位整数或至多两位小数；禁 +、负号、空格、残缺点、前导零。
var weightAmountPattern = regexp.MustCompile(`^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$`)

const InvalidWeight = "Invalid weight: positive decimal string from 1.00 to 500.00 inclusive, at most 2 fractional digits, no spaces; e.g. 75, 75.5, 75.50"

const weightMinCents = 100   // 1.00
const weightMaxCents = 50000 // 500.00

// LogBodyWeightBody POST /api/log/body/weight 请求体（any：字段级校验文案与 Next 对齐）。
type LogBodyWeightBody struct {
	HappenedAt               any `json:"happened_at"`
	ValueNumber              any `json:"value_number"`
	ObjectiveContext         any `json:"objective_context"`
	SubjectiveInterpretation any `json:"subjective_interpretation"`
	Tags                     any `json:"tags"`
}

var logBodyWeightKeys = []string{
	"happened_at", "value_number", "objective_context",
	"subjective_interpretation", "tags",
}

// NormalizedBodyWeight 校验后的体重行。
type NormalizedBodyWeight struct {
	HappenedAt               time.Time
	ValueNumber              string
	Tags                     []string
	ObjectiveContext         string
	SubjectiveInterpretation any // string or nil
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

// ParseWeightAmount 解析体重 value_number。
func ParseWeightAmount(raw any) (string, error) {
	if raw == nil {
		return "", fmt.Errorf("Missing required field: value_number")
	}
	switch v := raw.(type) {
	case string:
		// 禁止 TrimSpace：有空格 / 空串均走统一 InvalidWeight
		if !weightAmountPattern.MatchString(v) {
			return "", fmt.Errorf("%s", InvalidWeight)
		}
		stored := transactiondraft.NormalizeMoneyAmount2(v)
		if !WeightCentsInRange(stored) {
			return "", fmt.Errorf("%s", InvalidWeight)
		}
		return stored, nil
	case float64, json.Number:
		return "", fmt.Errorf("%s", draft.ValueNumberMustBeString)
	default:
		return "", fmt.Errorf("%s", InvalidWeight)
	}
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

func happenedAtString(raw any) string {
	s, _ := raw.(string)
	return s
}

// ParseBodyWeight 校验整单体重请求；落库 tags = [body:weight, ...clientTags]。
func ParseBodyWeight(raw []byte) (NormalizedBodyWeight, error) {
	if err := jsonutil.RejectUnknownObjectKeys(raw, logBodyWeightKeys); err != nil {
		return NormalizedBodyWeight{}, err
	}
	var body LogBodyWeightBody
	if err := jsonutil.DecodeUseNumber(raw, &body); err != nil {
		return NormalizedBodyWeight{}, err
	}

	happenedAt, err := draft.ParseHappenedAt(happenedAtString(body.HappenedAt))
	if err != nil {
		return NormalizedBodyWeight{}, err
	}
	valueNumber, err := ParseWeightAmount(body.ValueNumber)
	if err != nil {
		return NormalizedBodyWeight{}, err
	}
	objCtx, ok := body.ObjectiveContext.(string)
	if !ok || objCtx == "" {
		return NormalizedBodyWeight{}, fmt.Errorf("Missing required field: objective_context")
	}
	subj, err := optionalSubjective(body.SubjectiveInterpretation)
	if err != nil {
		return NormalizedBodyWeight{}, err
	}
	clientTags, err := parseOptionalClientTags(body.Tags)
	if err != nil {
		return NormalizedBodyWeight{}, err
	}

	tagsOut := make([]string, 0, 1+len(clientTags))
	tagsOut = append(tagsOut, tags.ReservedTagBodyWeight)
	tagsOut = append(tagsOut, clientTags...)

	return NormalizedBodyWeight{
		HappenedAt:               happenedAt,
		ValueNumber:              valueNumber,
		Tags:                     tagsOut,
		ObjectiveContext:         objCtx,
		SubjectiveInterpretation: subj,
	}, nil
}
