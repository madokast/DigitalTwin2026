import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildDeployServerlessYml,
  patchServerlessFunctionName,
} from './deploy'

const FIXTURE_YML = `component: scf
name: digitaltwin-api
org: digitaltwin2026
app: digitaltwin-api

inputs:
  name: digitaltwin-api-\${stage}
  type: web
  region: ap-guangzhou
  runtime: Go1
  description: DigitalTwin2026 HTTP API (Go Web on SCF)
  memorySize: 64
  src: ./.scf-build
`

describe('patchServerlessFunctionName', () => {
  it('patches inputs.name only, not top-level component name', () => {
    const out = patchServerlessFunctionName(FIXTURE_YML, 'digitaltwin-api-prod')
    expect(out).toMatch(/^name: digitaltwin-api$/m)
    expect(out).toMatch(/^ {2}name: digitaltwin-api-prod$/m)
    expect(out).not.toMatch(/digitaltwin-api-\$\{stage\}/)
  })

  it('does not leave stage placeholder in inputs.name', () => {
    const out = patchServerlessFunctionName(FIXTURE_YML, 'digitaltwin-api-test')
    const inputsName = out.match(/^ {2}name:\s*(.+)$/m)?.[1]
    expect(inputsName).toBe('digitaltwin-api-test')
  })

  it('throws when inputs.name missing', () => {
    expect(() =>
      patchServerlessFunctionName('component: scf\nname: only-top\n', 'x'),
    ).toThrow(/missing inputs\.name/)
  })
})

describe('buildDeployServerlessYml', () => {
  it('builds overlay matching repo serverless.yml shape', () => {
    const base = readFileSync(
      resolve(import.meta.dirname, '..', 'serverless.yml'),
      'utf8',
    )
    const out = buildDeployServerlessYml(base, 'digitaltwin-api-prod')
    expect(out).toMatch(/^name: digitaltwin-api$/m)
    expect(out).toMatch(/^ {2}name: digitaltwin-api-prod$/m)
    expect(out).toMatch(/^ {2}runtime: Go1$/m)
    expect(out).toMatch(/^ {2}type: web$/m)
    expect(out).not.toMatch(/^ {2}runtime: CustomRuntime$/m)
    expect(out).not.toMatch(/^ {2}runtime: Nodejs/m)
    expect(out).not.toMatch(/digitaltwin-api-\$\{stage\}/)
  })
})
