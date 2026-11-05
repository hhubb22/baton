import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { TranscriptWriter } from '../transcript/writer.ts'
import { runTranscriptCLI } from './transcript.ts'

it('prints a thread transcript from the local private directory', async () => {
  const dataDirectory = await makePrivateTempDirectory('baton-cli-transcript-')
  const threadId = randomUUID()
  const writer = await TranscriptWriter.open({
    file: join(dataDirectory, 'threads', threadId, 'generation', 'transcript.jsonl'),
    dataDirectory,
  })
  writer.write('reply', { text: 'local transcript' })
  await writer.close()
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await runTranscriptCLI(['--thread-id', threadId, '--data-dir', dataDirectory])
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(output).toContain('"kind":"reply"')
    expect(output).toContain('local transcript')
  } finally {
    write.mockRestore()
  }
})

it('rejects incomplete transcript selection', async () => {
  await expect(runTranscriptCLI(['--project-id', randomUUID()])).rejects.toThrow('--run-id')
})
