/**
 * OpenAPI 契约辅助：解析 YAML、用 Ajv 校验 components.schemas。
 * 无 DB / 无网络；供 Vitest 契约测试使用。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import SwaggerParser from '@apidevtools/swagger-parser'
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const openapiPath = path.join(root, 'openapi/openapi.yaml')
export const fixturesDir = path.join(root, 'openapi/fixtures')

/** Record.happened_at / Todo created_at 读出：毫秒三位 + 显式区（Z 或 ±HH:MM） */
export const HAPPENED_AT_OUTPUT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/

/** numeric_value 十进制字符串（与实现 / 契约描述一致；schema 本身仅 type:string） */
export const NUMERIC_VALUE_DECIMAL =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

type OpenAPIDoc = {
  components?: {
    schemas?: Record<string, object>
  }
}

let cachedDoc: OpenAPIDoc | null = null
let cachedAjv: Ajv2020 | null = null

export async function loadOpenApi(): Promise<OpenAPIDoc> {
  if (cachedDoc) return cachedDoc
  // dereference 展开 $ref，便于直接喂给 Ajv
  cachedDoc = (await SwaggerParser.dereference(openapiPath)) as OpenAPIDoc
  return cachedDoc
}

function getAjv(): Ajv2020 {
  if (cachedAjv) return cachedAjv
  cachedAjv = new Ajv2020({
    allErrors: true,
    strict: false, // OpenAPI 扩展关键字（如 example）不进 JSON Schema
  })
  addFormats(cachedAjv)
  return cachedAjv
}

export async function compileSchema(name: string): Promise<ValidateFunction> {
  const doc = await loadOpenApi()
  const schema = doc.components?.schemas?.[name]
  if (!schema) {
    throw new Error(`OpenAPI schema not found: ${name}`)
  }
  const ajv = getAjv()
  const existing = ajv.getSchema(name)
  if (existing) return existing
  return ajv.compile({ ...schema, $id: name })
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return '(no details)'
  return errors
    .map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`)
    .join('; ')
}

export async function assertValidSchema(
  schemaName: string,
  data: unknown,
): Promise<void> {
  const validate = await compileSchema(schemaName)
  const ok = validate(data)
  if (!ok) {
    throw new Error(
      `${schemaName} validation failed: ${formatAjvErrors(validate.errors)}`,
    )
  }
}

export async function assertInvalidSchema(
  schemaName: string,
  data: unknown,
): Promise<void> {
  const validate = await compileSchema(schemaName)
  const ok = validate(data)
  if (ok) {
    throw new Error(`${schemaName} unexpectedly accepted payload`)
  }
}
