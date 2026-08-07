package httpx

import (
	"context"
	"io"
	"sync"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/bodyweightdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/exportapi"
	"github.com/mdk/digitaltwin2026/faas/internal/logapi"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/numberdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/query"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
	"github.com/mdk/digitaltwin2026/faas/internal/telegram"
	"github.com/mdk/digitaltwin2026/faas/internal/reviewdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
	"github.com/mdk/digitaltwin2026/faas/internal/transactiondraft"
)

// 测试 fake 实现（§10b 步骤 4：构造必填接口注入；未注入的方法 panic 暴露测试遗漏）。

type fakeNotifier struct {
	mu    sync.Mutex
	texts []string
}

func (n *fakeNotifier) NotifyUser(text string) {
	n.mu.Lock()
	n.texts = append(n.texts, text)
	n.mu.Unlock()
}

// textsLocked 加锁读当前记录（changed:false 断言「零通知」用）。
func (n *fakeNotifier) textsLocked() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string{}, n.texts...)
}

// waitTexts 等待至少 count 条通知（notify 为异步 go 调用）。
func (n *fakeNotifier) waitTexts(count int) []string {
	for i := 0; i < 100; i++ {
		n.mu.Lock()
		texts := append([]string{}, n.texts...)
		n.mu.Unlock()
		if len(texts) >= count {
			return texts
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}

func (n *fakeNotifier) NotifyRecordInserted(record.Record)             {}
func (n *fakeNotifier) NotifyNumberBatchInserted([]record.Record)      {}
func (n *fakeNotifier) NotifyTransactionBatchInserted([]record.Record) {}

// NotifyTagsEdited 记录文本（tags 编辑通知为异步 go 调用，用 waitTexts 轮询断言）。
func (n *fakeNotifier) NotifyTagsEdited(action, id, tag string, from, to []string) {
	n.mu.Lock()
	n.texts = append(n.texts, telegram.FormatTagsEditedMessage(action, id, tag, from, to))
	n.mu.Unlock()
}

type fakeLogService struct {
	createText        func(context.Context, logapi.TextBody) (record.Record, *myerr.MyError)
	createTodo        func(context.Context, tododraft.NormalizedTodo) (record.Record, *myerr.MyError)
	createBodyWeight  func(context.Context, bodyweightdraft.NormalizedBodyWeight) (record.Record, *myerr.MyError)
	createReview      func(context.Context, reviewdraft.NormalizedReview) (record.Record, *myerr.MyError)
	createNumberBatch func(context.Context, numberdraft.NormalizedNumberBatch) (int, []record.Record, *myerr.MyError)
	createTransaction func(context.Context, transactiondraft.NormalizedTransactionBatch) (int, string, string, []record.Record, *myerr.MyError)
	transitionTodo    func(context.Context, tododraft.NormalizedTodoTransition) (logapi.TransitionResult, *myerr.MyError)
}

func (f *fakeLogService) CreateText(ctx context.Context, b logapi.TextBody) (record.Record, *myerr.MyError) {
	if f.createText == nil {
		panic("CreateText not injected")
	}
	return f.createText(ctx, b)
}
func (f *fakeLogService) CreateTodo(ctx context.Context, p tododraft.NormalizedTodo) (record.Record, *myerr.MyError) {
	if f.createTodo == nil {
		panic("CreateTodo not injected")
	}
	return f.createTodo(ctx, p)
}
func (f *fakeLogService) CreateBodyWeight(ctx context.Context, p bodyweightdraft.NormalizedBodyWeight) (record.Record, *myerr.MyError) {
	if f.createBodyWeight == nil {
		panic("CreateBodyWeight not injected")
	}
	return f.createBodyWeight(ctx, p)
}
func (f *fakeLogService) CreateReview(ctx context.Context, p reviewdraft.NormalizedReview) (record.Record, *myerr.MyError) {
	if f.createReview == nil {
		panic("CreateReview not injected")
	}
	return f.createReview(ctx, p)
}
func (f *fakeLogService) CreateNumberBatch(ctx context.Context, b numberdraft.NormalizedNumberBatch) (int, []record.Record, *myerr.MyError) {
	if f.createNumberBatch == nil {
		panic("CreateNumberBatch not injected")
	}
	return f.createNumberBatch(ctx, b)
}
func (f *fakeLogService) CreateTransactionBatch(ctx context.Context, b transactiondraft.NormalizedTransactionBatch) (int, string, string, []record.Record, *myerr.MyError) {
	if f.createTransaction == nil {
		panic("CreateTransactionBatch not injected")
	}
	return f.createTransaction(ctx, b)
}
func (f *fakeLogService) TransitionTodo(ctx context.Context, p tododraft.NormalizedTodoTransition) (logapi.TransitionResult, *myerr.MyError) {
	if f.transitionTodo == nil {
		panic("TransitionTodo not injected")
	}
	return f.transitionTodo(ctx, p)
}

type fakeImportService struct {
	importJSONL func(context.Context, io.Reader) (record.ImportCounts, *myerr.MyError)
}

func (f *fakeImportService) ImportRecordsJSONL(ctx context.Context, r io.Reader) (record.ImportCounts, *myerr.MyError) {
	if f.importJSONL == nil {
		panic("ImportRecordsJSONL not injected")
	}
	return f.importJSONL(ctx, r)
}

type fakeExportService struct {
	fetchExport func(context.Context, *exportapi.ParsedExport) ([]record.Record, *myerr.MyError)
}

func (f *fakeExportService) FetchExportRecords(ctx context.Context, p *exportapi.ParsedExport) ([]record.Record, *myerr.MyError) {
	if f.fetchExport == nil {
		panic("FetchExportRecords not injected")
	}
	return f.fetchExport(ctx, p)
}

type fakeQueryService struct {
	fetchFiltered  func(context.Context, *query.ParsedQuery) (*query.FetchResult, *myerr.MyError)
	fetchSummary   func(context.Context, string, time.Time) (*query.SummaryResult, *myerr.MyError)
	fetchTagCounts func(context.Context, string) ([]tags.TagCount, *myerr.MyError)
	fetchTxSummary func(context.Context, time.Time, time.Time, string, string) (*query.TransactionsSummaryResult, *myerr.MyError)
}

func (f *fakeQueryService) FetchFilteredRecords(ctx context.Context, p *query.ParsedQuery) (*query.FetchResult, *myerr.MyError) {
	if f.fetchFiltered == nil {
		panic("FetchFilteredRecords not injected")
	}
	return f.fetchFiltered(ctx, p)
}
func (f *fakeQueryService) FetchSummary(ctx context.Context, tz string, now time.Time) (*query.SummaryResult, *myerr.MyError) {
	if f.fetchSummary == nil {
		panic("FetchSummary not injected")
	}
	return f.fetchSummary(ctx, tz, now)
}
func (f *fakeQueryService) FetchTagCounts(ctx context.Context, prefix string) ([]tags.TagCount, *myerr.MyError) {
	if f.fetchTagCounts == nil {
		panic("FetchTagCounts not injected")
	}
	return f.fetchTagCounts(ctx, prefix)
}
func (f *fakeQueryService) FetchTransactionsSummary(ctx context.Context, from, to time.Time, fromRaw, toRaw string) (*query.TransactionsSummaryResult, *myerr.MyError) {
	if f.fetchTxSummary == nil {
		panic("FetchTransactionsSummary not injected")
	}
	return f.fetchTxSummary(ctx, from, to, fromRaw, toRaw)
}

type fakeTagsService struct {
	normalizeAcross func(context.Context, []string, string) (int, *myerr.MyError)
	attachTag       func(context.Context, string, string) (recordrepo.EditTagsResult, *myerr.MyError)
	detachTag       func(context.Context, string, string) (recordrepo.EditTagsResult, *myerr.MyError)
}

func (f *fakeTagsService) NormalizeAcrossRecords(ctx context.Context, from []string, to string) (int, *myerr.MyError) {
	if f.normalizeAcross == nil {
		panic("NormalizeAcrossRecords not injected")
	}
	return f.normalizeAcross(ctx, from, to)
}

func (f *fakeTagsService) AttachTag(ctx context.Context, id, tag string) (recordrepo.EditTagsResult, *myerr.MyError) {
	if f.attachTag == nil {
		panic("AttachTag not injected")
	}
	return f.attachTag(ctx, id, tag)
}

func (f *fakeTagsService) DetachTag(ctx context.Context, id, tag string) (recordrepo.EditTagsResult, *myerr.MyError) {
	if f.detachTag == nil {
		panic("DetachTag not injected")
	}
	return f.detachTag(ctx, id, tag)
}
