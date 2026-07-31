package telegram

import (
	"os"
	"testing"
)

// 包测默认测试态；需真实走 Notify 发送分支时在 Getenv 里设 TELEGRAM_ALLOW_IN_TEST=1。
func TestMain(m *testing.M) {
	_ = os.Setenv("DIGITAL_TWIN_TEST", "1")
	_ = os.Unsetenv("TELEGRAM_ALLOW_IN_TEST")
	os.Exit(m.Run())
}
