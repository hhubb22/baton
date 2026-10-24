import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vite-plus/test'
import type { ProjectRuntimeRequest } from '@baton/protocol'
import { serveRuntime } from './stdio.ts'
import { RuntimeWaits } from './waits.ts'
import { MAX_FRAME, success } from './types.ts'

it.each(['capacity', 'oversized', 'utf8', 'trailing-json'] as const)(
  'closes malformed stdio (%s) within bounded work',
  async (mode) => {
    const input = new PassThrough(),
      output = new PassThrough()
    const cancel = new AbortController()
    let calls = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const server = serveRuntime(
      input,
      output,
      async () => {
        calls++
        await blocked
        return success({})
      },
      cancel.signal,
    )
    const rejected = expect(server).rejects.toThrow()
    if (mode === 'capacity')
      for (let id = 1; id <= 9; id++) input.write(JSON.stringify({ id, request: { operation: 'bootstrap' } }) + '\n')
    if (mode === 'oversized') input.write('x'.repeat(MAX_FRAME + 1))
    if (mode === 'utf8') input.write(Buffer.from([0xff, 10]))
    if (mode === 'trailing-json') input.write('{"id":1,"request":{}}{}\n')
    await delay(20)
    release()
    await rejected
    expect(calls).toBe(mode === 'capacity' ? 8 : 0)
    cancel.abort()
  },
)
it('preserves eight concurrent responses and serializes complete frames', async () => {
  const input = new PassThrough(),
    output = new PassThrough()
  const cancel = new AbortController()
  let text = ''
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString()
  })
  const server = serveRuntime(
    input,
    output,
    async (request) => {
      await delay(1)
      return success({ operation: request.operation as string })
    },
    cancel.signal,
  )
  for (let id = 1; id <= 8; id++) input.write(JSON.stringify({ id, request: { operation: 'bootstrap' } }) + '\n')
  input.end()
  await server
  expect(
    text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).id),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  cancel.abort()
})
it('does not wake Thread waiters for generic input, duplicate versions or unauthorized threads', async () => {
  const waits = new RuntimeWaits(),
    thread = randomUUID()
  const request: ProjectRuntimeRequest = {
    type: 'project_runtime.request',
    run_id: randomUUID(),
    lease_epoch: 1,
    operation: 'call_tool',
    tool_call_id: 'exec',
  }
  const pending = success({ pending: true, thread_id: thread, version: 3, wait_remaining_ms: 1000, wait_protocol: 1 })
  waits.finish(waits.begin('exec'), request, pending, 0)
  const cancel = new AbortController()
  expect(await waits.poll({ thread_id: randomUUID(), after_version: 3 }, cancel.signal, () => 0)).toMatchObject({
    code: 'invalid_request',
  })
  expect(await waits.poll({ thread_id: thread, after_version: 4 }, cancel.signal, () => 0)).toMatchObject({
    code: 'invalid_request',
  })
  let resolved = false,
    now = 0
  const waiting = waits
    .poll({ thread_id: thread, after_version: 3, wait_ms: 1000 }, cancel.signal, () => now)
    .then((r) => {
      resolved = true
      return r
    })
  waits.notify([
    { thread_id: thread, version: 3 },
    { thread_id: randomUUID(), version: 20 },
  ])
  await delay(10)
  expect(resolved).toBe(false)
  now = 20
  waits.notify([{ thread_id: thread, version: 4 }])
  expect(await waiting).toEqual(success({ reason: 'thread_changed', version: 4 }))
  const first = waits.begin('exec'),
    second = waits.begin('exec')
  const final = success({ seq: 3, kind: 'tool_result', payload: {} })
  expect(waits.finish(first, request, final, now)).toEqual(final)
  expect(waits.finish(second, request, pending, now)).toEqual(final)
  expect(await waits.poll({ thread_id: thread, after_version: 3 }, cancel.signal, () => now)).toMatchObject({
    code: 'invalid_request',
  })
})
