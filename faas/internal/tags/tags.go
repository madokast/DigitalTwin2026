package tags

import (
	"context"
	"encoding/json"
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
			return ValidationResult{
				Valid: false,
				Error: fmt.Sprintf(
					`invalid tag: "%s". Tags must contain only letters, numbers, underscores, and cannot start with a number`,
					tag,
				),
			}
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

// ValidateRename rename 业务校验：非空、合法 tag、非保留、from≠to。调用方应先 trim。
func ValidateRename(from, to string) ValidationResult {
	if from == "" || to == "" {
		return ValidationResult{Valid: false, Error: "missing required fields: from, to"}
	}
	if !IsValidTag(from) || !IsValidTag(to) {
		return ValidationResult{Valid: false, Error: "from and to must be valid tag names"}
	}
	if IsReservedTag(from) {
		return ValidationResult{Valid: false, Error: ReservedTagError(from)}
	}
	if IsReservedTag(to) {
		return ValidationResult{Valid: false, Error: ReservedTagError(to)}
	}
	if from == to {
		return ValidationResult{Valid: false, Error: "from and to must be different"}
	}
	return ValidationResult{Valid: true}
}

// ErrTagsNotJSONArray 与 TS TAGS_NOT_JSON_ARRAY 同文案（transactions-summary 行解析仍 500 用）。
const ErrTagsNotJSONArray = "tags field is not a JSON array"

// parseTagsJSONArray 解析 records.tags；非法 JSON / 根非数组 = DB 脏数据 → 空数组
// （聚合时静默跳过该行，与 rename 的 FromDB 兜底语义统一——2026-08-06 用户拍板）。
func parseTagsJSONArray(tagsJSON string) []any {
	var raw any
	if err := json.Unmarshal([]byte(tagsJSON), &raw); err != nil {
		return nil
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	return arr
}

// TagCount 单个 tag 的计数（JSON `tag`/`count` snake_case）。
type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// AggregateTagCounts 汇总 tag 出现次数，按「计数降序、同名 tag 升序」返回。
// prefix 非空时仅保留 strings.HasPrefix(tag, prefix) 的 tag（真前缀，自动补全语义）。
// 非法 JSON / 非数组返回 error（HTTP 映射 500）。
func AggregateTagCounts(tagFields []string, prefix string) []TagCount {
	counts := map[string]int{}
	for _, field := range tagFields {
		parsed := parseTagsJSONArray(field)
		for _, item := range parsed {
			tag, ok := item.(string)
			if !ok {
				continue
			}
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

// RenamePageSize rename 分页循环的页大小（写死 100，§6 定案）。
const RenamePageSize = 100

// RenameAcrossRecords 在单事务内将 tags 中 from 重命名为 to（业务层编排，§10b 步骤 2 二次定案）：
// uow 开事务 → repo.AcquireRenameLock（advisory xact lock：并发 rename 互斥、随事务结束自动释放）
// → 分页循环 repo.FindByCriteria（Criteria{Tags:[from], PageSize: RenamePageSize, SortBy: id}）
// → 每行 renameTags 变换 → repo.Update 写回 → len(页) < RenamePageSize 终止。
// 中途失败全滚（任何 DB 错误 → 500）；OFFSET 分页 + 事务内多页：页间并发提交可能跳行/漏改（尽力而为）。
func RenameAcrossRecords(ctx context.Context, b db.TxBeginner, from, to string) (int, *myerr.MyError) {
	updated := 0
	me := db.WithTx(ctx, b, func(q db.Executor) *myerr.MyError {
		if me := recordrepo.Repo.AcquireRenameLock(ctx, q); me != nil {
			return me
		}
		page := 1
		for {
			recs, me := recordrepo.Repo.FindByCriteria(ctx, q, recordrepo.Criteria{
				Tags:      []string{from},
				Page:      page,
				PageSize:  RenamePageSize,
				SortBy:    "id",
				SortOrder: "asc",
			})
			if me != nil {
				return me
			}
			for _, rec := range recs {
				next, ok := renameTags(rec.Tags, from, to)
				if !ok {
					continue
				}
				rec.Tags = next
				if me := recordrepo.Repo.Update(ctx, q, rec); me != nil {
					return me
				}
				updated++
			}
			if len(recs) < RenamePageSize {
				return nil
			}
			page++
		}
	})
	if me != nil {
		return 0, me
	}
	return updated, nil
}

// renameTags 数组版变换（§10b 步骤 2 二次定案，替代串版 RenameTagInTagsJSON）：
// to ∈ tags → 移除 from（去重语义）；否则 from 原位替换为 to。from ∉ tags → 不变（防御）。
func renameTags(tags []string, from, to string) ([]string, bool) {
	fromIdx := -1
	for i, t := range tags {
		if t == from {
			fromIdx = i
			break
		}
	}
	if fromIdx < 0 {
		return tags, false
	}
	hasTo := false
	for _, t := range tags {
		if t == to {
			hasTo = true
			break
		}
	}
	if hasTo {
		out := make([]string, 0, len(tags)-1)
		for _, t := range tags {
			if t != from {
				out = append(out, t)
			}
		}
		return out, true
	}
	out := make([]string, len(tags))
	for i, t := range tags {
		if t == from {
			out[i] = to
		} else {
			out[i] = t
		}
	}
	return out, true
}
