// Package transactiondraft：交易 batch 纯解析（与 src/lib/transactiondraft.ts 对齐）。
package transactiondraft

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

const MaxTransactionEntries = 100

var segmentPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// 金额形态：可选负号、整数至多 12 位或至多两位小数；禁 +、空格、残缺点、前导零；绝对值 ≤ 999999999999.99
var moneyAmountPattern = regexp.MustCompile(`^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$`)

const AmountMustBeString = "amount must be a decimal string"
const InvalidAmount = "Invalid amount: non-zero decimal string, optional leading minus (no plus), at most 2 fractional digits, absolute value at most 999999999999.99, no spaces; e.g. 10, 10.5, 10.50, -1.5"

// TransactionEntryInput 单条 entry 原始输入（any：字段级校验文案与 Next 对齐）。
type TransactionEntryInput struct {
	Amount      any `json:"amount"`
	Memo        any `json:"memo"`
	Category    any `json:"category"`
	Subcategory any `json:"subcategory"`
}

// LogTransactionsBody POST /api/log/transactions 请求体。
type LogTransactionsBody struct {
	HappenedAt any `json:"happened_at"`
	Type       any `json:"type"`
	Entries    any `json:"entries"`
}

var logTransactionsKeys = []string{
	"happened_at", "type", "entries",
}

var transactionEntryKeys = []string{
	"amount", "memo", "category", "subcategory",
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
	UtcOffset  string
	Type       string
	Entries    []NormalizedTransactionEntry
}

// IsZeroDecimalLiteral 已通过金额正则的字面量是否为零（含 -0 / 0.00）。
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

// SumMoneyAmounts2 恰好两位小数字符串列表 → 代数合计（定点分，无 float；与 summary 一致）。
// 例：["12.50","-3.00"] → "9.50"。单笔上限 999999999999.99 → 分 1e14；100 笔总量远小于 int64。
func SumMoneyAmounts2(amounts []string) string {
	var cents int64
	for _, amount := range amounts {
		cents += centsFromAmount2(amount)
	}
	neg := cents < 0
	if neg {
		cents = -cents
	}
	return fmt.Sprintf("%s%d.%02d", negSign(neg), cents/100, cents%100)
}

func centsFromAmount2(amount string) int64 {
	neg := strings.HasPrefix(amount, "-")
	body := amount
	if neg {
		body = amount[1:]
	}
	body = strings.Replace(body, ".", "", 1)
	var v int64
	fmt.Sscanf(body, "%d", &v)
	if neg {
		v = -v
	}
	return v
}

func negSign(neg bool) string {
	if neg {
		return "-"
	}
	return ""
}

func NormalizeMoneyAmount2(s string) string {
	neg := strings.HasPrefix(s, "-")
	body := s
	if neg {
		body = s[1:]
	}
	dot := strings.IndexByte(body, '.')
	intPart := body
	fracPart := ""
	if dot >= 0 {
		intPart = body[:dot]
		fracPart = body[dot+1:]
	}
	for len(fracPart) < 2 {
		fracPart += "0"
	}
	if neg {
		return "-" + intPart + "." + fracPart
	}
	return intPart + "." + fracPart
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
		if !moneyAmountPattern.MatchString(trimmed) {
			return "", fmt.Errorf("%s", InvalidAmount)
		}
		if IsZeroDecimalLiteral(trimmed) {
			return "", fmt.Errorf("%s", InvalidAmount)
		}
		return NormalizeMoneyAmount2(trimmed), nil
	case float64, json.Number:
		return "", fmt.Errorf("%s", AmountMustBeString)
	default:
		return "", fmt.Errorf("%s", InvalidAmount)
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
	if err := jsonutil.RejectUnknownMapKeys(m, transactionEntryKeys, prefix); err != nil {
		return NormalizedTransactionEntry{}, err
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
	memo, err := draft.RequireTrimmedText(entry.Memo, "memo")
	if err != nil {
		return NormalizedTransactionEntry{}, fmt.Errorf("%s%s", prefix, err)
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

// ParseTransactionBatch 解析 POST /api/log/transactions body（含 UseNumber JSON 解码）。
// 必填顶层 type（income|expense）；entries 长度 1..Max；amount 经 MoneyAmount（含绝对值上限）校验后规范为两位小数。
func ParseTransactionBatch(raw []byte) (NormalizedTransactionBatch, error) {
	if err := jsonutil.RejectUnknownObjectKeys(raw, logTransactionsKeys); err != nil {
		return NormalizedTransactionBatch{}, err
	}
	var body LogTransactionsBody
	if err := jsonutil.DecodeUseNumber(raw, &body); err != nil {
		return NormalizedTransactionBatch{}, err
	}
	happenedRaw, _ := body.HappenedAt.(string)
	happenedAt, utcOffset, err := draft.ParseHappenedAt(happenedRaw)
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
		UtcOffset:  utcOffset,
		Type:       typ,
		Entries:    entries,
	}, nil
}
