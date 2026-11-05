import { appendFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'
const fakeApiKey = ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-')
import { makePrivateTempDirectory } from '../testing/private.ts'
import { readTranscriptPage } from './reader.ts'
import { redactTranscript } from './redact.ts'
import { readThreadTranscriptResult } from './thread.ts'
import { TranscriptWriter } from './writer.ts'

it('writes each transcript line before the run finishes and resumes sequence', async () => {
  const dataDirectory = await makePrivateTempDirectory('baton-transcript-')
  const file = join(dataDirectory, 'threads', 'thread', 'generation', 'transcript.jsonl')
  const writer = await TranscriptWriter.open({ file, dataDirectory })
  writer.write('turn.started', { message: 'hello' })
  const visible = await readFile(file, 'utf8')
  expect(visible).toContain('"kind":"turn.started"')
  expect(visible).toContain('"seq":1')
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  writer.write('item.started', { input: 'pwd' })
  await writer.close()

  const resumed = await TranscriptWriter.open({ file, dataDirectory })
  resumed.write('item.completed', { output: '/tmp' })
  await resumed.close()
  const lines = (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(lines.map((line) => [line.seq, line.kind])).toEqual([
    [1, 'turn.started'],
    [2, 'item.started'],
    [3, 'item.completed'],
  ])
  expect(lines[0]).toMatchObject({ version: expect.any(String), commit: expect.any(String), ts: expect.any(String) })
})

it('marks an unfinished final line and supports byte offsets', async () => {
  const dataDirectory = await makePrivateTempDirectory('baton-transcript-tail-')
  const file = join(dataDirectory, 'transcript.jsonl')
  const writer = await TranscriptWriter.open({ file, dataDirectory })
  writer.write('reply', { text: 'done' })
  await writer.close()
  await appendFile(file, '{"seq":2,"kind":"partial"')

  const first = await readTranscriptPage(file, 0)
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.page.incomplete_tail).toBe(true)
  expect(Buffer.from(first.page.data, 'base64').toString('utf8')).toContain('"partial"')
  const second = await readTranscriptPage(file, first.page.next_offset)
  expect(second).toMatchObject({ ok: true, page: { offset: first.page.next_offset, done: true } })
})

it('redacts nested credentials and key formats', () => {
  const redacted = redactTranscript({
    authorization: 'Bearer abcdefghijklmnop',
    nested: { api_key: 'value', message: `key ${fakeApiKey}` },
    privateKey: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    device_code: 'device-code-value',
  })
  expect(JSON.stringify(redacted)).not.toContain('sk-')
  expect(JSON.stringify(redacted)).not.toContain('device-code-value')
  expect(JSON.stringify(redacted)).not.toContain('BEGIN PRIVATE KEY')
  expect(redacted).toMatchObject({
    authorization: '[REDACTED]',
    nested: { api_key: '[REDACTED]' },
  })
})

it('reads a thread transcript without starting a worker', async () => {
  const dataDirectory = await makePrivateTempDirectory('baton-transcript-thread-')
  const threadDirectory = join(dataDirectory, 'threads', 'thread')
  const file = join(threadDirectory, 'generation', 'transcript.jsonl')
  const writer = await TranscriptWriter.open({ file, dataDirectory })
  writer.write('turn.started', { text: 'hello' })
  await writer.close()

  const result = await readThreadTranscriptResult(dataDirectory, threadDirectory, {
    type: 'session.request',
    operation_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    action: 'transcript',
    storage_generation: 'generation',
  })
  expect(result.ok).toBe(true)
  expect(result.transcript).toMatchObject({ offset: 0, done: true, incomplete_tail: false })
})
