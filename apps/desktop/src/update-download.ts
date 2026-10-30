import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

export async function verifyDesktopDownload(item: { size: number; sha256: string }, path: string): Promise<void> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('安装包必须是普通文件')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const start = await handle.stat()
    if (
      !start.isFile() ||
      start.ino !== before.ino ||
      start.dev !== before.dev ||
      start.nlink !== 1 ||
      start.size !== item.size
    )
      throw new Error('安装包大小不符或文件已被替换')
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length
      if (size > item.size) throw new Error('安装包大小不符')
      hash.update(chunk)
    }
    const end = await handle.stat()
    const current = await lstat(path)
    if (
      size !== item.size ||
      hash.digest('hex') !== item.sha256 ||
      end.size !== start.size ||
      end.mtimeMs !== start.mtimeMs ||
      end.ctimeMs !== start.ctimeMs ||
      current.isSymbolicLink() ||
      current.ino !== start.ino ||
      current.dev !== start.dev
    )
      throw new Error('安装包校验失败或文件已被替换')
  } finally {
    await handle.close()
  }
}
