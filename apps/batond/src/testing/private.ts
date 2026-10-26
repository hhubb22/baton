import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePrivateDirectory } from '../platform/private.ts'

export async function makePrivateTempDirectory(prefix: string): Promise<string> {
  // Darwin UDS endpoints must fit within 103 bytes, including the socket name.
  const path = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), prefix))
  try {
    await validatePrivateDirectory(path)
    return await realpath(path)
  } catch (error) {
    await rm(path, { recursive: true, force: true })
    throw error
  }
}
