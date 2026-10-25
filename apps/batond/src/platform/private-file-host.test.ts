import { link, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vite-plus/test'
import { ensurePrivateDirectory, protectPrivateDirectory } from './private.ts'
import { privateFileHostEnvironment, runPrivateFileHost } from './private-file-host.ts'

const directories: string[] = []
async function directory() {
  const path = await makePrivateTempDirectory('baton-private-host-')
  directories.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function* input(text: string) {
  yield Buffer.from(text)
}

it('distinguishes explicit directory protection from private path validation', async () => {
  const root = await directory(),
    path = join(root, 'credentials')
  await mkdir(path, { mode: 0o755 })
  if (process.platform !== 'win32') await expect(ensurePrivateDirectory(path)).rejects.toThrow('permissions')
  expect(await runPrivateFileHost(['sidecar-file', 'protect-dir', path])).toBe(0)
  await ensurePrivateDirectory(path)
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o700)
  const alias = join(root, 'alias')
  await symlink(path, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(protectPrivateDirectory(alias)).rejects.toThrow('type')
})

it('dispatches structured source-host argv with no Go executable or shell parsing', async () => {
  const path = await directory(),
    file = join(path, 'xai.json')
  const environment = privateFileHostEnvironment(
    new URL('../../../../runtimes/project-agent/src/cli.ts', import.meta.url),
  )
  const command = JSON.parse(environment.BATON_SIDECAR_HOST_COMMAND!) as { file: string; args: string[] }
  expect(new URL(command.args[1]).protocol).toBe('file:')
  const result = spawnSync(command.file, [...command.args, 'sidecar-file', 'write', path, file], {
    input: '{"type":"oauth"}',
    encoding: 'utf8',
    timeout: 5000,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(await readFile(file, 'utf8')).toBe('{"type":"oauth"}')
  const missing = spawnSync(command.file, [...command.args, 'sidecar-file', 'read', path, join(path, 'missing.json')], {
    encoding: 'utf8',
    timeout: 5000,
  })
  expect(missing.status).toBe(3)
  expect(missing.stdout).toBe('')
})

it('rejects oversized or nonprivate files and paths outside the credential directory without returning content', async () => {
  const root = await directory(),
    path = join(root, 'credentials'),
    file = join(path, 'xai.json')
  expect(await runPrivateFileHost(['sidecar-file', 'protect-dir', path])).toBe(0)
  let output = ''
  const collect = (bytes: Uint8Array) => {
    output += Buffer.from(bytes).toString('utf8')
  }
  expect(await runPrivateFileHost(['sidecar-file', 'write', path, join(root, 'outside.json')], input('outside'))).toBe(
    1,
  )
  expect(await runPrivateFileHost(['sidecar-file', 'write', path, file], input('x'.repeat(65537)))).toBe(1)
  expect(await runPrivateFileHost(['sidecar-file', 'read', path, file], input(''), collect)).toBe(3)
  await writeFile(file, 'x'.repeat(65537), { mode: 0o600 })
  expect(await runPrivateFileHost(['sidecar-file', 'read', path, file], input(''), collect)).toBe(1)
  expect(output).toBe('')
  await rm(file)
  const outside = join(root, 'outside.json')
  await writeFile(outside, 'local-private-value', { mode: 0o600 })
  if (process.platform !== 'win32') {
    // File symlinks need Windows developer mode; first-version Windows security validates the parent ACL.
    await symlink(outside, file)
    expect(await runPrivateFileHost(['sidecar-file', 'read', path, file], input(''), collect)).toBe(1)
    expect(await runPrivateFileHost(['sidecar-file', 'write', path, file], input('replacement'))).toBe(1)
    expect(await readFile(outside, 'utf8')).toBe('local-private-value')
    await rm(file)
    await link(outside, file)
    expect(await runPrivateFileHost(['sidecar-file', 'read', path, file], input(''), collect)).toBe(1)
    await rm(file)
    await writeFile(file, 'local-private-value', { mode: 0o644 })
    expect(await runPrivateFileHost(['sidecar-file', 'read', path, file], input(''), collect)).toBe(1)
  }
  expect(output).toBe('')
})
