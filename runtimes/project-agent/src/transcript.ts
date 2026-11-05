import { constants, writeSync } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { redactTranscript } from '@baton/protocol'
import { releaseMetadata } from '@baton/protocol/release.mjs'

const sensitiveKey =
  /^(authorization|cookie|csrf|csrf_token|device_code|access|access_token|refresh|refresh_token|id_token|password|secret|api_key|token|private_key|client_secret)$/i

const readSecrets = async (dataDirectory: string): Promise<string[]> => {
  const secrets: string[] = []
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /(API_KEY|_TOKEN$|^TOKEN$|SECRET|PASSWORD|PRIVATE_KEY|DEVICE_CODE)/i.test(name))
      secrets.push(value)
  }
  const collect = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 8) return
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === 'string' && nested.length >= 8 && sensitiveKey.test(key)) secrets.push(nested)
      else collect(nested, depth + 1)
    }
  }
  const credentialDirectory = process.env.BATON_PROJECT_RUNTIME_DATA_DIR ?? join(dataDirectory, 'credentials')
  try {
    for (const name of await readdir(credentialDirectory)) {
      if (!/^[a-z0-9-]{1,64}\.json$/.test(name)) continue
      collect(JSON.parse(await readFile(join(credentialDirectory, name), 'utf8')))
    }
  } catch {
    // 凭据目录不存在时没有可精确替换的值。
  }
  try {
    const token = (await readFile(join(dataDirectory, 'control.token'), 'utf8')).trim()
    if (token.length >= 8 && token.length <= 4096) secrets.push(token)
  } catch {
    // 未登录时没有控制令牌。
  }
  return [...new Set(secrets)]
}

const lastSequence = async (file: FileHandle) => {
  const size = (await file.stat()).size
  if (size === 0) return 0
  const length = Math.min(size, 64 * 1024)
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await file.read(buffer, 0, length, size - length)
  const tail = buffer.subarray(0, bytesRead)
  const end = tail.lastIndexOf(0x0a)
  if (end < 0) return 0
  const start = tail.lastIndexOf(0x0a, end - 1) + 1
  const match = /"seq":(\d+)/.exec(tail.subarray(start, end).toString('utf8'))
  return match ? Number(match[1]) : 0
}

/** Project Runtime 的实时 JSONL 写入；失败后停写，不影响模型与工具事务。 */
export class ProjectTranscript {
  private sequence: number
  private failed = false
  private closed = false
  private readonly release = releaseMetadata()

  private constructor(
    private readonly handle: FileHandle,
    sequence: number,
    private readonly secrets: ReadonlyArray<string>,
  ) {
    this.sequence = sequence
  }

  static async open(dataDirectory: string, projectId: string, runId: string): Promise<ProjectTranscript> {
    const directory = join(dataDirectory, 'project-runs', projectId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      await chmod(join(dataDirectory, 'project-runs'), 0o700)
      await chmod(directory, 0o700)
    }
    const file = join(directory, `${runId}.jsonl`)
    const handle = await open(
      file,
      constants.O_RDWR |
        constants.O_APPEND |
        constants.O_CREAT |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o600,
    )
    try {
      if (process.platform !== 'win32') await handle.chmod(0o600)
      const sequence = await lastSequence(handle).catch(() => 0)
      return new ProjectTranscript(handle, sequence, await readSecrets(dataDirectory))
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  write(kind: string, data: unknown): void {
    if (this.failed || this.closed) return
    const line = {
      seq: ++this.sequence,
      ts: new Date().toISOString(),
      version: this.release.version,
      commit: this.release.commit,
      kind,
      data: redactTranscript(data, this.secrets),
    }
    try {
      const bytes = Buffer.from(JSON.stringify(line) + '\n', 'utf8')
      let offset = 0
      while (offset < bytes.length) {
        const written = writeSync(this.handle.fd, bytes, offset, bytes.length - offset)
        if (written === 0) throw new Error('Transcript write made no progress')
        offset += written
      }
    } catch {
      this.failed = true
      console.error(JSON.stringify({ operation: 'transcript_write_failed', code: 'write_failed' }))
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (!this.failed) await this.handle.sync()
    } finally {
      await this.handle.close()
    }
  }
}

export const openProjectTranscript = async (
  projectId: string,
  runId: string,
): Promise<ProjectTranscript | undefined> => {
  const dataDirectory = process.env.BATON_PROJECT_DATA_DIR
  if (!dataDirectory) return undefined
  try {
    return await ProjectTranscript.open(dataDirectory, projectId, runId)
  } catch {
    console.error(JSON.stringify({ operation: 'transcript_open_failed', code: 'open_failed' }))
    return undefined
  }
}
