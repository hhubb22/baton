import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProjectTranscript } from '../src/transcript.js'
import { redactTranscript } from '@baton/protocol'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

it('creates private project run records and writes each line before the run ends', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'baton-project-transcript-'))
  directories.push(dataDirectory)
  const transcript = await ProjectTranscript.open(dataDirectory, 'project', 'run')
  transcript.write('run.started', { kind: 'foreground' })
  const file = join(dataDirectory, 'project-runs', 'project', 'run.jsonl')
  expect(await readFile(file, 'utf8')).toContain('"kind":"run.started"')
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  transcript.write('llm.response', { text: 'ok' })
  await transcript.close()

  const resumed = await ProjectTranscript.open(dataDirectory, 'project', 'run')
  resumed.write('run.ended', { state: 'completed' })
  await resumed.close()
  const lines = (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(lines.map((line) => [line.seq, line.kind])).toEqual([
    [1, 'run.started'],
    [2, 'llm.response'],
    [3, 'run.ended'],
  ])
})

it('redacts tool payloads before project records reach disk', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'baton-project-transcript-redact-'))
  directories.push(dataDirectory)
  const transcript = await ProjectTranscript.open(dataDirectory, 'project', 'run')
  transcript.write('tool.result', {
    output: 'Authorization: Bearer abcdefghijklmnop',
    api_key: 'plain-secret-value',
  })
  await transcript.close()
  const file = join(dataDirectory, 'project-runs', 'project', 'run.jsonl')
  const contents = await readFile(file, 'utf8')
  expect(contents).not.toContain('abcdefghijklmnop')
  expect(contents).not.toContain('plain-secret-value')
  expect(contents).toContain('[REDACTED]')
})

it('redacts private keys and subscription token shapes', () => {
  const redacted = JSON.stringify(
    redactTranscript({
      message: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
      nested: { refresh_token: 'refresh-value', text: 'eyJabcdefgh.abcdefgh.abcdefgh' },
    }),
  )
  expect(redacted).not.toContain('PRIVATE KEY')
  expect(redacted).not.toContain('refresh-value')
  expect(redacted).not.toContain('eyJabcdefgh')
})
