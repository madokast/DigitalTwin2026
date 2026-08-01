import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromDB } from '@/lib/record'
import {
  assertInvalidSchema,
  assertValidSchema,
  fixturesDir,
  HAPPENED_AT_UTC_Z,
  loadOpenApi,
  VALUE_NUMBER_DECIMAL,
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

    const numRec = (numberOk as { record: { happenedAt: string; valueNumber: string } })
      .record
    expect(numRec.happenedAt).toMatch(HAPPENED_AT_UTC_Z)
    expect(numRec.valueNumber).toMatch(VALUE_NUMBER_DECIMAL)
  })

  it('validates Error / QuerySuccess / SummarySuccess fixtures', async () => {
    await assertValidSchema('Error', readFixture('error-unauthorized.json'))
    await assertValidSchema('Error', readFixture('error-value-number-type.json'))
    await assertValidSchema('QuerySuccess', readFixture('query-success.json'))
    await assertValidSchema('SummarySuccess', readFixture('summary-success.json'))
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
      'RecordDraftRequest',
      readFixture('record-draft-request-valid.json'),
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
    await assertValidSchema(
      'LogTransactionRequest',
      readFixture('log-transaction-request-valid.json'),
    )
    await assertValidSchema(
      'TransactionBatchSuccess',
      readFixture('transaction-batch-success.json'),
    )
  })

  it('accepts valid LogNumberRequest and rejects JSON number value_number', async () => {
    await assertValidSchema(
      'LogNumberRequest',
      readFixture('log-number-request-valid.json'),
    )
    await assertValidSchema(
      'LogNumberRequest',
      readFixture('log-number-request-offset-hhmm.json'),
    )
    // 契约：value_number 必须是 string；JSON number 在 schema 层即非法
    await assertInvalidSchema(
      'LogNumberRequest',
      readFixture('log-number-request-json-number.json'),
    )
  })

  it('rejects LogTransactionRequest empty entries / JSON number amount / missing type', async () => {
    await assertInvalidSchema(
      'LogTransactionRequest',
      readFixture('log-transaction-request-empty-entries.json'),
    )
    await assertInvalidSchema(
      'LogTransactionRequest',
      readFixture('log-transaction-request-amount-number.json'),
    )
    await assertInvalidSchema(
      'LogTransactionRequest',
      readFixture('log-transaction-request-missing-type.json'),
    )
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

  it('rejects Record with JSON number valueNumber (drift guard)', async () => {
    await assertInvalidSchema('Record', {
      id: '01900000-0000-7000-8000-000000000001',
      happenedAt: '2026-07-30T00:00:00.000Z',
      valueNumber: 75.5,
      valueText: null,
      tags: '["weight"]',
      objectiveContext: 'x',
      subjectiveInterpretation: null,
    })
  })

  it('rejects Error / RecordSuccess with wrong shape', async () => {
    await assertInvalidSchema('Error', { message: 'oops' })
    await assertInvalidSchema('RecordSuccess', {
      success: true,
      // missing record
    })
  })

  it('Next fromDB output matches Record schema + UTC Z', async () => {
    const rec = fromDB({
      id: '01900000-0000-7000-8000-000000000001',
      happenedAt: new Date('2026-07-30T08:00:00+08:00'),
      valueNumber: '1.0',
      valueText: null,
      tags: '["weight"]',
      objectiveContext: 'morning',
      subjectiveInterpretation: null,
    })
    await assertValidSchema('Record', rec)
    expect(rec.happenedAt).toBe('2026-07-30T00:00:00.000Z')
    expect(rec.happenedAt).toMatch(HAPPENED_AT_UTC_Z)
    expect(rec.valueNumber).toBe('1.0')
  })
})
