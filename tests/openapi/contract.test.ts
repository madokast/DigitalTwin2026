import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromDB } from '@/lib/record'
import {
  assertInvalidSchema,
  assertValidSchema,
  fixturesDir,
  HAPPENED_AT_OUTPUT,
  loadOpenApi,
  NUMERIC_VALUE_DECIMAL,
} from './helpers'

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'))
}

describe('OpenAPI contract (Phase 2)', () => {
  it('parses and dereferences openapi.yaml', async () => {
    const doc = await loadOpenApi()
    expect(doc.components?.schemas?.Record).toBeTruthy()
    expect(doc.components?.schemas?.Error).toBeTruthy()
    expect(doc.components?.schemas?.LogNumberRequest).toBeTruthy()
  })

  it('validates RecordSuccess fixtures (number + text)', async () => {
    const numberOk = readFixture('record-number-success.json')
    const textOk = readFixture('record-text-success.json')
    await assertValidSchema('RecordSuccess', numberOk)
    await assertValidSchema('RecordSuccess', textOk)

    const numRec = (numberOk as { record: { happened_at: string; numeric_value: string } })
      .record
    expect(numRec.happened_at).toMatch(HAPPENED_AT_OUTPUT)
    expect(numRec.numeric_value).toMatch(NUMERIC_VALUE_DECIMAL)
  })

  it('validates Error / QuerySuccess / SummarySuccess fixtures', async () => {
    await assertValidSchema('Error', readFixture('error-unauthorized.json'))
    await assertValidSchema('Error', readFixture('error-value-number-type.json'))
    await assertValidSchema('Error', readFixture('error-export-invalid-from.json'))
    await assertValidSchema('Error', readFixture('error-export-limit.json'))
    await assertValidSchema('Error', readFixture('error-export-from-not-found.json'))
    await assertValidSchema('QuerySuccess', readFixture('query-success.json'))
    await assertValidSchema('SummarySuccess', readFixture('summary-success.json'))
    await assertValidSchema('TimeSuccess', readFixture('time-success.json'))
    await assertValidSchema(
      'TransactionsSummarySuccess',
      readFixture('transaction-summary-success.json'),
    )
  })

  it('lists export path in OpenAPI', async () => {
    const doc = (await loadOpenApi()) as {
      paths?: Record<string, unknown>
    }
    expect(doc.paths?.['/api/export/records']).toBeTruthy()
    expect(doc.paths?.['/api/admin/import/records']).toBeTruthy()
  })

  it('validates remaining success / request fixtures', async () => {
    await assertValidSchema('LogTextRequest', readFixture('log-text-request-valid.json'))
    await assertValidSchema('TagsSuccess', readFixture('tags-success.json'))
    await assertValidSchema(
      'RenameTagsRequest',
      readFixture('rename-tags-request-valid.json'),
    )
    await assertValidSchema(
      'RenameTagsSuccess',
      readFixture('rename-tags-success.json'),
    )
    await assertValidSchema(
      'ImportRecordsSuccess',
      readFixture('import-records-success.json'),
    )
    await assertValidSchema('Error', readFixture('error-import-limits.json'))
    await assertValidSchema('Error', readFixture('error-import-duplicate-id.json'))
    await assertValidSchema('Error', readFixture('error-import-multipart.json'))
    await assertValidSchema(
      'ReviewRequest',
      readFixture('review-request-valid.json'),
    )
    await assertValidSchema(
      'Error',
      readFixture('error-invalid-cadence.json'),
    )
    await assertValidSchema(
      'Error',
      readFixture('error-import-non-file-part-too-large.json'),
    )
    await assertValidSchema(
      'TelegramProbeRequest',
      readFixture('telegram-probe-request.json'),
    )
    await assertValidSchema('SuccessOnly', readFixture('telegram-probe-success.json'))
    await assertValidSchema(
      'QqbotProbeRequest',
      readFixture('qqbot-probe-request.json'),
    )
    await assertValidSchema('SuccessOnly', readFixture('qqbot-probe-success.json'))
    await assertValidSchema('DbProbeSuccess', readFixture('db-probe-success.json'))
    await assertValidSchema(
      'DbProbeSuccess',
      readFixture('db-probe-missing-table.json'),
    )
    await assertValidSchema('Error', readFixture('db-probe-error.json'))
    await assertValidSchema(
      'LogTransactionsRequest',
      readFixture('log-transaction-request-valid.json'),
    )
    await assertValidSchema(
      'TransactionBatchSuccess',
      readFixture('transaction-batch-success.json'),
    )
  })

  it('accepts valid LogNumberRequest and rejects JSON number numeric_value', async () => {
    await assertValidSchema(
      'LogNumberRequest',
      readFixture('log-number-request-valid.json'),
    )
    await assertValidSchema(
      'LogNumberRequest',
      readFixture('log-number-request-offset-hhmm.json'),
    )
    // 契约：numeric_value 必须是 string；JSON number 在 schema 层即非法
    await assertInvalidSchema(
      'LogNumberRequest',
      readFixture('log-number-request-json-number.json'),
    )
  })

  it('accepts valid LogBodyWeightRequest and rejects JSON number numeric_value', async () => {
    await assertValidSchema(
      'LogBodyWeightRequest',
      readFixture('log-body-weight-request-valid.json'),
    )
    await assertInvalidSchema(
      'LogBodyWeightRequest',
      readFixture('log-body-weight-request-json-number.json'),
    )
  })

  it('accepts valid LogTodoRequest / TodoRecordSuccess and rejects unknown happened_at', async () => {
    await assertValidSchema(
      'LogTodoRequest',
      readFixture('log-todo-request-valid.json'),
    )
    await assertValidSchema(
      'TodoRecordSuccess',
      readFixture('record-todo-success.json'),
    )
    const todoOk = readFixture('record-todo-success.json') as {
      record: { created_at: string; content: string }
    }
    expect(todoOk.record.created_at).toMatch(HAPPENED_AT_OUTPUT)
    expect(todoOk.record.content).toBe('Buy milk')
    await assertInvalidSchema(
      'LogTodoRequest',
      readFixture('log-todo-request-unknown-happened-at.json'),
    )
  })

  it('accepts LogTodoTransitionRequest / TodoTransitionSuccess and rejects created_at', async () => {
    await assertValidSchema(
      'LogTodoTransitionRequest',
      readFixture('log-todo-transition-request-valid.json'),
    )
    await assertValidSchema(
      'TodoTransitionSuccess',
      readFixture('todo-transition-success.json'),
    )
    const ok = readFixture('todo-transition-success.json') as {
      id: string
      transition: { from: string; to: string }
    }
    expect(ok.transition.from).toBe('in_progress')
    expect(ok.transition.to).toBe('completed')
    expect(ok).not.toHaveProperty('record')
    expect(ok).not.toHaveProperty('audit_record')
    await assertInvalidSchema(
      'LogTodoTransitionRequest',
      readFixture('log-todo-transition-request-unknown-created-at.json'),
    )
  })

  it('rejects LogTransactionsRequest empty entries / JSON number amount / missing type', async () => {
    await assertInvalidSchema(
      'LogTransactionsRequest',
      readFixture('log-transaction-request-empty-entries.json'),
    )
    await assertInvalidSchema(
      'LogTransactionsRequest',
      readFixture('log-transaction-request-amount-number.json'),
    )
    await assertInvalidSchema(
      'LogTransactionsRequest',
      readFixture('log-transaction-request-missing-type.json'),
    )
  })

  it('rejects LogNumberRequest unknown suppress_notification key', async () => {
    const base = readFixture('log-number-request-valid.json') as Record<
      string,
      unknown
    >
    await assertInvalidSchema('LogNumberRequest', {
      ...base,
      suppress_notification: true,
    })
  })

  it('rejects LogNumberRequest without timezone / with scientific notation', async () => {
    await assertInvalidSchema(
      'LogNumberRequest',
      readFixture('log-number-request-no-tz.json'),
    )
    await assertInvalidSchema(
      'LogNumberRequest',
      readFixture('log-number-request-scientific.json'),
    )
  })

  it('rejects Record with JSON number numericValue (drift guard)', async () => {
    await assertInvalidSchema('Record', {
      id: '01900000-0000-7000-8000-000000000001',
      happened_at: '2026-07-30T00:00:00.000Z',
      numeric_value: 75.5,
      raw_content: null,
      tags: ['weight'],
      objective_context: 'x',
      ai_analysis: null,
    })
  })

  it('rejects Error / RecordSuccess with wrong shape', async () => {
    await assertInvalidSchema('Error', { message: 'oops' })
    // problem+json 四字段缺一不可
    await assertInvalidSchema('Error', {
      success: false,
      title: 'Bad Request',
      status: 400,
    })
    await assertInvalidSchema('Error', {
      title: 'Bad Request',
      status: 400,
      detail: 'x',
    })
    // success 必须恒 false（RFC 9457 定案：与成功包络统一、AI 只看布尔）
    await assertInvalidSchema('Error', {
      success: true,
      title: 'Bad Request',
      status: 400,
      detail: 'x',
    })
    await assertInvalidSchema('RecordSuccess', {
      success: true,
      // missing record
    })
  })

  it('Error fixture key order is success -> title -> status -> detail', () => {
    // 动态覆盖全部 error fixtures（10 个 error-*.json + db-probe-error.json），新增自动纳入
    const names = readdirSync(fixturesDir).filter(
      (f) => f.startsWith('error-') || f === 'db-probe-error.json',
    )
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const body = readFixture(name) as Record<string, unknown>
      expect(Object.keys(body), name).toEqual(['success', 'title', 'status', 'detail'])
    }
  })

  it('Next fromDB output matches Record schema + preserved offset', async () => {
    const rec = fromDB({
      id: '01900000-0000-7000-8000-000000000001',
      happenedAt: new Date('2026-07-30T08:00:00+08:00'),
      utcOffset: '+08:00',
      numericValue: '1.0',
      rawContent: null,
      tags: ['weight'],
      objectiveContext: 'morning',
      aiAnalysis: null,
    })
    await assertValidSchema('Record', rec)
    expect(rec.happened_at).toBe('2026-07-30T08:00:00.000+08:00')
    expect(rec.happened_at).toMatch(HAPPENED_AT_OUTPUT)
    expect(rec.numeric_value).toBe('1.0')
  })
})
