package db

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseEnvFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env.test")
	content := `# comment
EMPTY=
SINGLE='postgresql://u:p@test-host/db?sslmode=require'
DOUBLE="postgresql://u:p@test-host/db2"
BARE=postgresql://u:p@test-host/db3
UNRELATED=1
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		key  string
		want string
		ok   bool
	}{
		{"EMPTY", "", true},
		{"SINGLE", "postgresql://u:p@test-host/db?sslmode=require", true},
		{"DOUBLE", "postgresql://u:p@test-host/db2", true},
		{"BARE", "postgresql://u:p@test-host/db3", true},
		{"MISSING", "", false},
	} {
		got, ok := parseEnvFile(path, c.key)
		if got != c.want || ok != c.ok {
			t.Fatalf("parseEnvFile(%s) = (%q, %v), want (%q, %v)", c.key, got, ok, c.want, c.ok)
		}
	}
}

func TestParseEnvFileMissingFile(t *testing.T) {
	if v, ok := parseEnvFile(filepath.Join(t.TempDir(), "nope.env"), "DATABASE_URL"); ok || v != "" {
		t.Fatalf("got (%q, %v), want empty", v, ok)
	}
}

func TestLoadEnvFileFrom(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, ".env.test"),
		[]byte("DATABASE_URL='postgresql://u:p@test-host/from-root'\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	// 从子目录向上找到仓库根的 .env.test
	if got := loadEnvFileFrom(nested, "DATABASE_URL"); got != "postgresql://u:p@test-host/from-root" {
		t.Fatalf("walk up got %q", got)
	}

	// 无任何 .env.test 的目录树 → 空
	empty := t.TempDir()
	if got := loadEnvFileFrom(empty, "DATABASE_URL"); got != "" {
		t.Fatalf("empty tree got %q", got)
	}
}
