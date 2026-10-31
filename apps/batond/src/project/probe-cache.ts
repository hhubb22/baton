import { lstat, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultCredentialsDirectory } from '../platform/layout.ts'
import type { ProcessCommand } from '../platform/process.ts'
import { hasCode } from '../platform/errors.ts'

/** 只记录文件元数据；凭据内容不进入报告缓存。 */
export async function probeFingerprint(command: ProcessCommand, dataDirectory?: string): Promise<string | undefined> {
  const metadata = async (path: string, follow: boolean) => {
    try {
      const info = await (follow ? stat(path) : lstat(path))
      return [info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeMs, info.ctimeMs]
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return 'missing'
      throw error
    }
  }
  try {
    const directory =
      command.env?.BATON_PROJECT_RUNTIME_DATA_DIR ??
      process.env.BATON_PROJECT_RUNTIME_DATA_DIR ??
      defaultCredentialsDirectory()
    const files = await readdir(directory).catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) return []
      throw error
    })
    const environmentDirectory = dataDirectory ? join(dataDirectory, 'environment') : undefined
    const environmentFiles = environmentDirectory
      ? await readdir(environmentDirectory).catch((error: unknown) => {
          if (hasCode(error, 'ENOENT')) return []
          throw error
        })
      : []
    const paths = [
      directory,
      ...(dataDirectory
        ? [join(dataDirectory, 'project-runtime.json'), join(dataDirectory, 'environment', 'environment.json')]
        : []),
      ...environmentFiles
        .filter((file) => file.startsWith('secrets-') && file.endsWith('.json'))
        .sort()
        .map((file) => join(environmentDirectory!, file)),
      ...files
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map((file) => join(directory, file)),
    ]
    const runtimePaths = [
      command.file,
      ...(command.args ?? []).flatMap((argument) =>
        argument.startsWith('file:') ? [fileURLToPath(argument)] : isAbsolute(argument) ? [argument] : [],
      ),
    ]
    return JSON.stringify([
      command,
      await Promise.all(runtimePaths.map((path) => metadata(path, true))),
      await Promise.all(paths.map((path) => metadata(path, false))),
    ])
  } catch {
    return undefined
  }
}
