import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, unlink } from 'node:fs/promises'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { join } from 'node:path'
import { Schema } from 'effect'
import { FullOutputReference, SessionResult, UUID, type SessionRequest, type WorkerOpenConfig } from '@baton/protocol'
import { afterEach, expect, it } from 'vite-plus/test'
import { initializeWorkerDirectory, LocalWorkerHost } from '../daemon/host.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { BoundedOutput } from '../execution/output.ts'
import { FullOutputStore, fullOutputPageBytes, pruneDeviceOutputs, readOutputRetentionDays } from './full-output.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await makePrivateTempDirectory('baton-full-')
  roots.push(root)
  const config: WorkerOpenConfig = {
    thread_id: randomUUID(),
    node_id: randomUUID(),
    storage_generation: 'generation:local-v1',
    agent_type: 'cursor',
    runtime_mode: 'full-access',
    working_directory: root,
    execution_timeout_seconds: 60,
    adapter_config: {},
  }
  const paths = await initializeWorkerDirectory(root, config.thread_id)
  const store = new FullOutputStore(paths.threadDirectory)
  const request = (reference: FullOutputReference, cursor?: string): SessionRequest => ({
    type: 'session.request',
    action: 'full_output',
    operation_id: randomUUID(),
    session_id: config.thread_id,
    output_id: reference.id,
    storage_generation: reference.storage_generation,
    ...(cursor ? { cursor } : {}),
  })
  return { root, config, paths, store, request }
}

it('retains raw shell chunks including the omitted middle and pages exact bytes without a running Worker', async () => {
  const f = await fixture()
  const writer = await f.store.begin(f.config, 30)
  const bounded = new BoundedOutput((bytes) => writer.write(bytes))
  const original = Buffer.concat([
    Buffer.from('HEAD'.repeat(6000)),
    Buffer.from('middle🙂\0'.repeat(6000)),
    Buffer.from([255, 254]),
    Buffer.from('TAIL'.repeat(6000)),
  ])
  for (let offset = 0; offset < original.length; offset += 197) bounded.write(original.subarray(offset, offset + 197))
  const summary = bounded.result(0)
  expect(summary.truncated).toBe(true)
  expect(Buffer.from(summary.output, summary.encoding ?? 'utf8').length).toBe(32768)
  const reference = await writer.finish()
  const recovered: Buffer[] = []
  let cursor: string | undefined
  const host = new LocalWorkerHost(f.root)
  for (let i = 0; i < 100; i++) {
    const response = await host.request(f.config.thread_id, {
      type: 'session_request',
      ok: true,
      session_request: f.request(reference, cursor),
    })
    const result = Schema.decodeUnknownSync(SessionResult)(response.session_result)
    expect(result.ok).toBe(true)
    const page = result.full_output
    if (!page) throw new Error('Expected a full output page')
    const bytes = Buffer.from(page.data, 'base64')
    expect(bytes.length).toBeLessThanOrEqual(fullOutputPageBytes)
    expect(page.offset).toBe(Number(cursor ?? 0))
    recovered.push(bytes)
    cursor = result.cursor
    if (page.done) break
  }
  expect(Buffer.concat(recovered)).toEqual(original)
  expect(Buffer.concat(recovered).includes(Buffer.from('middle🙂\0'))).toBe(true)
})

it('rejects a different Thread, generation, malformed cursor and symbolic links, and restores private permissions', async () => {
  const f = await fixture()
  const reference = await f.store.put(f.config, Buffer.from('private reply'), 30)
  const read = f.request(reference)
  expect((await f.store.read({ ...read, session_id: randomUUID() })).code).toBe('output_identity_mismatch')
  expect((await f.store.read({ ...read, storage_generation: 'another-generation' })).code).toBe(
    'output_identity_mismatch',
  )
  expect((await f.store.read({ ...read, cursor: '999999999999999999999999' })).code).toBe('invalid_cursor')
  expect((await f.store.read({ ...read, cursor: '-1' })).code).toBe('invalid_cursor')
  const path = join(f.store.directory, `${reference.id}.bin`)
  if (process.platform !== 'win32') {
    await chmod(path, 0o644)
    await chmod(f.store.directory, 0o755)
    expect((await f.store.read(read)).code).toBeUndefined()
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    expect((await lstat(f.store.directory)).mode & 0o777).toBe(0o700)
    const outside = join(f.root, 'secret')
    await writePrivateFileAtomic(outside, 'private reply')
    await unlink(path)
    await symlink(outside, path)
    expect((await f.store.read(read)).code).toBe('output_unavailable')
  }
})

it('enforces configurable expiration on read and reclaims expired files for inactive Threads', async () => {
  const f = await fixture()
  expect(await readOutputRetentionDays(f.root)).toBe(30)
  await writePrivateFileAtomic(join(f.root, 'output-retention.json'), JSON.stringify({ retention_days: 7 }))
  expect(await readOutputRetentionDays(f.root)).toBe(7)
  const reference = await f.store.put(f.config, Buffer.from('expired reply'), 7)
  expect(Date.parse(reference.expires_at) - Date.now()).toBeGreaterThan(6.99 * 86400000)
  const metadata = join(f.store.directory, `${reference.id}.json`)
  const value = Schema.decodeUnknownSync(Schema.Struct({ ...FullOutputReference.fields, thread_id: UUID }))(
    JSON.parse(await readFile(metadata, 'utf8')),
  )
  await writePrivateFileAtomic(metadata, JSON.stringify({ ...value, expires_at: '2000-01-01T00:00:00.000Z' }))
  expect((await f.store.read(f.request(reference))).code).toBe('output_expired')
  expect(await readdir(f.store.directory)).toEqual([])
  await f.store.put(f.config, Buffer.from('scheduled cleanup'), 1)
  const executionDirectory = join(f.root, 'executions', randomUUID())
  await mkdir(executionDirectory, { recursive: true, mode: 0o700 })
  const executionOutput = new FullOutputStore(executionDirectory)
  await executionOutput.put(f.config, Buffer.from('execution output'), 1)
  await pruneDeviceOutputs(f.root, Date.now() + 2 * 86400000)
  expect(await readdir(f.store.directory)).toEqual([])
  expect(await readdir(executionOutput.directory)).toEqual([])
  await writePrivateFileAtomic(join(f.root, 'output-retention.json'), JSON.stringify({ retention_days: 0 }))
  await expect(readOutputRetentionDays(f.root)).rejects.toThrow()
})
