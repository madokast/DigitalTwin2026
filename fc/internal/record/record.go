package record

import (
	"encoding/json"
	"time"
)

// Record matches Next/Drizzle JSON shape (camelCase).
type Record struct {
	ID                       string  `json:"id"`
	HappenedAt               string  `json:"happenedAt"`
	ValueNumber              *string `json:"valueNumber"`
	ValueText                *string `json:"valueText"`
	Tags                     string  `json:"tags"`
	ObjectiveContext         string  `json:"objectiveContext"`
	SubjectiveInterpretation *string `json:"subjectiveInterpretation"`
}

func FormatHappenedAt(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func FromDB(
	id string,
	happenedAt time.Time,
	valueNumber *string,
	valueText *string,
	tags string,
	objectiveContext string,
	subjectiveInterpretation *string,
) Record {
	return Record{
		ID:                       id,
		HappenedAt:               FormatHappenedAt(happenedAt),
		ValueNumber:              valueNumber,
		ValueText:                valueText,
		Tags:                     tags,
		ObjectiveContext:         objectiveContext,
		SubjectiveInterpretation: subjectiveInterpretation,
	}
}

func TagsJSON(tags []string) (string, error) {
	b, err := json.Marshal(tags)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
