package tags

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/mdk/digitaltwin2026/fc/internal/db"
)

var tagPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+)*$`)

// ReservedTagPrefixes 保留 tag **前缀**列表（非仅精确匹配）。
// 某 tag 视为保留当且仅当：tag == P 或 strings.HasPrefix(tag, P+":")
// （冒号边界，避免误伤 transaction_entrypoint）。
// 当前 P：transaction_entry → 同时禁止 transaction_entry:income 等。
// 仅专用 API（POST /api/log/transaction）可写入带此前缀的 tag；
// 通用 log / Admin 草稿 / rename 的 from/to 均拒绝。
var ReservedTagPrefixes = []string{"transaction_entry"}

const ReservedTagTransactionEntry = "transaction_entry"

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

func ReservedTagError(tag string) string {
	return fmt.Sprintf(
		`tag "%s" is reserved; use POST /api/log/transaction for transaction line entries`,
		tag,
	)
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
	if len(tags) == 0 {
		return ValidationResult{Valid: false, Error: "tags must be a non-empty array"}
	}
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

// AggregateTagCounts counts record occurrences per tag; keys sorted lexicographically.
// 非法 JSON / 非数组返回 error（HTTP 映射 500）。
func AggregateTagCounts(tagFields []string) (map[string]int, error) {
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
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	ordered := make(map[string]int, len(keys))
	for _, k := range keys {
		ordered[k] = counts[k]
	}
	return ordered, nil
}

// RenameAcrossRecords 全表扫描 records，将 tags JSON 中 from 重命名为 to。
// 对称「笨」实现：逐行读改写；性能优化须双端文档化后再破缺。
// 脏 tags JSON 向上返回 error（HTTP 映射 500）。
// q 为可注入 Querier（*pgxpool.Pool 或测试假实现）。
func RenameAcrossRecords(ctx context.Context, q db.Querier, from, to string) (int, error) {
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
