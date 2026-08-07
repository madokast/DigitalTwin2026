package logapi

import (
	"fmt"

	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

type TextBody struct {
	HappenedAt       any `json:"happened_at"`
	RawContent       any `json:"raw_content"`
	ObjectiveContext any `json:"objective_context"`
	AiAnalysis       any `json:"ai_analysis"`
	Tags             any `json:"tags"`
}

var logTextKeys = []string{
	"happened_at", "raw_content", "objective_context",
	"ai_analysis", "tags",
}

// ParseTextBody 纯解析（reject unknown keys + decode，不校验语义）：route 层调用，
// 产出的 typed body 传给 CreateText（业务层校验 + 落库）。
func ParseTextBody(raw []byte) (TextBody, *myerr.MyError) {
	var body TextBody
	if me := jsonutil.RejectUnknownObjectKeys(raw, logTextKeys); me != nil {
		return TextBody{}, me
	}
	if me := jsonutil.DecodeUseNumber(raw, &body); me != nil {
		return TextBody{}, me
	}
	return body, nil
}

func happenedAtString(raw any) string {
	s, _ := raw.(string)
	return s
}

// optionalTagList 与 Next createNumber/createText：省略 / null / [] → []；
// 非数组或元素非 string → tags must be an array of strings（与 Next draft 一致）。
func optionalTagList(raw any) ([]string, *myerr.MyError) {
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
	out := make([]string, 0, len(tagList))
	for _, item := range tagList {
		s, ok := item.(string)
		if !ok {
			return nil, myerr.NewValidation("tags must be an array of strings")
		}
		out = append(out, s)
	}
	if dup := tags.FirstDuplicateTag(out); dup != "" {
		return nil, myerr.NewValidation(fmt.Sprintf("duplicate tag \"%s\"", dup))
	}
	return out, nil
}

// CreateText 与 Next createText 对齐：校验 + INSERT。收 typed 请求体（route 层已
