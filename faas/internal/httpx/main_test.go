package httpx_test

import (
	"os"
	"testing"
)

// 集成/路由测共用：录入后 Notify 在 SUPPRESS_BOT_NOTIFICATION=1 下静默跳过。
func TestMain(m *testing.M) {
	_ = os.Setenv("SUPPRESS_BOT_NOTIFICATION", "1")
	os.Exit(m.Run())
}
