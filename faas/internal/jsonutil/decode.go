// Package jsonutil：HTTP body JSON 解码，与 Next JSON.parse / encoding/json.Unmarshal 对齐。
package jsonutil

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
)

// ErrInvalidJSONBody 与 Next INVALID_JSON_BODY 同文案。
var ErrInvalidJSONBody = errors.New("invalid JSON body")

// ErrBodyMustBeObject 与 Next BODY_MUST_BE_OBJECT 同文案。
var ErrBodyMustBeObject = errors.New("request body must be a JSON object")

// UnknownJSONKeyPrefix 与 Next UNKNOWN_JSON_KEY_PREFIX 对齐。
const UnknownJSONKeyPrefix = "Unknown JSON key: "

// DecodeUseNumber 解码恰好一个 JSON 值（保留数字为 json.Number），拒绝尾部垃圾。
// json.Decoder 默认会忽略首个值之后的内容；此处与 Unmarshal / JSON.parse 对齐。
func DecodeUseNumber(raw []byte, dest any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(dest); err != nil {
		return ErrInvalidJSONBody
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return ErrInvalidJSONBody
	}
	return nil
}

// RejectUnknownObjectKeys 要求 raw 为 JSON object，且键 ⊆ allowed。
// 未知键按名字排序后取第一个，文案 Unknown JSON key: <name>（与 Next rejectUnknownKeys 对齐）。
func RejectUnknownObjectKeys(raw []byte, allowed []string) error {
	var v any
	if err := DecodeUseNumber(raw, &v); err != nil {
		return ErrInvalidJSONBody
	}
	m, ok := v.(map[string]any)
	if !ok {
		return ErrBodyMustBeObject
	}
	set := make(map[string]struct{}, len(allowed))
	for _, k := range allowed {
		set[k] = struct{}{}
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if _, ok := set[k]; !ok {
			return fmt.Errorf("%s%s", UnknownJSONKeyPrefix, k)
		}
	}
	return nil
}

// RejectUnknownMapKeys 校验已解码的 object map（如 transaction entry）。
func RejectUnknownMapKeys(m map[string]any, allowed []string, keyPrefix string) error {
	set := make(map[string]struct{}, len(allowed))
	for _, k := range allowed {
		set[k] = struct{}{}
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if _, ok := set[k]; !ok {
			return fmt.Errorf("%s%s%s", keyPrefix, UnknownJSONKeyPrefix, k)
		}
	}
	return nil
}
