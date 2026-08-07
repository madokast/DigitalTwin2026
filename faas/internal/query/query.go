package query

import (
	"context"
	"fmt"
	"math/big"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/timeutil"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

// invalidTagQueryMsg 与 Next INVALID_TAG_QUERY 同文案；%s 为非法 tag 查询值。
const invalidTagQueryMsg = "invalid tag query \"%s\": use a valid tag name or a family pattern \"tag=review:*\" (a single \"*\" at the end, prefix must be non-empty)"

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

func parsePositiveInt(raw string, fallback int) (int, *myerr.MyError) {
	if raw == "" {
		return fallback, nil
	}
	if !digitsOnly.MatchString(raw) {
		return 0, myerr.NewValidation("invalid")
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, myerr.NewValidation("invalid")
	}
	// 与 Next Number.MAX_SAFE_INTEGER 对齐，避免 JS Number 精度丢失造成双端分叉
	const maxSafeInt = 9007199254740991
	if n > maxSafeInt {
		return 0, myerr.NewValidation("invalid")
	}
	return n, nil
}

func parseIsoDate(raw, label string) (*time.Time, *myerr.MyError) {
	if raw == "" {
		return nil, nil
	}
	if !isoTZSuffix.MatchString(raw) {
		return nil, myerr.NewValidation(fmt.Sprintf("%s must be ISO 8601 with timezone (Z or ±HH:MM)", label))
	}
	t, err := timeutil.ParseRFC3339Flexible(raw)
	if err != nil {
		return nil, myerr.NewValidation(fmt.Sprintf("invalid %s datetime", label))
	}
	return &t, nil
}

func ParseRecordQueryParams(q url.Values) (*ParsedQuery, *myerr.MyError) {
	page, err := parsePositiveInt(q.Get("page"), 1)
	if err != nil {
		return nil, myerr.NewValidation("page must be a positive integer")
	}
	pageSize, err := parsePositiveInt(q.Get("page_size"), 20)
	if err != nil || pageSize > 100 {
		return nil, myerr.NewValidation("page_size must be an integer between 1 and 100")
	}

	sortByRaw := q.Get("sort_by")
	if sortByRaw != "" && sortByRaw != "happened_at" && sortByRaw != "id" {
		return nil, myerr.NewValidation("sort_by must be one of: happened_at, id")
	}
	sortOrderRaw := q.Get("sort_order")
	if sortOrderRaw != "" && sortOrderRaw != "asc" && sortOrderRaw != "desc" {
		return nil, myerr.NewValidation("sort_order must be one of: asc, desc")
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
				return nil, myerr.NewValidation(fmt.Sprintf(invalidTagQueryMsg, tag))
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
		return nil, myerr.NewValidation(record.ErrInvalidID)
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

// toCriteria ParsedQuery → FindCriteria（去 Hint；Hint 是响应辅助，业务层 parse 时产出、随响应返回）。
func toCriteria(p *ParsedQuery) recordrepo.FindCriteria {
	return recordrepo.FindCriteria{
		Criteria: recordrepo.Criteria{
			ID:   p.ID,
			From: p.From,
			To:   p.To,
			Tags: p.Tags,
			Q:    p.Q,
		},
		Page:      p.Page,
		PageSize:  p.PageSize,
		SortBy:    p.SortBy,
		SortOrder: p.SortOrder,
	}
}

func FetchFilteredRecords(ctx context.Context, pool *pgxpool.Pool, p *ParsedQuery) (*FetchResult, *myerr.MyError) {
	c := toCriteria(p)

	total, me := recordrepo.Repo.Count(ctx, pool, c.Criteria)
	if me != nil {
		return nil, me
	}
	recs, me := recordrepo.Repo.FindByCriteria(ctx, pool, c)
	if me != nil {
		return nil, me
	}

	// ID 非空时忽略分页：Page/PageSize 回填实际（现状语义：ps=len 或 1）
	if p.ID != "" {
		ps := len(recs)
		if ps == 0 {
			ps = 1
		}
		return &FetchResult{Total: total, Page: 1, PageSize: ps, Records: recs}, nil
	}
	return &FetchResult{Total: total, Page: p.Page, PageSize: p.PageSize, Records: recs}, nil
}

type SummaryResult struct {
	Total int    `json:"total"`
	Today int    `json:"today"`
	TZ    string `json:"tz"`
}

func FetchSummary(ctx context.Context, pool *pgxpool.Pool, tz string, now time.Time) (*SummaryResult, *myerr.MyError) {
	if !timeutil.IsValidTimeZone(tz) {
		return nil, myerr.NewValidation("query parameter tz must be a valid IANA time zone")
	}
	start, end, err := timeutil.GetZonedDayBounds(now, tz)
	if err != nil {
		return nil, myerr.NewValidation("query parameter tz must be a valid IANA time zone")
	}

	total, me := recordrepo.Repo.Count(ctx, pool, recordrepo.Criteria{})
	if me != nil {
		return nil, me
	}
	today, me := recordrepo.Repo.Count(ctx, pool, recordrepo.Criteria{From: &start, To: &end})
	if me != nil {
		return nil, me
	}
	return &SummaryResult{Total: total, Today: today, TZ: tz}, nil
}

func FetchTagCounts(ctx context.Context, pool *pgxpool.Pool, prefix string) ([]tags.TagCount, *myerr.MyError) {
	// 分页循环 FindByCriteria（无过滤）收集每行 tags 数组 → 数组版聚合（§10b 步骤 3 二次定案）。
	var tagLists [][]string
	page := 1
	for {
		recs, me := recordrepo.Repo.FindByCriteria(ctx, pool, recordrepo.FindCriteria{
			Page:      page,
			PageSize:  tags.NormalizePageSize, // 100，与 rename 循环一致
			SortBy:    "id",
			SortOrder: "asc",
		})
		if me != nil {
			return nil, me
		}
		for _, rec := range recs {
			tagLists = append(tagLists, rec.Tags)
		}
		if len(recs) < tags.NormalizePageSize {
			break
		}
		page++
	}
	return tags.AggregateTagCounts(tagLists, prefix), nil
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

type ParsedTransactionsSummaryRange struct {
	FromRaw string
	ToRaw   string
	From    time.Time
	To      time.Time
}

// ParseTransactionsSummaryParams 强制 from/to；要求 from < to（与 Next 同文案）。
func ParseTransactionsSummaryParams(q url.Values) (*ParsedTransactionsSummaryRange, *myerr.MyError) {
	fromRaw := q.Get("from")
	if fromRaw == "" {
		return nil, myerr.NewValidation("missing required query parameter: from")
	}
	toRaw := q.Get("to")
	if toRaw == "" {
		return nil, myerr.NewValidation("missing required query parameter: to")
	}
	from, err := parseIsoDate(fromRaw, "from")
	if err != nil {
		return nil, err
	}
	if from == nil {
		return nil, myerr.NewValidation("missing required query parameter: from")
	}
	to, err := parseIsoDate(toRaw, "to")
	if err != nil {
		return nil, err
	}
	if to == nil {
		return nil, myerr.NewValidation("missing required query parameter: to")
	}
	if !from.Before(*to) {
		return nil, myerr.NewValidation("from must be earlier than to")
	}
	return &ParsedTransactionsSummaryRange{
		FromRaw: fromRaw,
		ToRaw:   toRaw,
		From:    *from,
		To:      *to,
	}, nil
}

func formatMoney(r *big.Rat) string {
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
				Sum:         formatMoney(s.sum),
				Count:       s.count,
			})
		}
		out = append(out, CategoryBucket{
			Category:      cat.name,
			Sum:           formatMoney(cat.sum),
			Count:         cat.count,
			Subcategories: subs,
		})
	}
	return out
}

