import { validateTags } from '@/lib/tags'

/** ISO 8601 末尾时区：Z / ±HH:MM / ±HHMM */
const ISO_TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i

export type RecordDraftBody = {
  happened_at?: unknown
  value_number?: unknown
  value_text?: unknown
  tags?: unknown
  objective_context?: unknown
  subjective_interpretation?: unknown
}

export type NormalizedRecordDraft = {
  happenedAt: Date
  valueNumber: string | null
  valueText: string | null
  tags: string[]
  objectiveContext: string
  subjectiveInterpretation: string | null
}

export type DraftValidationError = { error: string }

/** 空串 → null；其它字符串原样；null/undefined → null */
export function emptyStringToNull(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined || value === '') return null
  return value
}

function parseValueNumber(
  raw: unknown,
): { ok: true; value: string | null } | DraftValidationError {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: null }
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { error: 'Invalid value_number' }
    }
    return { ok: true, value: String(raw) }
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return { ok: true, value: null }
    const n = Number(trimmed)
    if (!Number.isFinite(n)) {
      return { error: 'Invalid value_number' }
    }
    return { ok: true, value: trimmed }
  }
  return { error: 'Invalid value_number' }
}

/**
 * 校验并可编辑字段快照归一化（前后端共用）。
 * 空串在可空字段上变为 null；objective_context 不允许空。
 */
export function parseRecordDraft(
  body: RecordDraftBody,
): NormalizedRecordDraft | DraftValidationError {
  if (typeof body.happened_at !== 'string' || !body.happened_at) {
    return { error: 'Missing required field: happened_at' }
  }
  if (!ISO_TZ_SUFFIX.test(body.happened_at)) {
    return {
      error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    }
  }
  const happenedAt = new Date(body.happened_at)
  if (Number.isNaN(happenedAt.getTime())) {
    return { error: 'Invalid happened_at datetime' }
  }

  const numberResult = parseValueNumber(body.value_number)
  if ('error' in numberResult) return numberResult
  const valueNumber = numberResult.value

  let valueText: string | null = null
  if (body.value_text !== null && body.value_text !== undefined) {
    if (typeof body.value_text !== 'string') {
      return { error: 'Invalid value_text' }
    }
    valueText = emptyStringToNull(body.value_text)
  }

  if (valueNumber === null && valueText === null) {
    return { error: 'value_number and value_text cannot both be null' }
  }

  if (!Array.isArray(body.tags) || body.tags.length === 0) {
    return { error: 'Missing required field: tags (non-empty array)' }
  }
  if (!body.tags.every((t) => typeof t === 'string')) {
    return { error: 'tags must be an array of strings' }
  }
  const tagsValidation = validateTags(body.tags)
  if (!tagsValidation.valid) {
    return { error: tagsValidation.error ?? 'Invalid tags' }
  }

  if (
    typeof body.objective_context !== 'string' ||
    body.objective_context === ''
  ) {
    return { error: 'Missing required field: objective_context' }
  }

  let subjectiveInterpretation: string | null = null
  if (
    body.subjective_interpretation !== null &&
    body.subjective_interpretation !== undefined
  ) {
    if (typeof body.subjective_interpretation !== 'string') {
      return { error: 'Invalid subjective_interpretation' }
    }
    subjectiveInterpretation = emptyStringToNull(body.subjective_interpretation)
  }

  return {
    happenedAt,
    valueNumber,
    valueText,
    tags: body.tags,
    objectiveContext: body.objective_context,
    subjectiveInterpretation,
  }
}
