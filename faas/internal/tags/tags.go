package tags

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
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
//（端点改名/新增不会过时；与 TS RESERVED_TAG_HINT 同句）。
const reservedTagHint = "use the dedicated log API for this record type"

// ErrTagsNotJSONArray 与 TS TAGS_NOT_JSON_ARRAY 同文案：根不是 JSON 数组。
var ErrTagsNotJSONArray = errors.New("tags field is not a JSON array")

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
					`Invalid tag: "%s". Tags must contain only letters, numbers, underscores, and cannot start with a number.`,
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
		return ValidationResult{Valid: false, Error: "Missing required fields: from, to"}
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

// parseTagsJSONArray 解析 records.tags；非法 JSON 返回 err；根非数组返回 ErrTagsNotJSONArray。
func parseTagsJSONArray(tagsJSON string) ([]any, error) {
	var raw any
	if err := json.Unmarshal([]byte(tagsJSON), &raw); err != nil {
		return nil, err
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil, ErrTagsNotJSONArray
	}
	return arr, nil
}

// TagCount 单个 tag 的计数（JSON `tag`/`count` snake_case）。
type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// AggregateTagCounts 汇总 tag 出现次数，按「计数降序、同名 tag 升序」返回。
// prefix 非空时仅保留 strings.HasPrefix(tag, prefix) 的 tag（真前缀，自动补全语义）。
// 非法 JSON / 非数组返回 error（HTTP 映射 500）。
func AggregateTagCounts(tagFields []string, prefix string) ([]TagCount, error) {
	counts := map[string]int{}
	for _, field := range tagFields {
		parsed, err := parseTagsJSONArray(field)
		if err != nil {
			return nil, err
		}
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
	return list, nil
}

// TagRenameAdvisoryLockKey 与 Next tagsdb.TAG_RENAME_ADVISORY_LOCK_KEY 一致。
// pg_advisory_xact_lock：串行化并发 rename；随事务结束自动释放（适合 PgBouncer 类连接池）。
const TagRenameAdvisoryLockKey int64 = 726478478

// RenameAcrossRecords 在单事务内全表扫描并将 tags JSON 中 from 重命名为 to。
// 先拿 advisory xact lock，再读改写，保证：中途失败全滚；并发 rename 互斥。
// 脏 tags JSON 向上返回 error（HTTP 映射 500）。
func RenameAcrossRecords(ctx context.Context, pool *pgxpool.Pool, from, to string) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, TagRenameAdvisoryLockKey); err != nil {
		return 0, err
	}

	updated, err := renameAcrossQuerier(ctx, tx, from, to)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return updated, nil
}

// renameAcrossQuerier 事务内（或单测假 Querier）的读改写循环。
func renameAcrossQuerier(ctx context.Context, q db.Querier, from, to string) (int, error) {
	rows, err := q.Query(ctx, `SELECT id, tags FROM records`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type row struct {
		id   string
		tags string
	}
	var list []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.tags); err != nil {
			return 0, err
		}
		list = append(list, r)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	updated := 0
	for _, r := range list {
		next, ok, err := RenameTagInTagsJSON(r.tags, from, to)
		if err != nil {
			return 0, err
		}
		if !ok {
			continue
		}
		if _, err := q.Exec(ctx, `UPDATE records SET tags = $1 WHERE id = $2`, next, r.id); err != nil {
			return 0, err
		}
		updated++
	}
	return updated, nil
}

// RenameTagInTagsJSON renames from→to in a tags JSON array.
// Returns ("", false) when from is absent; dedupes keeping first occurrence order.
// 非法 JSON / 非数组返回 error。
func RenameTagInTagsJSON(tagsJSON, from, to string) (string, bool, error) {
	parsed, err := parseTagsJSONArray(tagsJSON)
	if err != nil {
		return "", false, err
	}

	found := false
	next := make([]string, 0, len(parsed))
	seen := map[string]struct{}{}

	for _, item := range parsed {
		s, ok := item.(string)
		if !ok {
			continue
		}
		mapped := s
		if s == from {
			mapped = to
			found = true
		}
		if _, exists := seen[mapped]; exists {
			continue
		}
		seen[mapped] = struct{}{}
		next = append(next, mapped)
	}

	if !found {
		return "", false, nil
	}
	b, err := json.Marshal(next)
	if err != nil {
		return "", false, err
	}
	return string(b), true, nil
}
