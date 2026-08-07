package tags

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
)

var tagPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+)*$`)

// ReservedTagPrefixes 保留 tag **前缀**列表（非仅精确匹配）。
// 某 tag 视为保留当且仅当：tag == P 或 strings.HasPrefix(tag, P+":")
// （冒号边界，避免误伤 transaction_entrypoint）。
// 当前 P：transaction_entry、body:weight、todo、review。
// 仅专用 API 可写入带此前缀的 tag；通用 log / Admin 草稿 / rename 的 from/to 均拒绝。
var ReservedTagPrefixes = []string{"transaction_entry", "body:weight", "todo", "review"}

const ReservedTagTransactionEntry = "transaction_entry"
const ReservedTagBodyWeight = "body:weight"
const ReservedTagTodo = "todo"
const ReservedTagReview = "review"

// reservedTagHint 保留 tag 错误后缀：不指向具体端点路径，AI 自行查 OpenAPI
// （端点改名/新增不会过时；与 TS RESERVED_TAG_HINT 同句）。
const reservedTagHint = "use the dedicated log API for this record type"

// TransactionEntryTypeTag 组装落库用类型 tag。
func TransactionEntryTypeTag(typ string) string {
	return ReservedTagTransactionEntry + ":" + typ
}

func IsValidTag(tag string) bool {
	return tagPattern.MatchString(tag)
}

func IsReservedTag(tag string) bool {
	for _, p := range ReservedTagPrefixes {
		if tag == p || strings.HasPrefix(tag, p+":") {
			return true
		}
	}
	return false
}

// InvalidTagMessage 单个 tag 非法文案（与 ValidateTags 数组版同文案；tags-add handler 用）。
func InvalidTagMessage(tag string) string {
	return fmt.Sprintf(
		`invalid tag: "%s". Tags must contain only letters, numbers, underscores, and cannot start with a number`,
		tag,
	)
}

// ReservedTagError 英文错误：指明保留 tag 应走专用记录 API（不指向具体端点）。
func ReservedTagError(tag string) string {
	return fmt.Sprintf(`tag "%s" is reserved; %s`, tag, reservedTagHint)
}

type ValidationResult struct {
	Valid bool
	Error string
}

func AssertNoReservedTags(tagList []string) ValidationResult {
	for _, tag := range tagList {
		if IsReservedTag(tag) {
			return ValidationResult{Valid: false, Error: ReservedTagError(tag)}
		}
	}
	return ValidationResult{Valid: true}
}

func ValidateTags(tags []string) ValidationResult {
	for _, tag := range tags {
		if !IsValidTag(tag) {
			return ValidationResult{Valid: false, Error: InvalidTagMessage(tag)}
		}
	}
	return ValidationResult{Valid: true}
}

// FirstDuplicateTag 返回 tags 中第一个重复的 tag 名；无重复返回 ""。
// 各写入端点（numbers/text/todo/body/weight/review）在落库前调用，重复 → 400。
// 文案由调用方拼：Duplicate tag "<tag>"（batch 端点加 entries[i]: 前缀）。
func FirstDuplicateTag(tagList []string) string {
	seen := make(map[string]struct{}, len(tagList))
	for _, tag := range tagList {
		if _, ok := seen[tag]; ok {
			return tag
		}
		seen[tag] = struct{}{}
	}
	return ""
}

// ValidateNormalize normalize 业务校验（零 DB，调用方应先 trim 元素）：
// from 非空数组（元素合法 / 无重复 / 非保留前缀）、to 非空合法非保留、to ∉ from。
// 校验顺序定案（docs/20260805-tag-design.md §tag 归一化）：from 形状 → to 缺失 →
// from 元素（逐个：非法 → 重复 → 保留）→ to（非法 → 保留）→ 交集。
func ValidateNormalize(from []string, to string) ValidationResult {
	if len(from) == 0 {
		return ValidationResult{Valid: false, Error: "missing required field: from"}
	}
	if to == "" {
		return ValidationResult{Valid: false, Error: "missing required field: to"}
	}
	seen := map[string]bool{}
	for _, f := range from {
		if !IsValidTag(f) {
			return ValidationResult{Valid: false, Error: InvalidTagMessage(f)}
		}
		if seen[f] {
			return ValidationResult{Valid: false, Error: fmt.Sprintf(`duplicate tag in from: "%s"`, f)}
		}
		seen[f] = true
		if IsReservedTag(f) {
			return ValidationResult{Valid: false, Error: ReservedTagError(f)}
		}
	}
	if !IsValidTag(to) {
		return ValidationResult{Valid: false, Error: InvalidTagMessage(to)}
	}
	if IsReservedTag(to) {
		return ValidationResult{Valid: false, Error: ReservedTagError(to)}
	}
	if seen[to] {
		return ValidationResult{Valid: false, Error: "to must not be in from"}
	}
	return ValidationResult{Valid: true}
}

// ErrTagsNotJSONArray 与 TS TAGS_NOT_JSON_ARRAY 同文案（transactions-summary 行解析仍 500 用）。
const ErrTagsNotJSONArray = "tags field is not a JSON array"

// TagCount 单个 tag 的计数（JSON `tag`/`count` snake_case）。
type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// AggregateTagCounts 汇总 tag 出现次数，按「计数降序、同名 tag 升序」返回。
// prefix 非空时仅保留 strings.HasPrefix(tag, prefix) 的 tag（真前缀，自动补全语义）。
// 非法 JSON / 非数组返回 error（HTTP 映射 500）。
func AggregateTagCounts(tagLists [][]string, prefix string) []TagCount {
	counts := map[string]int{}
	for _, tags := range tagLists {
		for _, tag := range tags {
			counts[tag]++
		}
	}
	list := make([]TagCount, 0, len(counts))
	for tag, count := range counts {
		if prefix != "" && !strings.HasPrefix(tag, prefix) {
			continue
		}
		list = append(list, TagCount{Tag: tag, Count: count})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Count != list[j].Count {
			return list[i].Count > list[j].Count
		}
		return list[i].Tag < list[j].Tag
	})
	return list
}

// NormalizePageSize normalize 分页循环的页大小（写死 100，§6 定案；原 rename 同名常量）。
const NormalizePageSize = 100

// NormalizeAcrossRecords 在单事务内将 tags 中 from 系列归一化为 to（业务层编排，
// §10b 步骤 2 骨架复用 + normalize 定案）：
// uow 开事务 → repo.AcquireRenameLock（advisory xact lock：并发互斥、随事务结束自动释放）
// → 对每个 from 元素分页扫描（FindByCriteria 的 Tags 为 AND 交集语义，不能一次匹配任一；
// 每行 normalizeTags 做一次多源变换——顺序语义定案「删 from 系列 + 尾加 to」，
// 不能分解为逐源 rename）→ 命中才 repo.Update 写回 → len(页) < NormalizePageSize 终止。
// 同一行含多个 from 元素时：首次命中更新，后续 normalizeTags 返回 !changed 不重复写。
// 中途失败全滚（任何 DB 错误 → 500）；OFFSET 分页 + 事务内多页：页间并发提交可能跳行/漏改（尽力而为）。
func NormalizeAcrossRecords(ctx context.Context, b db.TxBeginner, from []string, to string) (int, *myerr.MyError) {
	updated := 0
	me := db.WithTx(ctx, b, func(q db.Executor) *myerr.MyError {
		if me := recordrepo.Repo.AcquireRenameLock(ctx, q); me != nil {
			return me
		}
		for _, f := range from {
			page := 1
			for {
				recs, me := recordrepo.Repo.FindByCriteria(ctx, q, recordrepo.FindCriteria{
					Criteria:  recordrepo.Criteria{Tags: []string{f}},
					Page:      page,
					PageSize:  NormalizePageSize,
					SortBy:    "id",
					SortOrder: "asc",
				})
				if me != nil {
					return me
				}
				for _, rec := range recs {
					next, ok := normalizeTags(rec.Tags, from, to)
					if !ok {
						continue
					}
					rec.Tags = next
					if me := recordrepo.Repo.Update(ctx, q, rec); me != nil {
						return me
					}
					updated++
				}
				if len(recs) < NormalizePageSize {
					break
				}
				page++
			}
		}
		return nil
	})
	if me != nil {
		return 0, me
	}
	return updated, nil
}

// normalizeTags 多源一次变换（normalize 定案；替代 renameTags 串版）：
// tags 含 from 中任意 tag → 全部原地删（后续前移）；to 已存在（且非 from 元素）保持原位，
// 否则尾加。from 含 to 已被 ValidateNormalize 拦截（防御：若发生，先删后尾加）。
// 不含任何 from 元素 → 原样返回 changed=false。
func normalizeTags(tags []string, from []string, to string) ([]string, bool) {
	inFrom := make(map[string]bool, len(from))
	for _, f := range from {
		inFrom[f] = true
	}
	changed := false
	for _, t := range tags {
		if inFrom[t] {
			changed = true
			break
		}
	}
	if !changed {
		return tags, false
	}
	out := make([]string, 0, len(tags))
	hasTo := false
	for _, t := range tags {
		if inFrom[t] {
			continue // 原地删、后续前移
		}
		out = append(out, t)
		if t == to {
			hasTo = true
		}
	}
	if !hasTo {
		out = append(out, to) // target 不存在 → 尾加
	}
	return out, true
}
