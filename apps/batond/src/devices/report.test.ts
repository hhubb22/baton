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
