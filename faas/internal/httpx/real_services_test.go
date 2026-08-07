package httpx_test

import (
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/auth"
	"github.com/mdk/digitaltwin2026/faas/internal/exportapi"
	"github.com/mdk/digitaltwin2026/faas/internal/httpx"
	"github.com/mdk/digitaltwin2026/faas/internal/importapi"
	"github.com/mdk/digitaltwin2026/faas/internal/logapi"
	"github.com/mdk/digitaltwin2026/faas/internal/query"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

// noopNotifier 集成测用（避免真实通知发送）。
type noopNotifier struct{}

func (n *noopNotifier) NotifyUser(string)                              {}
func (n *noopNotifier) NotifyRecordInserted(record.Record)             {}
func (n *noopNotifier) NotifyNumberBatchInserted([]record.Record)      {}
func (n *noopNotifier) NotifyTransactionBatchInserted([]record.Record) {}

// newRealServer 集成测装配（真实业务 Service + noop Notifier）。
func newRealServer(pool *pgxpool.Pool) *httpx.Server {
	return httpx.NewServer(
		pool,
		auth.Tokens{AI: "ai-tok", Admin: "admin-tok"},
		logapi.NewService(pool),
		importapi.NewService(pool),
		exportapi.NewService(pool),
		query.NewService(pool),
		tags.NewService(pool),
		&noopNotifier{},
	)
}

// spyNotifier 记录 NotifyUser 文本（导出集成测 spy；notify 为异步 go 调用）。
type spyNotifier struct {
	mu    sync.Mutex
	texts *[]string
}

func (n *spyNotifier) NotifyUser(text string) {
	n.mu.Lock()
	*n.texts = append(*n.texts, text)
	n.mu.Unlock()
}

// reset 清空记录（测试间重置；走锁避免与异步 notify 竞态）。
func (n *spyNotifier) reset() {
	n.mu.Lock()
	*n.texts = nil
	n.mu.Unlock()
}

// waitTexts 等待至少 count 条通知。
func (n *spyNotifier) waitTexts(count int) []string {
	for i := 0; i < 200; i++ {
		n.mu.Lock()
		texts := append([]string{}, (*n.texts)...)
		n.mu.Unlock()
		if len(texts) >= count {
			return texts
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}

func (n *spyNotifier) NotifyRecordInserted(record.Record)             {}
func (n *spyNotifier) NotifyNumberBatchInserted([]record.Record)      {}
func (n *spyNotifier) NotifyTransactionBatchInserted([]record.Record) {}
