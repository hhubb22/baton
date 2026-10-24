import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'
import { hasCode } from './errors.ts'
import { openPrivateFile, protectPrivateDirectory, writePrivateFileAtomic } from './private.ts'

const Arguments = Schema.Union([
  Schema.Tuple([Schema.Literal('sidecar-file'), Schema.Literal('protect-dir'), Schema.String]),
  Schema.Tuple([Schema.Literal('sidecar-file'), Schema.Literals(['read', 'write']), Schema.String, Schema.String]),
])
const maximum = 64 * 1024
const failed = () => new Error('credential_private_file_failed')

/** Runtime 源码子进程显式接收 host argv，路径与参数不经过 shell。 */
export function privateFileHostEnvironment(runtimeEntry: URL): NodeJS.ProcessEnv {
  const require = createRequire(runtimeEntry)
  return {
    BATON_SIDECAR_HOST_COMMAND: JSON.stringify({
      file: process.execPath,
      args: [
        '--import',
        require.resolve('tsx'),
        fileURLToPath(new URL('../../../apps/batond/src/platform/private-file-host-entry.ts', runtimeEntry)),
      ],
    }),
  }
}

export async function runPrivateFileHost(
  args: readonly string[],
  input: AsyncIterable<Uint8Array | string> = process.stdin,
  output: (bytes: Uint8Array) => void = (bytes) => {
    process.stdout.write(bytes)
  },
): Promise<number> {
  try {
    const parsed = Schema.decodeUnknownSync(Arguments)(args)
    const [, operation, directory, file] = parsed
    if (!isAbsolute(directory) || directory.includes('\0')) throw failed()
    if (operation === 'protect-dir') {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await protectPrivateDirectory(directory)
      return 0
    }
    if (!file || !isAbsolute(file) || file.includes('\0') || dirname(resolve(file)) !== resolve(directory))
      throw failed()
    const path = resolve(file)
    if (operation === 'read') {
      const handle = await openPrivateFile(path)
      try {
        if ((await handle.stat()).size > maximum) throw failed()
        const buffer = Buffer.alloc(maximum + 1)
        let size = 0
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
          if (!bytesRead) break
          size += bytesRead
        }
        if (size > maximum) throw failed()
        output(buffer.subarray(0, size))
        return 0
      } finally {
        await handle.close()
      }
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > maximum) throw failed()
      chunks.push(bytes)
    }
    await writePrivateFileAtomic(path, Buffer.concat(chunks, size))
    return 0
  } catch (error) {
    if (args[1] === 'read' && hasCode(error, 'ENOENT')) return 3
    return 1
  }
}
