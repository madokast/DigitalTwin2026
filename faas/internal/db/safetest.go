package db

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// TestDatabaseURLHint 集成测缺失 / 不安全 DATABASE_URL 时的英文提示。
const TestDatabaseURLHint =
	`Point DATABASE_URL at a test database (hostname or database name must contain "test").`

var testMarkerRE = regexp.MustCompile(`(?i)test`)

// AssertSafeTestDatabaseURL 校验测试库 URL：hostname 或库名须含 /test/i，或含 TestDigitalTwin。
// 不检查 username。ALLOW_TEST_DB_WIPE=1 不是旁路。
func AssertSafeTestDatabaseURL(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fmt.Errorf("DATABASE_URL is empty")
	}

	parsed, err := url.Parse(trimmed)
	// net/url 对无 scheme 的串较宽松；与 Node URL 对齐，要求有 scheme
	if err != nil || parsed.Scheme == "" {
		return fmt.Errorf("DATABASE_URL is not a valid URL")
	}

	host := parsed.Hostname()
	dbName, err := url.PathUnescape(strings.TrimPrefix(parsed.Path, "/"))
	if err != nil {
		dbName = strings.TrimPrefix(parsed.Path, "/")
	}

	looksLikeTest :=
		testMarkerRE.MatchString(host) ||
			testMarkerRE.MatchString(dbName) ||
			strings.Contains(host, "testDigitalTwin") ||
			strings.Contains(dbName, "testDigitalTwin")

	if !looksLikeTest {
		return fmt.Errorf(
			`refusing DATABASE_URL: hostname or database name must contain "test" (case-insensitive) or "testDigitalTwin". Set ALLOW_TEST_DB_WIPE=1 does not bypass this check. %s`,
			TestDatabaseURLHint,
		)
	}
	return nil
}
