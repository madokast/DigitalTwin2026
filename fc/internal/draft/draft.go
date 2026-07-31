package draft

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mdk/digitaltwin2026/fc/internal/tags"
)

var isoTZSuffix = regexp.MustCompile(`(?i)(Z|[+-]\d{2}:?\d{2})$`)

type RecordDraftBody struct {
	HappenedAt                any `json:"happened_at"`
	ValueNumber               any `json:"value_number"`
	ValueText                 any `json:"value_text"`
	Tags                      any `json:"tags"`
	ObjectiveContext          any `json:"objective_context"`
	SubjectiveInterpretation  any `json:"subjective_interpretation"`
}

type NormalizedRecordDraft struct {
	HappenedAt               time.Time
	ValueNumber              *string
	ValueText                *string
	Tags                     []string
	ObjectiveContext         string
	SubjectiveInterpretation *string
}

func EmptyStringToNull(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}

func parseValueNumber(raw any) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	switch v := raw.(type) {
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return nil, nil
		}
		if _, err := strconv.ParseFloat(trimmed, 64); err != nil {
			return nil, fmt.Errorf("Invalid value_number")
		}
		return &trimmed, nil
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, fmt.Errorf("Invalid value_number")
		}
		// Prefer compact representation similar to JS String(number)
		s := strconv.FormatFloat(v, 'f', -1, 64)
		return &s, nil
	case json.Number:
		s := string(v)
		if s == "" {
			return nil, nil
		}
		if _, err := v.Float64(); err != nil {
			return nil, fmt.Errorf("Invalid value_number")
		}
		return &s, nil
	default:
		return nil, fmt.Errorf("Invalid value_number")
	}
}

func asStringPtr(raw any) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	s, ok := raw.(string)
	if !ok {
		return nil, fmt.Errorf("not a string")
	}
	return &s, nil
}

// ParseRecordDraft validates and normalizes an editable record snapshot.
func ParseRecordDraft(body RecordDraftBody) (*NormalizedRecordDraft, error) {
	happenedRaw, ok := body.HappenedAt.(string)
	if !ok || happenedRaw == "" {
		return nil, fmt.Errorf("Missing required field: happened_at")
	}
	if !isoTZSuffix.MatchString(happenedRaw) {
		return nil, fmt.Errorf("happened_at must be ISO 8601 with timezone (Z or ±HH:MM)")
	}
	happenedAt, err := time.Parse(time.RFC3339Nano, happenedRaw)
	if err != nil {
		// Also try RFC3339 without fractional seconds variants Go accepts via Parse
		happenedAt, err = time.Parse(time.RFC3339, happenedRaw)
		if err != nil {
			return nil, fmt.Errorf("Invalid happened_at datetime")
		}
	}

	valueNumber, err := parseValueNumber(body.ValueNumber)
	if err != nil {
		return nil, err
	}

	var valueText *string
	if body.ValueText != nil {
		s, err := asStringPtr(body.ValueText)
		if err != nil {
			return nil, fmt.Errorf("Invalid value_text")
		}
		valueText = EmptyStringToNull(s)
	}

	if valueNumber == nil && valueText == nil {
		return nil, fmt.Errorf("value_number and value_text cannot both be null")
	}

	tagList, ok := body.Tags.([]any)
	if !ok {
		// also accept []string via JSON re-decode path
		if sl, ok2 := body.Tags.([]string); ok2 {
			tagList = make([]any, len(sl))
			for i, t := range sl {
				tagList[i] = t
			}
		} else {
			return nil, fmt.Errorf("Missing required field: tags (non-empty array)")
		}
	}
	if len(tagList) == 0 {
		return nil, fmt.Errorf("Missing required field: tags (non-empty array)")
	}
	tagsStr := make([]string, 0, len(tagList))
	for _, item := range tagList {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("tags must be an array of strings")
		}
		tagsStr = append(tagsStr, s)
	}
	tv := tags.ValidateTags(tagsStr)
	if !tv.Valid {
		return nil, fmt.Errorf("%s", tv.Error)
	}

	objCtx, ok := body.ObjectiveContext.(string)
	if !ok || objCtx == "" {
		return nil, fmt.Errorf("Missing required field: objective_context")
	}

	var subjective *string
	if body.SubjectiveInterpretation != nil {
		s, err := asStringPtr(body.SubjectiveInterpretation)
		if err != nil {
			return nil, fmt.Errorf("Invalid subjective_interpretation")
		}
		subjective = EmptyStringToNull(s)
	}

	return &NormalizedRecordDraft{
		HappenedAt:               happenedAt,
		ValueNumber:              valueNumber,
		ValueText:                valueText,
		Tags:                     tagsStr,
		ObjectiveContext:         objCtx,
		SubjectiveInterpretation: subjective,
	}, nil
}

// ParseRecordDraftJSON unmarshals JSON with UseNumber and parses.
func ParseRecordDraftJSON(data []byte) (*NormalizedRecordDraft, error) {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	var raw map[string]any
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("Invalid JSON body")
	}
	body := RecordDraftBody{
		HappenedAt:               raw["happened_at"],
		ValueNumber:              raw["value_number"],
		ValueText:                raw["value_text"],
		Tags:                     raw["tags"],
		ObjectiveContext:         raw["objective_context"],
		SubjectiveInterpretation: raw["subjective_interpretation"],
	}
	return ParseRecordDraft(body)
}
