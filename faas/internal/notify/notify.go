// Package notify：统一用户通知入口（与 src/lib/notify.ts 对齐）
package notify

import (
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/qqbot"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
)

// ParallelTimeout 双渠道并行等待上限（与 Next NOTIFY_PARALLEL_TIMEOUT_MS 对齐）。
const ParallelTimeout = 15 * time.Second

// Notifier 聚合 Telegram / QQ 渠道；可注入便于单测。
type Notifier struct {
	Telegram *telegram.Sender
	Qqbot    *qqbot.Sender
	Getenv   func(string) string
	Timeout  time.Duration // 默认 ParallelTimeout
}

// Default 进程级默认 Notifier。
var Default = &Notifier{
	Telegram: telegram.Default,
	Qqbot:    qqbot.Default,
}

func (n *Notifier) getenv() func(string) string {
	if n != nil && n.Getenv != nil {
		return n.Getenv
	}
	if n != nil && n.Telegram != nil && n.Telegram.Getenv != nil {
		return n.Telegram.Getenv
	}
	if n != nil && n.Qqbot != nil && n.Qqbot.Getenv != nil {
		return n.Qqbot.Getenv
	}
	return os.Getenv
}

func (n *Notifier) timeout() time.Duration {
	if n != nil && n.Timeout > 0 {
		return n.Timeout
	}
	return ParallelTimeout
}

func (n *Notifier) telegramSender() *telegram.Sender {
	base := telegram.Default
	if n != nil && n.Telegram != nil {
		base = n.Telegram
	}
	// Notifier 注入了 Getenv 而渠道未设时沿用（单测共用一份 env）
	if base.Getenv == nil && n != nil && n.Getenv != nil {
		return &telegram.Sender{
			HTTPClient: base.HTTPClient,
			APIBase:    base.APIBase,
			Getenv:     n.Getenv,
		}
	}
	return base
}

func (n *Notifier) qqbotSender() *qqbot.Sender {
	base := qqbot.Default
	if n != nil && n.Qqbot != nil {
		base = n.Qqbot
	}
	if base.Getenv == nil && n != nil && n.Getenv != nil {
		return &qqbot.Sender{
			HTTPClient: base.HTTPClient,
			TokenURL:   base.TokenURL,
			APIBases:   base.APIBases,
			Getenv:     n.Getenv,
		}
	}
	return base
}

func envFlagOn(value string) bool {
	return strings.TrimSpace(value) == "1"
}

// envOrProcess：注入值非空优先；空则回退 os.Getenv（与 Next ShouldSkipNotifyInTest 一致）。
func envOrProcess(getenv func(string) string, key string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	injected := strings.TrimSpace(getenv(key))
	if injected != "" {
		return injected
	}
	return strings.TrimSpace(os.Getenv(key))
}

// ShouldSkipNotifyInTest 测试态下跳过录入后自动通知。
// NOTIFY_ALLOW_IN_TEST=1 可放行（单测注入 mock 时用）。
// probe 走各渠道 SendMessage，不受此限制。
func ShouldSkipNotifyInTest(getenv func(string) string) bool {
	if envFlagOn(envOrProcess(getenv, "NOTIFY_ALLOW_IN_TEST")) {
		return false
	}
	return envFlagOn(envOrProcess(getenv, "DIGITAL_TWIN_TEST"))
}

// NotifyUser 已配置渠道并行发送；总等待约 Timeout 后返回。失败只打英文日志，不含密钥。
//
// 刻意允许的双端差异（docs/20260801-api-layering.md §1.1）：
// Go 导出 NotifyUser；TS 为 notify_user（snake_case）。同一 stem，语义对齐。
func (n *Notifier) NotifyUser(text string) {
	getenv := n.getenv()
	if ShouldSkipNotifyInTest(getenv) {
		return
	}

	tg := n.telegramSender()
	qq := n.qqbotSender()
	tgCfg := telegram.LoadConfig(tg.Getenv)
	qqCfg := qqbot.LoadConfig(qq.Getenv)

	type task struct {
		name string
		run  func() error
	}
	var tasks []task
	if tgCfg.Configured() {
		tasks = append(tasks, task{
			name: "Telegram",
			run:  func() error { return tg.SendMessage(text) },
		})
	}
	if qqCfg.Configured() {
		tasks = append(tasks, task{
			name: "QQ Bot",
			run:  func() error { return qq.SendMessage(text) },
		})
	}
	if len(tasks) == 0 {
		log.Printf("Notify skipped: no channels configured")
		return
	}

	var wg sync.WaitGroup
	for _, t := range tasks {
		t := t
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := t.run(); err != nil {
				log.Printf("%s notify failed: %v", t.name, err)
			}
		}()
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	timer := time.NewTimer(n.timeout())
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		// timed await：超时即返回；后台发送可继续至各自 HTTP 超时
	}
}

// NotifyRecordInserted best-effort：format → NotifyUser。
func (n *Notifier) NotifyRecordInserted(rec record.Record) {
	n.NotifyUser(telegram.FormatRecordMessage(rec))
}

// NotifyTransactionBatchInserted best-effort 一条摘要。
func (n *Notifier) NotifyTransactionBatchInserted(rows []record.Record) {
	if len(rows) == 0 {
		return
	}
	n.NotifyUser(telegram.FormatTransactionBatchMessage(rows))
}
