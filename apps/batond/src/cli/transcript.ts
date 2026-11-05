import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { Schema } from 'effect'
import { UUID } from '@baton/protocol'
import { defaultDataDirectory } from '../platform/layout.ts'
import { latestThreadTranscriptFile, projectRunTranscriptFile, readTranscriptPage } from '../transcript/reader.ts'

const writePage = (data: string) => {
  process.stdout.write(Buffer.from(data, 'base64'))
}

export async function runTranscriptCLI(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string', default: defaultDataDirectory() },
      'thread-id': { type: 'string' },
      'project-id': { type: 'string' },
      'run-id': { type: 'string' },
      follow: { type: 'boolean', default: false },
    },
  })
  const threadId = values['thread-id']
  const projectId = values['project-id']
  const runId = values['run-id']
  if (Boolean(threadId) === Boolean(projectId || runId))
    throw new Error(
      '用法：batond transcript --thread-id <UUID> [--follow] 或 --project-id <UUID> --run-id <UUID> [--follow]',
    )
  if (!threadId && (!projectId || !runId)) throw new Error('需要同时提供 --project-id 和 --run-id')
  Schema.decodeUnknownSync(UUID)(threadId ?? projectId)
  if (runId) Schema.decodeUnknownSync(UUID)(runId)
  let file = threadId
    ? await latestThreadTranscriptFile(values['data-dir']!, threadId)
    : projectRunTranscriptFile(values['data-dir']!, projectId!, runId!)
  while (!file && values.follow) {
    await sleep(250)
    file = threadId ? await latestThreadTranscriptFile(values['data-dir']!, threadId) : file
  }
  if (!file) throw new Error('运行记录不存在或已被清理')
  let offset = 0
  for (;;) {
    const result = await readTranscriptPage(file, offset)
    if (!result.ok) {
      if (result.code === 'transcript_missing' && values.follow) {
        await sleep(250)
        continue
      }
      throw new Error(`无法读取运行记录：${result.code}`)
    }
    if (result.page.next_offset > offset) {
      writePage(result.page.data)
      offset = result.page.next_offset
    }
    if (!values.follow) return
    await sleep(250)
  }
}
