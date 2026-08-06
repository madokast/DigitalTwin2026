// Package transactiondraft：交易 batch 纯解析（与 src/lib/transactiondraft.ts 对齐）。
package transactiondraft

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

const MaxTransactionEntries = 100

var segmentPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// 金额形态：可选负号、整数至多 12 位或至多两位小数；禁 +、空格、残缺点、前导零；绝对值 ≤ 999999999999.99
var moneyAmountPattern = regexp.MustCompile(`^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$`)

const (
	ErrAmountMustBeString = "amount must be a decimal string"
	ErrInvalidAmount      = "invalid amount: non-zero decimal string, optional leading minus (no plus), at most 2 fractional digits, absolute value at most 999999999999.99, no spaces; e.g. 10, 10.5, 10.50, -1.5"
)

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

// NormalizedTransactionBatch 校验后的整单。HappenedAtRaw 为已校验的 happened_at 请求串。
type NormalizedTransactionBatch struct {
	HappenedAtRaw string
	Type          string
	Entries       []NormalizedTransactionEntry
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

// SumMoneyAmounts 恰好两位小数字符串列表 → 代数合计（定点分，无 float；与 summary 一致）。
// 例：["12.50","-3.00"] → "9.50"。单笔上限 999999999999.99 → 分 1e14；100 笔总量远小于 int64。
func SumMoneyAmounts(amounts []string) string {
	var cents int64
	for _, amount := range amounts {
		cents += centsFromAmount(amount)
	}
	neg := cents < 0
	if neg {
		cents = -cents
	}
	return fmt.Sprintf("%s%d.%02d", negSign(neg), cents/100, cents%100)
}

func centsFromAmount(amount string) int64 {
	neg := strings.HasPrefix(amount, "-")
	body := amount
	if neg {
		body = amount[1:]
	}
	body = strings.Replace(body, ".", "", 1)
	var v int64
	// moneyAmountPattern 保证 body 是纯十进制整数，Sscanf 必然成功（防御性忽略失败）。
	if _, err := fmt.Sscanf(body, "%d", &v); err != nil {
		return 0
	}
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

func NormalizeMoneyAmount(s string) string {
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

func parseType(raw any) (string, *myerr.MyError) {
	if raw == nil || raw == "" {
		return "", myerr.NewValidation("missing required field: type")
	}
	s, ok := raw.(string)
	if !ok || (s != "income" && s != "expense") {
		return "", myerr.NewValidation(`type must be "income" or "expense"`)
	}
	return s, nil
}

func parseAmount(raw any) (string, *myerr.MyError) {
	if raw == nil {
		return "", myerr.NewValidation("missing required field: amount")
	}
	switch v := raw.(type) {
	case string:
		trimmed := strings.TrimSpace(v)
		if !moneyAmountPattern.MatchString(trimmed) {
			return "", myerr.NewValidation(ErrInvalidAmount)
		}
		if IsZeroDecimalLiteral(trimmed) {
			return "", myerr.NewValidation(ErrInvalidAmount)
		}
		return NormalizeMoneyAmount(trimmed), nil
	case float64, json.Number:
		return "", myerr.NewValidation(ErrAmountMustBeString)
	default:
		return "", myerr.NewValidation(ErrInvalidAmount)
	}
}

func parseSegment(raw any, field string) (string, *myerr.MyError) {
	s, ok := raw.(string)
	if !ok || s == "" {
		return "", myerr.NewValidation(fmt.Sprintf("missing required field: %s", field))
	}
	// 仅 ASCII 空白（与 Next /[ \t\n\r]/ 一致；不用 unicode.IsSpace）
	if strings.ContainsAny(s, " \t\n\r") || strings.Contains(s, ":") || !segmentPattern.MatchString(s) {
		return "", myerr.NewValidation(fmt.Sprintf("invalid %s: must be a single identifier without spaces or colons", field))
	}
	return s, nil
}

func parseEntry(raw any, index int, typ string) (NormalizedTransactionEntry, *myerr.MyError) {
	prefix := fmt.Sprintf("entries[%d]: ", index)
	if raw == nil {
		return NormalizedTransactionEntry{}, myerr.NewValidation(fmt.Sprintf("entries[%d] must be an object", index))
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return NormalizedTransactionEntry{}, myerr.NewValidation(fmt.Sprintf("entries[%d] must be an object", index))
	}
	if me := jsonutil.RejectUnknownMapKeys(m, transactionEntryKeys, prefix); me != nil {
		return NormalizedTransactionEntry{}, me
	}
	entry := TransactionEntryInput{
		Amount:      m["amount"],
		Memo:        m["memo"],
		Category:    m["category"],
		Subcategory: m["subcategory"],
	}
	amount, me := parseAmount(entry.Amount)
	if me != nil {
		return NormalizedTransactionEntry{}, myerr.NewValidation(fmt.Sprintf("%s%s", prefix, me.Message))
	}
	memo, me := draft.RequireTrimmedText(entry.Memo, "memo")
	if me != nil {
		return NormalizedTransactionEntry{}, myerr.NewValidation(fmt.Sprintf("%s%s", prefix, me.Message))
	}
	category, me := parseSegment(entry.Category, "category")
	if me != nil {
		return NormalizedTransactionEntry{}, myerr.NewValidation(fmt.Sprintf("%s%s", prefix, me.Message))
	}
	subcategory, me := parseSegment(entry.Subcategory, "subcategory")
	if me != nil {
		return NormalizedTransactionEntry{}, myerr.NewValidation(fmt.Sprintf("%s%s", prefix, me.Message))
	}
	composite := category + ":" + subcategory
	if !tags.IsValidTag(composite) {
		return NormalizedTransactionEntry{}, myerr.NewValidation(fmt.Sprintf("%sinvalid category/subcategory combination", prefix))
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
func ParseTransactionBatch(raw []byte) (NormalizedTransactionBatch, *myerr.MyError) {
	if me := jsonutil.RejectUnknownObjectKeys(raw, logTransactionsKeys); me != nil {
		return NormalizedTransactionBatch{}, me
	}
	var body LogTransactionsBody
	if me := jsonutil.DecodeUseNumber(raw, &body); me != nil {
		return NormalizedTransactionBatch{}, me
	}
	happenedRaw, _ := body.HappenedAt.(string)
	if me := draft.ValidateHappenedAt(happenedRaw); me != nil {
		return NormalizedTransactionBatch{}, me
	}
	typ, me := parseType(body.Type)
	if me != nil {
		return NormalizedTransactionBatch{}, me
	}
	if body.Entries == nil {
		return NormalizedTransactionBatch{}, myerr.NewValidation("missing required field: entries (non-empty array)")
	}
	entryList, ok := body.Entries.([]any)
	if !ok {
		return NormalizedTransactionBatch{}, myerr.NewValidation("missing required field: entries (non-empty array)")
	}
	if len(entryList) == 0 {
		return NormalizedTransactionBatch{}, myerr.NewValidation("entries must be a non-empty array")
	}
	if len(entryList) > MaxTransactionEntries {
		return NormalizedTransactionBatch{}, myerr.NewValidation(fmt.Sprintf("entries must contain at most %d items", MaxTransactionEntries))
	}

	entries := make([]NormalizedTransactionEntry, 0, len(entryList))
	for i, e := range entryList {
		ne, me := parseEntry(e, i, typ)
		if me != nil {
			return NormalizedTransactionBatch{}, me
		}
		entries = append(entries, ne)
	}
	return NormalizedTransactionBatch{
		HappenedAtRaw: happenedRaw,
		Type:          typ,
		Entries:       entries,
	}, nil
}
