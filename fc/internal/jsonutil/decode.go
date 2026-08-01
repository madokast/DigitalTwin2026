// Package jsonutil：HTTP body JSON 解码，与 Next JSON.parse / encoding/json.Unmarshal 对齐。
package jsonutil

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// ErrInvalidJSONBody 与 Next INVALID_JSON_BODY 同文案。
var ErrInvalidJSONBody = errors.New("Invalid JSON body")

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
