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

// TransactionEntryInput 单条 entry 原始输入。
type TransactionEntryInput struct {
	Amount      any    `json:"amount"`
	Memo        string `json:"memo"`
	Category    string `json:"category"`
	Subcategory string `json:"subcategory"`
}

// LogTransactionBody POST /api/log/transaction 请求体。
type LogTransactionBody struct {
	HappenedAt string                  `json:"happened_at"`
	Type       string                  `json:"type"`
	Entries    []TransactionEntryInput `json:"entries"`
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

func parseType(raw string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("Missing required field: type")
	}
	if raw != "income" && raw != "expense" {
		return "", fmt.Errorf(`type must be "income" or "expense"`)
	}
	return raw, nil
}

func parseAmount(raw any) (string, error) {
	if raw == nil {
		return "", fmt.Errorf("Missing required field: amount")
	}
	switch v := raw.(type) {
	case json.Number:
		return "", fmt.Errorf("%s", AmountMustBeString)
	case float64, float32, int, int64, int32:
		return "", fmt.Errorf("%s", AmountMustBeString)
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
	default:
		return "", fmt.Errorf("Invalid amount")
	}
}

func parseSegment(raw, field string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("Missing required field: %s", field)
	}
	if strings.ContainsAny(raw, " \t\n\r") || strings.Contains(raw, ":") || !segmentPattern.MatchString(raw) {
		return "", fmt.Errorf("Invalid %s: must be a single identifier without spaces or colons", field)
	}
	return raw, nil
}

func parseEntry(raw TransactionEntryInput, index int, typ string) (NormalizedTransactionEntry, error) {
	prefix := fmt.Sprintf("entries[%d]: ", index)
	amount, err := parseAmount(raw.Amount)
	if err != nil {
		return NormalizedTransactionEntry{}, fmt.Errorf("%s%s", prefix, err.Error())
	}
	if raw.Memo == "" {
		return NormalizedTransactionEntry{}, fmt.Errorf("%sMissing required field: memo", prefix)
	}
	category, err := parseSegment(raw.Category, "category")
	if err != nil {
		return NormalizedTransactionEntry{}, fmt.Errorf("%s%s", prefix, err.Error())
	}
	subcategory, err := parseSegment(raw.Subcategory, "subcategory")
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
		Memo:   raw.Memo,
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
	happenedAt, err := draft.ParseHappenedAt(body.HappenedAt)
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
	if len(body.Entries) == 0 {
		return NormalizedTransactionBatch{}, fmt.Errorf("entries must be a non-empty array")
	}
	if len(body.Entries) > MaxTransactionEntries {
		return NormalizedTransactionBatch{}, fmt.Errorf("entries must contain at most %d items", MaxTransactionEntries)
	}

	entries := make([]NormalizedTransactionEntry, 0, len(body.Entries))
	for i, e := range body.Entries {
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