// AggregateTransactionsSummary 内存聚合（与 Next aggregateTransactionsSummary 同构）。
// 脏行跳过；非法 tags JSON / 非数组返回 error。
// txSummaryAcc 增量聚合器（分页循环逐行喂入，内存只留聚合状态——§10b 步骤 3 修正：
// 行数可能巨大，收集全量再聚合 = 内存爆炸）。与 Next aggregateTransactionsSummary 同构。
type txSummaryAcc struct {
	income      *accBucket
	expense     *accBucket
	incomeCats  map[string]*catAcc
	expenseCats map[string]*catAcc
}

func newTxSummaryAcc() *txSummaryAcc {
	return &txSummaryAcc{
		income:      newAcc(),
		expense:     newAcc(),
		incomeCats:  map[string]*catAcc{},
		expenseCats: map[string]*catAcc{},
	}
}

// addRow 逐行增量累加（tagList 为领域数组——FromDB 已 parse 并兜底脏数据，与跳过语义统一）。
func (a *txSummaryAcc) addRow(tagList []string, numericValue *string) *myerr.MyError {
	entryType := classifyEntryType(tagList)
	if entryType == "" {
		return nil
	}
	category, subcategory, ok := findCategoryPair(tagList)
	if !ok {
		return nil
	}
	if numericValue == nil || *numericValue == "" {
		return nil
	}
	// D6 对齐：与 Next parseDecimalScaled 同规则——复用写路径 ValidateDecimalString
	// （无前导零 / 科学计数 / 分数 / + 号；int≤28 位、frac≤10 位），非法字面量跳过该行。
	if err := draft.ValidateDecimalString(*numericValue); err != nil {
		return nil
	}
	amount := new(big.Rat)
	if _, ok := amount.SetString(*numericValue); !ok {
		return nil
	}
	var top *accBucket
	var cats map[string]*catAcc
	if entryType == "income" {
		top = a.income
		cats = a.incomeCats
	} else {
		top = a.expense
		cats = a.expenseCats
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
	return nil
}

// finalize 组装结果（分类桶排序 + 金额格式化）。
func (a *txSummaryAcc) finalize(fromRaw, toRaw string) *TransactionsSummaryResult {
	incomeCatsOut := categoriesFromMap(a.incomeCats)
	expenseCatsOut := categoriesFromMap(a.expenseCats)
	if incomeCatsOut == nil {
		incomeCatsOut = []CategoryBucket{}
	}
	if expenseCatsOut == nil {
		expenseCatsOut = []CategoryBucket{}
	}
	net := new(big.Rat).Sub(a.income.sum, a.expense.sum)
	return &TransactionsSummaryResult{
		Success:           true,
		From:              fromRaw,
		To:                toRaw,
		Income:            MoneyBucket{Sum: formatMoney(a.income.sum), Count: a.income.count},
		Expense:           MoneyBucket{Sum: formatMoney(a.expense.sum), Count: a.expense.count},
		Net:               formatMoney(net),
		IncomeCategories:  incomeCatsOut,
		ExpenseCategories: expenseCatsOut,
	}
}

// FetchTransactionsSummary 分页循环拉取区间候选行并增量聚合（§10b 步骤 3 修正：
// 单族通配 transaction_entry:* 覆盖 income/expense；行数可能巨大 → 100 分页，每页行即弃）。
func FetchTransactionsSummary(ctx context.Context, pool *pgxpool.Pool, from, to time.Time, fromRaw, toRaw string) (*TransactionsSummaryResult, *myerr.MyError) {
	acc := newTxSummaryAcc()
	page := 1
	for {
		recs, me := recordrepo.Repo.FindByCriteria(ctx, pool, recordrepo.FindCriteria{
			Criteria: recordrepo.Criteria{
				From: &from,
				To:   &to,
				Tags: []string{"transaction_entry:*"},
			},
			Page:      page,
			PageSize:  tags.NormalizePageSize,
			SortBy:    "id",
			SortOrder: "asc",
		})
		if me != nil {
			return nil, me
		}
		for _, rec := range recs {
			if me := acc.addRow(rec.Tags, rec.NumericValue); me != nil {
				return nil, me
			}
		}
		if len(recs) < tags.NormalizePageSize {
			break
		}
		page++
	}
	return acc.finalize(fromRaw, toRaw), nil
}
