package query

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/fc/internal/record"
	"github.com/mdk/digitaltwin2026/fc/internal/tags"
	"github.com/mdk/digitaltwin2026/fc/internal/timeutil"
)

// ErrInvalidTZ 与 Next fetchSummary 文案一致；httpx 用 errors.Is 映射 400。
var ErrInvalidTZ = errors.New("Query parameter tz must be a valid IANA time zone")

var (
	isoTZSuffix = regexp.MustCompile(`(?i)(Z|[+-]\d{2}:?\d{2})$`)
	digitsOnly  = regexp.MustCompile(`^\d+$`)
)

type ParsedQuery struct {
	ID       string
	Page     int
	PageSize int
	From     *time.Time
	To       *time.Time
	Tags     []string
	Q        string
}

// RecordsListOrderBy 列表查询固定排序（与 Next RECORDS_LIST_ORDER_BY_SQL、
// testdata/query-records-list-order.json 对齐）。
// happened_at 升序；同时间戳用 id ASC（UUIDv7 写入序）保证确定性。无 order 查询参数。
const RecordsListOrderBy = "happened_at ASC, id ASC"

func orderByRecordsList() string {
	return " ORDER BY " + RecordsListOrderBy
}

func parsePositiveInt(raw string, fallback int) (int, error) {
	if raw == "" {
		return fallback, nil
	}
	if !digitsOnly.MatchString(raw) {
		return 0, fmt.Errorf("invalid")
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("invalid")
	}
	// 与 Next Number.MAX_SAFE_INTEGER 对齐，避免 JS Number 精度丢失造成双端分叉
	const maxSafeInt = 9007199254740991
	if n > maxSafeInt {
		return 0, fmt.Errorf("invalid")
	}
	return n, nil
}

func parseIsoDate(raw, label string) (*time.Time, error) {
	if raw == "" {
		return nil, nil
	}
	if !isoTZSuffix.MatchString(raw) {
		return nil, fmt.Errorf("%s must be ISO 8601 with timezone (Z or ±HH:MM)", label)
	}
	t, err := timeutil.ParseRFC3339Flexible(raw)
	if err != nil {
		return nil, fmt.Errorf("Invalid %s datetime", label)
	}
	return &t, nil
}

func ParseRecordQueryParams(q url.Values) (*ParsedQuery, error) {
	page, err := parsePositiveInt(q.Get("page"), 1)
	if err != nil {
		return nil, fmt.Errorf("page must be a positive integer")
	}
	pageSize, err := parsePositiveInt(q.Get("pageSize"), 20)
	if err != nil || pageSize > 100 {
		return nil, fmt.Errorf("pageSize must be an integer between 1 and 100")
	}

	from, err := parseIsoDate(q.Get("from"), "from")
	if err != nil {
		return nil, err
	}
	to, err := parseIsoDate(q.Get("to"), "to")
	if err != nil {
		return nil, err
	}

	var tagList []string
	for _, tag := range q["tag"] {
		if tag != "" {
			tagList = append(tagList, tag)
		}
	}

	id := q.Get("id")
	if id != "" && !record.IsValidID(id) {
		return nil, record.InvalidID
	}

	return &ParsedQuery{
		ID:       id,
		Page:     page,
		PageSize: pageSize,
		From:     from,
		To:       to,
		Tags:     tagList,
		Q:        q.Get("q"),
	}, nil
}

