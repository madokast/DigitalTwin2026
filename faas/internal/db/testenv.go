package db

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDatabaseURL 返回集成测用的安全测试库 URL。
// 语义与 Node tests/setup.ts（loadTestEnv override）+ tests/api/routes.test.ts 门闸对齐：
//  1. `go test -short` → 直接 Skip（仅单元测入口）
//  2. 仓库根存在 .env.test 时，其 DATABASE_URL 优先（覆盖环境变量，防 shell 残留）
//  3. 其次读环境变量 DATABASE_URL
//  4. 均无 → t.Skip；已设但 unsafe → t.Fatal（拒绝，不旁路）
func TestDatabaseURL(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("go test -short: skipping Go API integration test.")
	}
	url := ""
	if fromFile := loadEnvFileFromRepoRoot("DATABASE_URL"); fromFile != "" {
		url = fromFile
	} else {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping Go API integration test. " + TestDatabaseURLHint)
	}
	if err := AssertSafeTestDatabaseURL(url); err != nil {
		t.Fatalf("%v", err)
	}
	return url
}

// loadEnvFileFromRepoRoot 从 cwd 向上找最近的 .env.test（go test 的 cwd 是包目录）。
func loadEnvFileFromRepoRoot(key string) string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	return loadEnvFileFrom(dir, key)
}

// loadEnvFileFrom 从 startDir 逐级向上，取第一个含 .env.test 的目录解析 key。
func loadEnvFileFrom(startDir, key string) string {
	for dir := startDir; ; dir = filepath.Dir(dir) {
		if v, ok := parseEnvFile(filepath.Join(dir, ".env.test"), key); ok {
			return v
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
	}
}

// parseEnvFile 解析 dotenv 格式的 KEY=value：支持单引号 / 双引号包裹，跳过空行与 # 注释。
func parseEnvFile(path, key string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()

	prefix := key + "="
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		v := strings.TrimSpace(strings.TrimPrefix(line, prefix))
		if len(v) >= 2 && (v[0] == '\'' || v[0] == '"') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		return v, true
	}
	return "", false
}
