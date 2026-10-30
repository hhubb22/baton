import { expect, it } from 'vite-plus/test'
import { runningSteps } from './running-steps.ts'

it('retains the newest steps and bounds the encoded snapshot', () => {
  const result = runningSteps(
    Array.from({ length: 40 }, (_, ordinal) => ({
      id: `item-${ordinal}`,
      type: 'dynamic_tool',
      status: 'running',
      ordinal,
      data: { input: `start${'😀'.repeat(30000)}end` },
    })),
  )
  expect(result.truncated).toBe(true)
  expect(result.steps.length).toBeLessThanOrEqual(32)
  expect(result.steps.at(-1)?.item_id).toBe('item-39')
  expect(result.steps[0]!.ordinal).toBeGreaterThanOrEqual(8)
  expect(
    Buffer.byteLength(JSON.stringify({ running_steps: result.steps, running_steps_truncated: true })),
  ).toBeLessThanOrEqual(64 * 1024)
  expect(result.steps.some((step) => step.truncated)).toBe(true)
})