// EscapeLikePattern 转义 LIKE 通配符（PostgreSQL 默认 ESCAPE '\'）。
// 与 Next escapeLikePattern 对齐：先 `\`，再 `%` / `_`。
func EscapeLikePattern(raw string) string {
	s := strings.ReplaceAll(raw, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

func buildWhere(p *ParsedQuery) (string, []any) {
	var parts []string
	var args []any
	n := 1

	if p.ID != "" {
		parts = append(parts, fmt.Sprintf("id = $%d", n))
		args = append(args, p.ID)
		n++
	}
	if p.From != nil {
		parts = append(parts, fmt.Sprintf("happened_at >= $%d", n))
		args = append(args, *p.From)
		n++
	}
	if p.To != nil {
		parts = append(parts, fmt.Sprintf("happened_at < $%d", n))
		args = append(args, *p.To)
		n++
	}
	for _, tag := range p.Tags {
		parts = append(parts, fmt.Sprintf("tags LIKE $%d", n))
		args = append(args, `%"`+EscapeLikePattern(tag)+`"%`)
		n++
	}
	if p.Q != "" {
		pattern := `%` + EscapeLikePattern(p.Q) + `%`
		parts = append(parts, fmt.Sprintf(
			`(value_text LIKE $%d OR objective_context LIKE $%d OR subjective_interpretation LIKE $%d OR tags LIKE $%d)`,
			n, n+1, n+2, n+3,
		))
		args = append(args, pattern, pattern, pattern, pattern)
	}

	if len(parts) == 0 {
		return "", nil
	}
	return strings.Join(parts, " AND "), args
}

func scanRecord(row pgx.Row) (record.Record, error) {
	var (
		id, tagsField, objectiveContext string
		happenedAt                      time.Time
		valueNumber, valueText, subj    *string
	)
	err := row.Scan(&id, &happenedAt, &valueNumber, &valueText, &tagsField, &objectiveContext, &subj)
	if err != nil {
		return record.Record{}, err
	}
	return record.FromDB(id, happenedAt, valueNumber, valueText, tagsField, objectiveContext, subj), nil
}

type FetchResult struct {
	Total    int
	Page     int
	PageSize int
	Records  []record.Record
}

func FetchFilteredRecords(ctx context.Context, pool *pgxpool.Pool, p *ParsedQuery) (*FetchResult, error) {
	where, args := buildWhere(p)
	countSQL := "SELECT count(*) FROM records"
	if where != "" {
		countSQL += " WHERE " + where
	}
	var total int
	if err := pool.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, err
	}

	selectSQL := `SELECT id, happened_at, value_number, value_text, tags, objective_context, subjective_interpretation
FROM records`
	if where != "" {
		selectSQL += " WHERE " + where
	}
	selectSQL += orderByRecordsList()

	if p.ID != "" {
		rows, err := pool.Query(ctx, selectSQL, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		recs := []record.Record{}
		for rows.Next() {
			rec, err := scanRecord(rows)
			if err != nil {
				return nil, err
			}
			recs = append(recs, rec)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		ps := len(recs)
		if ps == 0 {
			ps = 1
		}
		return &FetchResult{Total: total, Page: 1, PageSize: ps, Records: recs}, nil
	}

	offset := (p.Page - 1) * p.PageSize
	selectSQL += fmt.Sprintf(" LIMIT %d OFFSET %d", p.PageSize, offset)
	rows, err := pool.Query(ctx, selectSQL, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	recs := []record.Record{}
	for rows.Next() {
		rec, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		recs = append(recs, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &FetchResult{Total: total, Page: p.Page, PageSize: p.PageSize, Records: recs}, nil
}

type SummaryResult struct {
	Total int    `json:"total"`
	Today int    `json:"today"`
	TZ    string `json:"tz"`
}

func FetchSummary(ctx context.Context, pool *pgxpool.Pool, tz string, now time.Time) (*SummaryResult, error) {
	if !timeutil.IsValidTimeZone(tz) {
		return nil, ErrInvalidTZ
	}
	start, end, err := timeutil.GetZonedDayBounds(now, tz)
	if err != nil {
		return nil, ErrInvalidTZ
	}

	var total, today int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM records`).Scan(&total); err != nil {
		return nil, err
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM records WHERE happened_at >= $1 AND happened_at < $2`,
		start, end,
	).Scan(&today); err != nil {
		return nil, err
	}
	return &SummaryResult{Total: total, Today: today, TZ: tz}, nil
}

func FetchTagCounts(ctx context.Context, pool *pgxpool.Pool) (map[string]int, error) {
	rows, err := pool.Query(ctx, `SELECT tags FROM records`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var fields []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		fields = append(fields, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tags.AggregateTagCounts(fields)
}

// --- GET /api/query/transaction/summary ---

const (
	txEntryIncome  = "transaction_entry:income"
	txEntryExpense = "transaction_entry:expense"
)

var categoryPair = regexp.MustCompile(`^([a-zA-Z_][a-zA-Z0-9_]*):([a-zA-Z_][a-zA-Z0-9_]*)$`)

type MoneyBucket struct {
	Sum   string `json:"sum"`
	Count int    `json:"count"`
}

type SubcategoryBucket struct {
	Subcategory string `json:"subcategory"`
	Sum         string `json:"sum"`
	Count       int    `json:"count"`
}

type CategoryBucket struct {
	Category      string              `json:"category"`
	Sum           string              `json:"sum"`
	Count         int                 `json:"count"`
	Subcategories []SubcategoryBucket `json:"subcategories"`
}

type TransactionSummaryResult struct {
	Success           bool             `json:"success"`
	From              string           `json:"from"`
	To                string           `json:"to"`
	Income            MoneyBucket      `json:"income"`
	Expense           MoneyBucket      `json:"expense"`
	Net               string           `json:"net"`
	IncomeCategories  []CategoryBucket `json:"income_categories"`
	ExpenseCategories []CategoryBucket `json:"expense_categories"`
}

type TransactionSummaryRow struct {
	Tags        string
	ValueNumber *string
}

type ParsedTransactionSummaryRange struct {
	FromRaw string
	ToRaw   string
	From    time.Time
	To      time.Time
}

// ParseTransactionSummaryParams 强制 from/to；要求 from < to（与 Next 同文案）。
func ParseTransactionSummaryParams(q url.Values) (*ParsedTransactionSummaryRange, error) {
	fromRaw := q.Get("from")
	if fromRaw == "" {
		return nil, fmt.Errorf("Missing required query parameter: from")
	}
	toRaw := q.Get("to")
	if toRaw == "" {
		return nil, fmt.Errorf("Missing required query parameter: to")
	}
	from, err := parseIsoDate(fromRaw, "from")
	if err != nil {
		return nil, err
	}
	if from == nil {
		return nil, fmt.Errorf("Missing required query parameter: from")
	}
	to, err := parseIsoDate(toRaw, "to")
	if err != nil {
		return nil, err
	}
	if to == nil {
		return nil, fmt.Errorf("Missing required query parameter: to")
	}
	if !from.Before(*to) {
		return nil, fmt.Errorf("from must be earlier than to")
	}
	return &ParsedTransactionSummaryRange{
		FromRaw: fromRaw,
		ToRaw:   toRaw,
		From:    *from,
		To:      *to,
	}, nil
}

func formatMoney2(r *big.Rat) string {
	if r == nil {
		return "0.00"
	}
	return r.FloatString(2)
}

func classifyEntryType(tagList []string) string {
	var typ string
	for _, tag := range tagList {
		switch tag {
		case txEntryIncome:
			if typ != "" {
				return ""
			}
			typ = "income"
		case txEntryExpense:
			if typ != "" {
				return ""
			}
			typ = "expense"
		}
	}
	return typ
}

func findCategoryPair(tagList []string) (category, subcategory string, ok bool) {
	for _, tag := range tagList {
		if tag == "transaction_entry" || strings.HasPrefix(tag, "transaction_entry:") {
			continue
		}
		m := categoryPair.FindStringSubmatch(tag)
		if m != nil {
			return m[1], m[2], true
		}
	}
	return "", "", false
}

type accBucket struct {
	sum   *big.Rat
	count int
}

func newAcc() *accBucket {
	return &accBucket{sum: new(big.Rat)}
}

type catAcc struct {
	sum   *big.Rat
	count int
	subs  map[string]*accBucket
}

func ensureCat(m map[string]*catAcc, name string) *catAcc {
	c, ok := m[name]
	if !ok {
		c = &catAcc{sum: new(big.Rat), subs: map[string]*accBucket{}}
		m[name] = c
	}
	return c
}

type namedSum struct {
	name  string
	sum   *big.Rat
	count int
	subs  map[string]*accBucket
}

func sortNamedBySumThenName(items []namedSum) {
	sort.SliceStable(items, func(i, j int) bool {
		cmp := items[i].sum.Cmp(items[j].sum)
		if cmp != 0 {
			return cmp > 0 // sum 降序
		}
		return items[i].name < items[j].name
	})
}

func categoriesFromMap(cats map[string]*catAcc) []CategoryBucket {
	list := make([]namedSum, 0, len(cats))
	for name, c := range cats {
		list = append(list, namedSum{name: name, sum: c.sum, count: c.count, subs: c.subs})
	}
	sortNamedBySumThenName(list)
	out := make([]CategoryBucket, 0, len(list))
	for _, cat := range list {
		subList := make([]namedSum, 0, len(cat.subs))
		for subName, sub := range cat.subs {
			subList = append(subList, namedSum{name: subName, sum: sub.sum, count: sub.count})
		}
		sortNamedBySumThenName(subList)
		subs := make([]SubcategoryBucket, 0, len(subList))
		for _, s := range subList {
			subs = append(subs, SubcategoryBucket{
				Subcategory: s.name,
				Sum:         formatMoney2(s.sum),
				Count:       s.count,
			})
		}
		out = append(out, CategoryBucket{
			Category:      cat.name,
			Sum:           formatMoney2(cat.sum),
			Count:         cat.count,
			Subcategories: subs,
		})
	}
	return out
}

// AggregateTransactionSummary 内存聚合（与 Next aggregateTransactionSummary 同构）。
// 脏行跳过；非法 tags JSON / 非数组返回 error。
func AggregateTransactionSummary(rows []TransactionSummaryRow, fromRaw, toRaw string) (*TransactionSummaryResult, error) {
	income := newAcc()
	expense := newAcc()
	incomeCats := map[string]*catAcc{}
	expenseCats := map[string]*catAcc{}

	addTo := func(side, category, subcategory string, amount *big.Rat) {
		var top *accBucket
		var cats map[string]*catAcc
		if side == "income" {
			top = income
			cats = incomeCats
		} else {
			top = expense
			cats = expenseCats
		}
		top.sum.Add(top.sum, amount)
		top.count++
		cat := ensureCat(cats, category)
		cat.sum.Add(cat.sum, amount)
		cat.count++
		sub, ok := cat.subs[subcategory]
		if !ok {
			sub = newAcc()
			cat.subs[subcategory] = sub
		}
		sub.sum.Add(sub.sum, amount)
		sub.count++
	}

	for _, row := range rows {
		var parsed any
		if err := json.Unmarshal([]byte(row.Tags), &parsed); err != nil {
			return nil, err
		}
		arr, ok := parsed.([]any)
		if !ok {
			return nil, tags.ErrTagsNotJSONArray
		}
		tagList := make([]string, 0, len(arr))
		for _, item := range arr {
			if s, ok := item.(string); ok {
				tagList = append(tagList, s)
			}
		}
		entryType := classifyEntryType(tagList)
		if entryType == "" {
			continue
		}
		category, subcategory, ok := findCategoryPair(tagList)
		if !ok {
			continue
		}
		if row.ValueNumber == nil || *row.ValueNumber == "" {
			continue
		}
		amount := new(big.Rat)
		if _, ok := amount.SetString(*row.ValueNumber); !ok {
			continue
		}
		addTo(entryType, category, subcategory, amount)
	}

	incomeCatsOut := categoriesFromMap(incomeCats)
	expenseCatsOut := categoriesFromMap(expenseCats)
	if incomeCatsOut == nil {
		incomeCatsOut = []CategoryBucket{}
	}
	if expenseCatsOut == nil {
		expenseCatsOut = []CategoryBucket{}
	}

	net := new(big.Rat).Sub(income.sum, expense.sum)
	return &TransactionSummaryResult{
		Success:           true,
		From:              fromRaw,
		To:                toRaw,
		Income:            MoneyBucket{Sum: formatMoney2(income.sum), Count: income.count},
		Expense:           MoneyBucket{Sum: formatMoney2(expense.sum), Count: expense.count},
		Net:               formatMoney2(net),
		IncomeCategories:  incomeCatsOut,
		ExpenseCategories: expenseCatsOut,
	}, nil
}

// FetchTransactionSummary 拉取区间候选行并聚合。
func FetchTransactionSummary(ctx context.Context, pool *pgxpool.Pool, from, to time.Time, fromRaw, toRaw string) (*TransactionSummaryResult, error) {
	incomeLike := `%"` + EscapeLikePattern(txEntryIncome) + `"%`
	expenseLike := `%"` + EscapeLikePattern(txEntryExpense) + `"%`
	rows, err := pool.Query(ctx, `
SELECT tags, value_number FROM records
WHERE happened_at >= $1 AND happened_at < $2
  AND (tags LIKE $3 OR tags LIKE $4)`,
		from, to, incomeLike, expenseLike,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []TransactionSummaryRow
	for rows.Next() {
		var tagsField string
		var vn *string
		if err := rows.Scan(&tagsField, &vn); err != nil {
			return nil, err
		}
		list = append(list, TransactionSummaryRow{Tags: tagsField, ValueNumber: vn})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return AggregateTransactionSummary(list, fromRaw, toRaw)
}
