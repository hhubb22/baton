import { expect, it } from 'vite-plus/test'
import type { ProjectRuntimeRequest } from '@baton/protocol'
import { ProjectRPC } from './project-rpc.ts'

const request: ProjectRuntimeRequest = {
  type: 'project_runtime.request',
  run_id: '5856880f-553b-4f61-ad78-5758be9363db',
  lease_epoch: 1,
  operation: 'renew',
}

it('correlates out-of-order responses and bounds pending requests', async () => {
  const sent: string[] = []
  const rpc = new ProjectRPC(async (_request, id) => {
    sent.push(id)
  }, 2)
  const controller = new AbortController()
  try {
    const first = rpc.request(request, controller.signal)
    const second = rpc.request(request, controller.signal)
    await expect(rpc.request(request, controller.signal)).rejects.toThrow('已满')
    expect(rpc.receive('unknown', { type: 'project_runtime.result', ok: true })).toBe(false)
    expect(rpc.receive(sent[1], { type: 'project_runtime.result', ok: true, data: { second: true } })).toBe(true)
    expect(rpc.receive(sent[0], { type: 'project_runtime.result', ok: false, code: 'lease_lost' })).toBe(true)
    expect(await second).toMatchObject({ ok: true, data: { second: true } })
    expect(await first).toMatchObject({ ok: false, code: 'lease_lost' })
  } finally {
    rpc.close()
  }
})

it('cancels a request whose transport write is stalled and ignores late replies', async () => {
  let sentId = ''
  const rpc = new ProjectRPC((_request, id) => {
    sentId = id
    return new Promise<void>(() => {})
  }, 1)
  const controller = new AbortController()
  const response = rpc.request(request, controller.signal)
  const cancelled = expect(response).rejects.toThrow('已取消')
  await Promise.resolve()
  controller.abort()
  await cancelled
  expect(rpc.receive(sentId, { type: 'project_runtime.result', ok: true })).toBe(false)
  rpc.close()
  await expect(rpc.request(request, new AbortController().signal)).rejects.toThrow('已取消')
})

it('rejects all requests on disconnect and isolates a replacement connection', async () => {
  const ids: string[] = []
  const old = new ProjectRPC(async (_request, id) => {
    ids.push(id)
  })
  const replacement = new ProjectRPC(async (_request, id) => {
    ids.push(id)
  })
  try {
    const first = old.request(request, new AbortController().signal)
    const stopped = expect(first).rejects.toThrow('已断开')
    await Promise.resolve()
    old.close()
    await stopped
    const next = replacement.request(request, new AbortController().signal)
    await Promise.resolve()
    expect(replacement.receive(ids[0], { type: 'project_runtime.result', ok: true })).toBe(false)
    expect(replacement.receive(ids[1], { type: 'project_runtime.result', ok: true })).toBe(true)
    expect(await next).toMatchObject({ ok: true })
  } finally {
    old.close()
    replacement.close()
  }
})
