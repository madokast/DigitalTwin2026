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
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/timeutil"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

// ErrInvalidTZ 与 Next fetchSummary 文案一致；httpx 用 errors.Is 映射 400。
var ErrInvalidTZ = errors.New("Query parameter tz must be a valid IANA time zone")

// invalidTagQueryMsg 与 Next INVALID_TAG_QUERY 同文案；%s 为非法 tag 查询值。
const invalidTagQueryMsg = "Invalid tag query \"%s\": use a valid tag name or a family pattern \"tag=review:*\" (a single \"*\" at the end, prefix must be non-empty)"

// tagQueryWildcard 仅接受 `合法tag名:*` 尾缀通配；其余含 `*` 形态 → invalidTagQueryMsg。
var tagQueryWildcard = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+)*:\*$`)

// bareReservedTagHints 裸值永不被写入的保留前缀：query?tag=<这些值> 恒空，应提示用族通配。
// body:weight 例外（裸值即真实落库 tag，可命中）。
var bareReservedTagHints = map[string]bool{
	"transaction_entry": true,
	"todo":              true,
	"review":            true,
}

var (
	isoTZSuffix = regexp.MustCompile(`(?i)(Z|[+-]\d{2}:?\d{2})$`)
	digitsOnly  = regexp.MustCompile(`^\d+$`)
)

type ParsedQuery struct {
	ID        string
	Page      int
	PageSize  int
	From      *time.Time
	To        *time.Time
	Tags      []string
	Q         string
	SortBy    string
	SortOrder string
	// Hint 裸保留前缀 tag（恒空毒化交集）时给 AI 的纠正提示；空串表示无。
	Hint string
}

// RecordsOrderBySql 列表查询排序（与 Next recordsOrderBySql、
// testdata/query-records-list-order.json 对齐）。
// sort_by: happened_at（默认）| id；sort_order: asc（默认）| desc（严格小写）。
// happened_at desc 时次键 id 恒 ASC；id 排序无次键。
func RecordsOrderBySql(sortBy, sortOrder string) string {
	if sortBy == "id" {
		if sortOrder == "desc" {
			return "id DESC"
		}
		return "id ASC"
	}
	if sortOrder == "desc" {
		return "happened_at DESC, id ASC"
	}
	return "happened_at ASC, id ASC"
}

func orderByRecordsList(sortBy, sortOrder string) string {
	return " ORDER BY " + RecordsOrderBySql(sortBy, sortOrder)
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
	pageSize, err := parsePositiveInt(q.Get("page_size"), 20)
	if err != nil || pageSize > 100 {
		return nil, fmt.Errorf("page_size must be an integer between 1 and 100")
	}

	sortByRaw := q.Get("sort_by")
	if sortByRaw != "" && sortByRaw != "happened_at" && sortByRaw != "id" {
		return nil, fmt.Errorf("sort_by must be one of: happened_at, id")
	}
	sortOrderRaw := q.Get("sort_order")
	if sortOrderRaw != "" && sortOrderRaw != "asc" && sortOrderRaw != "desc" {
		return nil, fmt.Errorf("sort_order must be one of: asc, desc")
	}
	sortBy := "happened_at"
	if sortByRaw != "" {
		sortBy = sortByRaw
	}
	sortOrder := "asc"
	if sortOrderRaw != "" {
		sortOrder = sortOrderRaw
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
	var hint string
	for _, tag := range q["tag"] {
		if tag == "" {
			continue
		}
		if strings.Contains(tag, "*") {
			if !tagQueryWildcard.MatchString(tag) {
				return nil, fmt.Errorf(invalidTagQueryMsg, tag)
			}
			tagList = append(tagList, tag)
			continue
		}
		// 裸保留前缀恒空：记录首个命中，供响应加 hint（AI 纠错）
		if hint == "" && bareReservedTagHints[tag] {
			hint = fmt.Sprintf("Use \"tag=%s:*\" to match %s records (the bare tag \"%s\" is reserved and never stored)", tag, tag, tag)
		}
		tagList = append(tagList, tag)
	}

	id := q.Get("id")
	if id != "" && !record.IsValidID(id) {
		return nil, record.ErrInvalidID
	}

	return &ParsedQuery{
		ID:        id,
		Page:      page,
		PageSize:  pageSize,
		From:      from,
		To:        to,
		Tags:      tagList,
		Q:         q.Get("q"),
		SortBy:    sortBy,
		SortOrder: sortOrder,
		Hint:      hint,
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
		pattern := `%"` + EscapeLikePattern(tag) + `"%`
		if strings.HasSuffix(tag, ":*") {
			// 族通配 `X:*` → `%"X:%`（去尾闭合引号、保留冒号）；`:*` 已在校验期保证为尾缀
			pattern = `%"` + EscapeLikePattern(tag[:len(tag)-1]) + `%`
		}
		args = append(args, pattern)
		n++
	}
	if p.Q != "" {
		pattern := `%` + EscapeLikePattern(p.Q) + `%`
		parts = append(parts, fmt.Sprintf(
			`(raw_content LIKE $%d OR objective_context LIKE $%d OR ai_analysis LIKE $%d OR tags LIKE $%d)`,
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
		id, tagsField, objectiveContext, utcOffset string
		happenedAt                                 time.Time
		numericValue, rawContent, subj               *string
	)
	err := row.Scan(&id, &happenedAt, &utcOffset, &numericValue, &rawContent, &tagsField, &objectiveContext, &subj)
	if err != nil {
		return record.Record{}, err
	}
	return record.FromDB(id, happenedAt, utcOffset, numericValue, rawContent, tagsField, objectiveContext, subj), nil
}

type FetchResult struct {
	Total    int
	Page     int
	PageSize int
	Records  []record.Record
}

// ToQueryRecordJSON 查询响应单行序列化（与 Next toQueryRecordJson 对齐）。
// 查询侧略宽：至少一枚四态 tag → TodoRecordJSON；审计行与其它行保持默认 Record。
func ToQueryRecordJSON(rec record.Record) any {
	if tododraft.ShouldDeformTodoRecordTags(rec.Tags) {
		return tododraft.ToTodoRecordJSON(rec)
	}
	return rec
}

// RecordsForResponse 将列表映射为 GET /api/query 的 records[]（[]any 以便混形）。
func RecordsForResponse(recs []record.Record) []any {
	out := make([]any, len(recs))
	for i, rec := range recs {
		out[i] = ToQueryRecordJSON(rec)
	}
	return out
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

	selectSQL := `SELECT id, happened_at, utc_offset, numeric_value, raw_content, tags, objective_context, ai_analysis
FROM records`
	if where != "" {
		selectSQL += " WHERE " + where
	}
	selectSQL += orderByRecordsList(p.SortBy, p.SortOrder)

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

func FetchTagCounts(ctx context.Context, pool *pgxpool.Pool, prefix string) ([]tags.TagCount, error) {
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
	return tags.AggregateTagCounts(fields, prefix)
}

// --- GET /api/query/transactions/summary ---

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

type TransactionsSummaryResult struct {
	Success           bool             `json:"success"`
	From              string           `json:"from"`
	To                string           `json:"to"`
	Income            MoneyBucket      `json:"income"`
	Expense           MoneyBucket      `json:"expense"`
	Net               string           `json:"net"`
	IncomeCategories  []CategoryBucket `json:"income_categories"`
	ExpenseCategories []CategoryBucket `json:"expense_categories"`
}

type TransactionsSummaryRow struct {
	Tags        string
	NumericValue *string
}

type ParsedTransactionsSummaryRange struct {
	FromRaw string
	ToRaw   string
	From    time.Time
	To      time.Time
}

// ParseTransactionsSummaryParams 强制 from/to；要求 from < to（与 Next 同文案）。
func ParseTransactionsSummaryParams(q url.Values) (*ParsedTransactionsSummaryRange, error) {
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
	return &ParsedTransactionsSummaryRange{
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

// AggregateTransactionsSummary 内存聚合（与 Next aggregateTransactionsSummary 同构）。
// 脏行跳过；非法 tags JSON / 非数组返回 error。
func AggregateTransactionsSummary(rows []TransactionsSummaryRow, fromRaw, toRaw string) (*TransactionsSummaryResult, error) {
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
		if row.NumericValue == nil || *row.NumericValue == "" {
			continue
		}
		// D6 对齐：与 Next parseDecimalScaled 同规则——复用写路径 ValidateDecimalString
		// （无前导零 / 科学计数 / 分数 / + 号；int≤28 位、frac≤10 位），非法字面量跳过该行。
		// 修复前 big.Rat.SetString 会接受前导零 / 科学计数等，导致双端聚合分叉。
		if err := draft.ValidateDecimalString(*row.NumericValue); err != nil {
			continue
		}
		amount := new(big.Rat)
		if _, ok := amount.SetString(*row.NumericValue); !ok {
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
	return &TransactionsSummaryResult{
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

// FetchTransactionsSummary 拉取区间候选行并聚合。
func FetchTransactionsSummary(ctx context.Context, pool *pgxpool.Pool, from, to time.Time, fromRaw, toRaw string) (*TransactionsSummaryResult, error) {
	incomeLike := `%"` + EscapeLikePattern(txEntryIncome) + `"%`
	expenseLike := `%"` + EscapeLikePattern(txEntryExpense) + `"%`
	rows, err := pool.Query(ctx, `
SELECT tags, numeric_value FROM records
WHERE happened_at >= $1 AND happened_at < $2
  AND (tags LIKE $3 OR tags LIKE $4)`,
		from, to, incomeLike, expenseLike,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []TransactionsSummaryRow
	for rows.Next() {
		var tagsField string
		var vn *string
		if err := rows.Scan(&tagsField, &vn); err != nil {
			return nil, err
		}
		list = append(list, TransactionsSummaryRow{Tags: tagsField, NumericValue: vn})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return AggregateTransactionsSummary(list, fromRaw, toRaw)
}
