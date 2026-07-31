package httpx_test

import (
	"os"
	"testing"
)

// 集成/路由测共用：录入后 Notify 在 DIGITAL_TWIN_TEST 下静默跳过。
func TestMain(m *testing.M) {
	_ = os.Setenv("DIGITAL_TWIN_TEST", "1")
	_ = os.Unsetenv("TELEGRAM_ALLOW_IN_TEST")
	os.Exit(m.Run())
}
