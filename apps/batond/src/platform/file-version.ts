import { lstat } from 'node:fs/promises'
import { hasCode } from './errors.ts'

/** Metadata only; atomic replacement, permission changes and missing files all invalidate a snapshot. */
export async function fileVersion(path: string): Promise<string> {
  try {
    const info = await lstat(path)
    return JSON.stringify([info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeMs, info.ctimeMs])
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return 'missing'
    throw error
  }
}
