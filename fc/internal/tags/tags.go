package tags

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
)

var tagPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+)*$`)

func IsValidTag(tag string) bool {
	return tagPattern.MatchString(tag)
}

type ValidationResult struct {
	Valid bool
	Error string
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

// AggregateTagCounts counts record occurrences per tag; keys sorted lexicographically.
func AggregateTagCounts(tagFields []string) (map[string]int, error) {
	counts := map[string]int{}
	for _, field := range tagFields {
		var parsed []any
		if err := json.Unmarshal([]byte(field), &parsed); err != nil {
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

// RenameTagInTagsJSON renames from→to in a tags JSON array.
// Returns ("", false) when from is absent; dedupes keeping first occurrence order.
func RenameTagInTagsJSON(tagsJSON, from, to string) (string, bool, error) {
	var parsed []any
	if err := json.Unmarshal([]byte(tagsJSON), &parsed); err != nil {
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
