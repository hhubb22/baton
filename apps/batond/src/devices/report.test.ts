import { RuntimeReport, jsonLimit } from '@baton/protocol'
import { Schema } from 'effect'
import { expect, it } from 'vite-plus/test'
import { boundRuntimeReport } from './report.ts'

it.each([48 * 1024, 64 * 1024])('counts escaped ampersands against the %i-byte report budget', (maxBytes) => {
  const report: RuntimeReport = {
    exec: { enabled: false, shell: '/bin/sh' },
    roots: Array.from({ length: 100 }, (_, index) => ({
      root_id: `root-${index}`,
      path: `/workspace/${'&'.repeat(200)}/${index}`,
    })),
    repos: [],
  }
  expect(Buffer.byteLength(JSON.stringify(report, null, 1))).toBeLessThan(maxBytes)
  expect(Schema.is(RuntimeReport)(report)).toBe(false)

  const bounded = boundRuntimeReport(report, maxBytes)
  expect(Schema.is(RuntimeReport.check(jsonLimit(maxBytes, 1, true)))(bounded)).toBe(true)
  expect(bounded.truncated).toBe(true)
  expect(bounded.roots?.length).toBeGreaterThan(0)
  expect(bounded.roots?.length).toBeLessThan(report.roots?.length ?? 0)
})

it('bounds a large model catalog without changing input or removing the default model', () => {
  const report: RuntimeReport = {
    exec: { enabled: false, shell: '/bin/sh' },
    roots: [],
    repos: [],
    agents: [
      {
        agent_type: 'codex',
        version: 'offline',
        status: 'available',
        default_model: 'default',
        capabilities: { create: true, queue: true, steer: true, stop: true, resume: true, switch_model: true },
        models: Array.from({ length: 2000 }, (_, index) => ({
          id: index === 1999 ? 'default' : `model-${index}`,
          name: '&'.repeat(100),
        })),
      },
    ],
  }
  const bounded = boundRuntimeReport(report)
  expect(Schema.is(RuntimeReport)(bounded)).toBe(true)
  expect(bounded.agents?.[0]?.models).toContainEqual({ id: 'default', name: '&'.repeat(100) })
  expect(bounded.agents?.[0]?.models?.length).toBeLessThan(2000)
  expect(report.agents?.[0]?.models).toHaveLength(2000)
})
