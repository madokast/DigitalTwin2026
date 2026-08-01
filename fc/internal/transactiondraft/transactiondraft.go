// Package transactiondraft：交易 batch 纯解析（与 src/lib/transactiondraft.ts 对齐）。
package transactiondraft

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/mdk/digitaltwin2026/fc/internal/draft"
	"github.com/mdk/digitaltwin2026/fc/internal/tags"
)

const MaxTransactionEntries = 100

var segmentPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

const AmountMustBeString = "amount must be a decimal string"
const AmountMustNotBeZero = "amount must not be zero"

// TransactionEntryInput 单条 entry 原始输入（any：字段级校验文案与 Next 对齐）。
type TransactionEntryInput struct {
	Amount      any `json:"amount"`
	Memo        any `json:"memo"`
	Category    any `json:"category"`
	Subcategory any `json:"subcategory"`
}

// LogTransactionBody POST /api/log/transaction 请求体。
type LogTransactionBody struct {
	HappenedAt any `json:"happened_at"`
	Type       any `json:"type"`
	Entries    any `json:"entries"`
}

// NormalizedTransactionEntry 校验后的单条 entry。
type NormalizedTransactionEntry struct {
	Amount string
	Memo   string
	Tags   []string
}

// NormalizedTransactionBatch 校验后的整单。
type NormalizedTransactionBatch struct {
	HappenedAt time.Time
	Type       string
	Entries    []NormalizedTransactionEntry
}

// IsZeroDecimalLiteral 已通过 decimal 校验的字面量是否为零（含 -0 / 0.00）。
func IsZeroDecimalLiteral(s string) bool {
	digits := strings.TrimPrefix(s, "-")
	digits = strings.ReplaceAll(digits, ".", "")
	if digits == "" {
		return false
	}
	for _, c := range digits {
		if c != '0' {
			return false
		}
	}
	return true
}

func parseType(raw any) (string, error) {
	if raw == nil || raw == "" {
		return "", fmt.Errorf("Missing required field: type")
	}
	s, ok := raw.(string)
	if !ok || (s != "income" && s != "expense") {
		return "", fmt.Errorf(`type must be "income" or "expense"`)
	}
	return s, nil
}

func parseAmount(raw any) (string, error) {
	if raw == nil {
		return "", fmt.Errorf("Missing required field: amount")
	}
	switch v := raw.(type) {
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return "", fmt.Errorf("Missing required field: amount")
		}
		if err := draft.ValidateDecimalString(trimmed); err != nil {
			return "", fmt.Errorf("Invalid amount")
		}
		if IsZeroDecimalLiteral(trimmed) {
			return "", fmt.Errorf("%s", AmountMustNotBeZero)
		}
		return trimmed, nil
	case float64, json.Number:
		return "", fmt.Errorf("%s", AmountMustBeString)
	default:
		return "", fmt.Errorf("Invalid amount")
	}
}

func parseSegment(raw any, field string) (string, error) {
	s, ok := raw.(string)
	if !ok || s == "" {
		return "", fmt.Errorf("Missing required field: %s", field)
	}
	// 仅 ASCII 空白（与 Next /[ \t\n\r]/ 一致；不用 unicode.IsSpace）
	if strings.ContainsAny(s, " \t\n\r") || strings.Contains(s, ":") || !segmentPattern.MatchString(s) {
		return "", fmt.Errorf("Invalid %s: must be a single identifier without spaces or colons", field)
	}
	return s, nil
}

func parseEntry(raw any, index int, typ string) (NormalizedTransactionEntry, error) {
	prefix := fmt.Sprintf("entries[%d]: ", index)
	if raw == nil {
		return NormalizedTransactionEntry{}, fmt.Errorf("entries[%d] must be an object", index)
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return NormalizedTransactionEntry{}, fmt.Errorf("entries[%d] must be an object", index)
	}
	entry := TransactionEntryInput{
		Amount:      m["amount"],
		Memo:        m["memo"],
		Category:    m["category"],
		Subcategory: m["subcategory"],
	}
	amount, err := parseAmount(entry.Amount)
	if err != nil {
		return NormalizedTransactionEntry{}, fmt.Errorf("%s%s", prefix, err.Error())
	}
	memo, ok := entry.Memo.(string)
	if !ok || memo == "" {
		return NormalizedTransactionEntry{}, fmt.Errorf("%sMissing required field: memo", prefix)
	}
	category, err := parseSegment(entry.Category, "category")
	if err != nil {
		return NormalizedTransactionEntry{}, fmt.Errorf("%s%s", prefix, err.Error())
	}
	subcategory, err := parseSegment(entry.Subcategory, "subcategory")
	if err != nil {
		return NormalizedTransactionEntry{}, fmt.Errorf("%s%s", prefix, err.Error())
	}
	composite := category + ":" + subcategory
	if !tags.IsValidTag(composite) {
		return NormalizedTransactionEntry{}, fmt.Errorf("%sInvalid category/subcategory combination", prefix)
	}
	// 语义：type + 正 amount = 正常；type + 负 amount = 该类型冲销。
	// 整单共用 type；落库 tags 含 transaction_entry:{type}。
	return NormalizedTransactionEntry{
		Amount: amount,
		Memo:   memo,
		Tags:   []string{tags.TransactionEntryTypeTag(typ), composite},
	}, nil
}

// ParseTransactionBatch 解析 POST /api/log/transaction body（含 UseNumber JSON 解码）。
// 必填顶层 type（income|expense）；entries 长度 1..Max；amount 为零 → 错误。
func ParseTransactionBatch(raw []byte) (NormalizedTransactionBatch, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var body LogTransactionBody
	if err := dec.Decode(&body); err != nil {
		return NormalizedTransactionBatch{}, fmt.Errorf("Invalid JSON body")
	}
	happenedRaw, _ := body.HappenedAt.(string)
	happenedAt, err := draft.ParseHappenedAt(happenedRaw)
	if err != nil {
		return NormalizedTransactionBatch{}, err
	}
	typ, err := parseType(body.Type)
	if err != nil {
		return NormalizedTransactionBatch{}, err
	}
	if body.Entries == nil {
		return NormalizedTransactionBatch{}, fmt.Errorf("Missing required field: entries (non-empty array)")
	}
	entryList, ok := body.Entries.([]any)
	if !ok {
		return NormalizedTransactionBatch{}, fmt.Errorf("Missing required field: entries (non-empty array)")
	}
	if len(entryList) == 0 {
		return NormalizedTransactionBatch{}, fmt.Errorf("entries must be a non-empty array")
	}
	if len(entryList) > MaxTransactionEntries {
		return NormalizedTransactionBatch{}, fmt.Errorf("entries must contain at most %d items", MaxTransactionEntries)
	}

	entries := make([]NormalizedTransactionEntry, 0, len(entryList))
	for i, e := range entryList {
		ne, err := parseEntry(e, i, typ)
		if err != nil {
			return NormalizedTransactionBatch{}, err
		}
		entries = append(entries, ne)
	}
	return NormalizedTransactionBatch{
		HappenedAt: happenedAt,
		Type:       typ,
		Entries:    entries,
	}, nil
}
