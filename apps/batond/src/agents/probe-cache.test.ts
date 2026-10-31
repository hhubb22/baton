import type { RuntimeAgent } from '@baton/protocol'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeAgentProbe } from './probe-cache.ts'

const agent = (type: string, status: RuntimeAgent['status'] = 'available'): RuntimeAgent => ({
  agent_type: type,
  version: 'offline',
  status,
  models: [],
  default_model: 'default',
  capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
})

it('caches probes independently, refreshes changed fingerprints and expires successful results', async () => {
  let now = 0
  let changed = false
  const probe = vi.fn(async (type: string) => agent(type))
  const read = makeAgentProbe({
    dataDirectory: '/unused',
    now: () => now,
    fingerprint: async (type) => (type === 'codex' && changed ? 'new' : 'old'),
    probe,
  })
  const signal = new AbortController().signal
  const first = await read(signal)
  Reflect.set(first[0]!, 'models', [{ id: 'mutated', name: 'mutated' }])
  expect((await read(signal))[0]!.models).toEqual([])
  expect(probe).toHaveBeenCalledTimes(4)
  changed = true
  await read(signal)
  expect(probe).toHaveBeenCalledTimes(5)
  now = 300_000
  await read(signal)
  expect(probe).toHaveBeenCalledTimes(9)
})

it('backs off unavailable probes, resets backoff on changes and never caches an aborted probe', async () => {
  let now = 0
  let version = 'old'
  const probe = vi.fn(async (type: string) => agent(type, 'unavailable'))
  const read = makeAgentProbe({
    dataDirectory: '/unused',
    now: () => now,
    fingerprint: async () => version,
    probe,
  })
  const signal = new AbortController().signal
  await read(signal)
  now = 30_000
  await read(signal)
  expect(probe).toHaveBeenCalledTimes(8)
  now = 60_000
  await read(signal)
  expect(probe).toHaveBeenCalledTimes(8)
  version = 'new'
  await read(signal)
  expect(probe).toHaveBeenCalledTimes(12)
  const controller = new AbortController()
  now += 30_000
  probe.mockImplementation(async (type) => {
    controller.abort()
    return agent(type)
  })
  await expect(read(controller.signal)).rejects.toThrow()
  const afterAbort = probe.mock.calls.length
  probe.mockImplementation(async (type) => agent(type))
  await read(signal)
  expect(probe).toHaveBeenCalledTimes(afterAbort + 4)
})

it('retries probe exceptions with backoff instead of spawning again on every check', async () => {
  let now = 0
  const probe = vi.fn(async (): Promise<RuntimeAgent> => {
    throw new Error('Offline failure')
  })
  const read = makeAgentProbe({
    dataDirectory: '/unused',
    now: () => now,
    fingerprint: async () => 'same',
    probe,
  })
  const signal = new AbortController().signal
  await expect(read(signal)).rejects.toThrow('Offline failure')
  await expect(read(signal)).rejects.toThrow('Offline failure')
  expect(probe).toHaveBeenCalledTimes(4)
  now = 30_000
  await expect(read(signal)).rejects.toThrow('Offline failure')
  expect(probe).toHaveBeenCalledTimes(8)
})

it('invalidates native credentials and CLI metadata without reading credential contents', async () => {
  const directory = await makePrivateTempDirectory('baton-agent-fingerprint-')
  try {
    const bin = join(directory, 'bin')
    const codex = join(directory, 'codex')
    await mkdir(bin, { mode: 0o700 })
    await mkdir(codex, { mode: 0o700 })
    vi.stubEnv('HOME', directory)
    vi.stubEnv('PATH', bin)
    vi.stubEnv('CODEX_HOME', codex)
    const probe = vi.fn(async (type: string) => agent(type))
    const read = makeAgentProbe({ dataDirectory: directory, probe })
    const signal = new AbortController().signal
    await read(signal)
    await read(signal)
    expect(probe).toHaveBeenCalledTimes(4)
    await writePrivateFileAtomic(join(codex, 'auth.json'), 'not parsed by fingerprint')
    await read(signal)
    expect(probe).toHaveBeenCalledTimes(5)
    await writePrivateFileAtomic(join(bin, 'codex'), 'not executed by fingerprint')
    await read(signal)
    expect(probe).toHaveBeenCalledTimes(6)
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})
