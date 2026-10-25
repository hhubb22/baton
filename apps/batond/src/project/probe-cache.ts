import { lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ProcessCommand } from '../platform/process.ts'
import { isMissing } from '../daemon/identity.ts'

/** 只记录文件元数据；凭据内容不进入报告缓存。 */
export async function probeFingerprint(command: ProcessCommand): Promise<string | undefined> {
  const metadata = async (path: string, follow: boolean) => {
    try {
      const info = await (follow ? stat(path) : lstat(path))
      return [info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeMs, info.ctimeMs]
    } catch (error) {
      if (isMissing(error)) return 'missing'
      throw error
    }
  }
  try {
    const directory =
      command.env?.BATON_PROJECT_RUNTIME_DATA_DIR ??
      process.env.BATON_PROJECT_RUNTIME_DATA_DIR ??
      join(homedir(), '.baton', 'project-runtime')
    const files = await readdir(directory).catch((error: unknown) => {
      if (isMissing(error)) return []
      throw error
    })
    const paths = [
      directory,
      ...files
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map((file) => join(directory, file)),
    ]
    const runtimePaths = [command.file, ...(command.args ?? []).filter(isAbsolute)]
    return JSON.stringify([
      command,
      await Promise.all(runtimePaths.map((path) => metadata(path, true))),
      await Promise.all(paths.map((path) => metadata(path, false))),
    ])
  } catch {
    return undefined
  }
}
