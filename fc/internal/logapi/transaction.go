package logapi

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/fc/internal/draft"
	"github.com/mdk/digitaltwin2026/fc/internal/record"
	"github.com/mdk/digitaltwin2026/fc/internal/tags"
)

const maxTransactionEntries = 100

var segmentPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

const amountMustBeString = "amount must be a decimal string"
const amountMustNotBeZero = "amount must not be zero"

type transactionEntryRaw struct {
	Amount      any    `json:"amount"`
	Memo        string `json:"memo"`
	Category    string `json:"category"`
	Subcategory string `json:"subcategory"`
}

type transactionBody struct {
	HappenedAt string                `json:"happened_at"`
	Type       string                `json:"type"`
	Entries    []transactionEntryRaw `json:"entries"`
}

type normalizedEntry struct {
	amount string
	memo   string
	tags   []string
}

// isZeroDecimalLiteral 已通过 decimal 校验的字面量是否为零（含 -0 / 0.00）。
func isZeroDecimalLiteral(s string) bool {
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
		return "", fmt.Errorf("%s", amountMustBeString)
	case float64, float32, int, int64, int32:
		return "", fmt.Errorf("%s", amountMustBeString)
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return "", fmt.Errorf("Missing required field: amount")
		}
		if err := draft.ValidateDecimalString(trimmed); err != nil {
			return "", fmt.Errorf("Invalid amount")
		}
		if isZeroDecimalLiteral(trimmed) {
			return "", fmt.Errorf("%s", amountMustNotBeZero)
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

func parseEntry(raw transactionEntryRaw, index int, typ string) (normalizedEntry, error) {
	prefix := fmt.Sprintf("entries[%d]: ", index)
	amount, err := parseAmount(raw.Amount)
	if err != nil {
		return normalizedEntry{}, fmt.Errorf("%s%s", prefix, err.Error())
	}
	if raw.Memo == "" {
		return normalizedEntry{}, fmt.Errorf("%sMissing required field: memo", prefix)
	}
	category, err := parseSegment(raw.Category, "category")
	if err != nil {
		return normalizedEntry{}, fmt.Errorf("%s%s", prefix, err.Error())
	}
	subcategory, err := parseSegment(raw.Subcategory, "subcategory")
	if err != nil {
		return normalizedEntry{}, fmt.Errorf("%s%s", prefix, err.Error())
	}
	composite := category + ":" + subcategory
	if !tags.IsValidTag(composite) {
		return normalizedEntry{}, fmt.Errorf("%sInvalid category/subcategory combination", prefix)
	}
	// 语义：type + 正 amount = 正常；type + 负 amount = 该类型冲销。
	// 整单共用 type；落库 tags 含 transaction_entry:{type}。
	return normalizedEntry{
		amount: amount,
		memo:   raw.Memo,
		tags:   []string{tags.TransactionEntryTypeTag(typ), composite},
	}, nil
}

// CreateTransactionBatch 整单事务写入；成功返回 inserted 与行（供 Telegram 摘要）。
// Body 必填顶层 type（income|expense）；amount 为零 → 400。
func CreateTransactionBatch(ctx context.Context, pool *pgxpool.Pool, raw []byte) (int, []record.Record, int, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var body transactionBody
	if err := dec.Decode(&body); err != nil {
		return 0, nil, 400, fmt.Errorf("Invalid JSON body")
	}
	happenedAt, err := draft.ParseHappenedAt(body.HappenedAt)
	if err != nil {
		return 0, nil, 400, err
	}
	typ, err := parseType(body.Type)
	if err != nil {
		return 0, nil, 400, err
	}
	if body.Entries == nil {
		return 0, nil, 400, fmt.Errorf("Missing required field: entries (non-empty array)")
	}
	if len(body.Entries) == 0 {
		return 0, nil, 400, fmt.Errorf("entries must be a non-empty array")
	}
	if len(body.Entries) > maxTransactionEntries {
		return 0, nil, 400, fmt.Errorf("entries must contain at most %d items", maxTransactionEntries)
	}

	entries := make([]normalizedEntry, 0, len(body.Entries))
	for i, e := range body.Entries {
		ne, err := parseEntry(e, i, typ)
		if err != nil {
			return 0, nil, 400, err
		}
		entries = append(entries, ne)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, nil, 500, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := make([]record.Record, 0, len(entries))
	for _, e := range entries {
		id, err := uuid.NewV7()
		if err != nil {
			return 0, nil, 500, err
		}
		tagsJSON, err := record.TagsJSON(e.tags)
		if err != nil {
			return 0, nil, 500, err
		}
		amount := e.amount
		rec, err := insertReturning(
			ctx, tx, id.String(), happenedAt, &amount, nil,
			tagsJSON, e.memo, nil,
		)
		if err != nil {
			return 0, nil, 500, err
		}
		out = append(out, rec)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, nil, 500, err
	}
	return len(out), out, 201, nil
}
