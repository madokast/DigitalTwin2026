package timeutil

import (
	"fmt"
	"time"
)

func IsValidTimeZone(tz string) bool {
	if tz == "" {
		return false
	}
	_, err := time.LoadLocation(tz)
	return err == nil
}

// GetZonedDayBounds returns half-open [start, end) for the calendar day of now in tz.
func GetZonedDayBounds(now time.Time, tz string) (start, end time.Time, err error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("Invalid time zone: %s", tz)
	}
	local := now.In(loc)
	y, m, d := local.Date()
	return CalendarDayBounds(y, int(m), d, tz)
}

// CalendarDayBounds returns [start, end) for the wall-clock calendar day in tz.
func CalendarDayBounds(year, month, day int, tz string) (start, end time.Time, err error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("Invalid time zone: %s", tz)
	}
	start = time.Date(year, time.Month(month), day, 0, 0, 0, 0, loc)
	end = start.AddDate(0, 0, 1)
	return start, end, nil
}
