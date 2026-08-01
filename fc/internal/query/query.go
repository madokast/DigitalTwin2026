package query

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/fc/internal/record"
	"github.com/mdk/digitaltwin2026/fc/internal/tags"
	"github.com/mdk/digitaltwin2026/fc/internal/timeutil"
)

var (
	isoTZSuffix  = regexp.MustCompile(`(?i)(Z|[+-]\d{2}:?\d{2})$`)
	digitsOnly   = regexp.MustCompile(`^\d+$`)
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

	return &ParsedQuery{
		ID:       q.Get("id"),
		Page:     page,
		PageSize: pageSize,
		From:     from,
		To:       to,
		Tags:     tagList,
		Q:        q.Get("q"),
	}, nil
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
		args = append(args, `%"`+tag+`"%`)
		n++
	}
	if p.Q != "" {
		pattern := `%` + p.Q + `%`
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
	selectSQL += " ORDER BY happened_at DESC"

	if p.ID != "" {
		rows, err := pool.Query(ctx, selectSQL, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var recs []record.Record
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
		return nil, fmt.Errorf("Query parameter tz must be a valid IANA time zone")
	}
	start, end, err := timeutil.GetZonedDayBounds(now, tz)
	if err != nil {
		return nil, fmt.Errorf("Query parameter tz must be a valid IANA time zone")
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
