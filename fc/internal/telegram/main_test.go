package telegram

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	_ = os.Setenv("DIGITAL_TWIN_TEST", "1")
	_ = os.Unsetenv("NOTIFY_ALLOW_IN_TEST")
	os.Exit(m.Run())
}
