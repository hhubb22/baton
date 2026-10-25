import { isAbsolute, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { isSea } from 'node:sea'
import { maximumCredentialBytes } from './credential-files.js'

export const credentialHostEnabled = () =>
  isSea() || process.platform === 'win32' || process.env.BATON_PRIVATE_FILE_HOST_COMMAND !== undefined

function nativeHost(): { file: string; args: string[]; timeout: number } {
  if (isSea()) return { file: process.execPath, args: [], timeout: 5000 }
  const configured = process.env.BATON_PRIVATE_FILE_HOST_COMMAND
  if (configured !== undefined) {
    try {
      if (Buffer.byteLength(configured) > maximumCredentialBytes) throw new Error()
      const host = JSON.parse(configured)
      if (
        !host ||
        typeof host !== 'object' ||
        Array.isArray(host) ||
        typeof host.file !== 'string' ||
        !isAbsolute(host.file) ||
        host.file.includes('\0') ||
        !Array.isArray(host.args) ||
        host.args.length > 64 ||
        host.args.some((argument: unknown) => typeof argument !== 'string' || argument.includes('\0')) ||
        Object.keys(host).some((key) => key !== 'file' && key !== 'args')
      )
        throw new Error()
      return { file: host.file, args: host.args, timeout: 5000 }
    } catch {
      throw new Error('credential_private_file_failed')
    }
  }
  const entry = [
    new URL('../../../apps/batond/src/platform/private-file-host-entry.ts', import.meta.url),
    new URL('../../../../../apps/batond/src/platform/private-file-host-entry.ts', import.meta.url),
  ].find((candidate) => existsSync(candidate))
  if (!entry) throw new Error('credential_private_file_failed')
  return {
    file: process.execPath,
    args: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, fileURLToPath(entry)],
    timeout: 5000,
  }
}

function native(operation: string, directory: string, file?: string, input?: string): string | undefined {
  const host = nativeHost()
  if (input !== undefined && Buffer.byteLength(input) > maximumCredentialBytes)
    throw new Error('credential_private_file_failed')
  const result = spawnSync(
    host.file,
    [...host.args, 'private-file', operation, resolve(directory), ...(file ? [resolve(file)] : [])],
    { input, encoding: 'utf8', windowsHide: true, timeout: host.timeout, maxBuffer: maximumCredentialBytes + 4096 },
  )
  if (result.error) throw new Error('credential_private_file_failed')
  if (result.status === 3 && operation === 'read') return undefined
  if (result.status !== 0 || Buffer.byteLength(result.stdout) > maximumCredentialBytes)
    throw new Error('credential_private_file_failed')
  return result.stdout
}

export const hostedCredentialFiles = {
  async protect(path: string, directory: boolean): Promise<void> {
    if (!directory) throw new Error('credential_use_native_write')
    native('protect-dir', path)
  },
  async read(path: string): Promise<string | undefined> {
    return native('read', dirname(path), path)
  },
  async write(path: string, input: string): Promise<void> {
    native('write', dirname(path), path, input)
  },
}
