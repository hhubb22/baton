import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { releaseMetadata } from '@baton/protocol/release'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { writeUpgradePackage } from '../testing/upgrade.ts'
import { ensurePrivateDirectory } from '../platform/files.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { backupRoot, defaultCredentialsDirectory, defaultDataDirectory, programRoot } from '../platform/layout.ts'

vi.mock('./service.ts', () => ({
  manageService: vi.fn(async () => {
    throw new Error('当前系统没有服务')
  }),
}))

const { diagnoseInstallation, shimPath, uninstallBatond, writeShim } = await import('./install.ts')
const { dataEntries } = await import('./upgrade-backup.ts')
const { installationPaths, pruneInstalledVersions } = await import('./update-install.ts')

const posixOnly = process.platform === 'win32' ? it.skip : it
const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

let home: string
beforeEach(async () => {
  home = await makePrivateTempDirectory('baton-home-')
  vi.stubEnv('HOME', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

async function defaultInstall() {
  const data = defaultDataDirectory()
  await mkdir(data, { recursive: true, mode: 0o700 })
  await writeFile(join(data, 'identity.json'), '{}')
  await mkdir(join(programRoot(data), 'versions', 'a'.repeat(64)), { recursive: true })
  await mkdir(backupRoot(data), { recursive: true })
  return data
}

posixOnly('默认目录把程序和备份放在数据目录旁边，指定目录保持自包含', () => {
  const data = defaultDataDirectory()
  expect(data).toBe(join(home, '.baton', 'data'))
  expect(programRoot(data)).toBe(join(home, '.baton', 'program'))
  expect(backupRoot(data)).toBe(join(home, '.baton', 'backups'))
  expect(defaultCredentialsDirectory()).toBe(join(data, 'credentials'))
  expect(programRoot('/srv/node')).toBe(join('/srv/node', 'installation'))
  expect(backupRoot('/srv/node')).toBe(join('/srv', 'node.upgrade-backups'))
})

posixOnly('首次使用时能建立默认数据目录，其他路径的上级缺失仍然报错', async () => {
  await ensurePrivateDirectory(defaultDataDirectory())
  expect((await lstat(defaultDataDirectory())).mode & 0o777).toBe(0o700)
  await expect(ensurePrivateDirectory(join(home, 'missing', 'data'))).rejects.toThrow()
})

posixOnly('命令入口转发到启动器，且不覆盖同名的其他程序', async () => {
  const launcher = join(home, "it's", 'batond')
  const entry = shimPath()
  await writeShim(entry, launcher)
  expect(await readFile(entry, 'utf8')).toContain(`exec '${home}/it'\\''s/batond' "$@"`)
  await writeShim(entry, join(home, 'next'))
  expect(await readFile(entry, 'utf8')).toContain('next')
  await writeFile(entry, '#!/bin/sh\necho other\n')
  await expect(writeShim(entry, launcher)).rejects.toThrow('已是其他程序')
  expect(await readFile(entry, 'utf8')).toContain('echo other')
})

posixOnly('卸载默认保留数据和备份，只删除程序和自己的入口', async () => {
  const data = await defaultInstall()
  await writeShim(shimPath(), join(programRoot(data), 'launcher', 'batond'))
  await uninstallBatond(data, { purge: false })
  expect(await present(programRoot(data))).toBe(false)
  expect(await present(shimPath())).toBe(false)
  expect(await present(join(data, 'identity.json'))).toBe(true)
  expect(await present(backupRoot(data))).toBe(true)
})

posixOnly('卸载不删除别的程序占用的入口', async () => {
  const data = await defaultInstall()
  await mkdir(join(home, '.local', 'bin'), { recursive: true })
  await writeFile(shimPath(), '#!/bin/sh\necho other\n')
  await uninstallBatond(data, { purge: false })
  expect(await present(shimPath())).toBe(true)
})

posixOnly('彻底卸载删除整个默认目录', async () => {
  const data = await defaultInstall()
  await uninstallBatond(data, { purge: true })
  expect(await present(join(home, '.baton'))).toBe(false)
})

posixOnly('彻底卸载拒绝删除不像 Baton 数据的指定目录', async () => {
  const other = join(home, 'documents')
  await mkdir(other)
  await writeFile(join(other, 'notes.txt'), 'keep')
  await expect(uninstallBatond(other, { purge: true })).rejects.toThrow('不像 Baton 数据目录')
  expect(await readFile(join(other, 'notes.txt'), 'utf8')).toBe('keep')
})

posixOnly('诊断指出多余版本和旧目录，服务不可用时照常输出', async () => {
  const data = await defaultInstall()
  for (const id of ['b', 'c']) await mkdir(join(programRoot(data), 'versions', id.repeat(64)))
  await mkdir(join(home, '.baton-ts'))
  const report = await diagnoseInstallation(data)
  expect(report).toMatchObject({
    data_directory: data,
    program_directory: programRoot(data),
    versions: 3,
    service: null,
  })
  expect(report.warnings.join('\n')).toContain('保留了 3 个版本')
  expect(report.warnings.join('\n')).toContain(join(home, '.baton-ts'))
})

posixOnly('更新完成后只保留当前版本、启动器版本和上一版', async () => {
  const data = await makePrivateTempDirectory('baton-prune-')
  try {
    const paths = installationPaths(data)
    await mkdir(paths.versions, { recursive: true, mode: 0o700 })
    await chmod(paths.root, 0o700)
    const [current, launcher, previous, stale] = ['a', 'b', 'c', 'd'].map((id) => id.repeat(64))
    for (const id of [current!, launcher!, previous!, stale!]) await writeUpgradePackage(join(paths.versions, id))
    const pointer = (directory: string) => JSON.stringify({ directory, release: releaseMetadata() })
    await writePrivateFileAtomic(paths.current, pointer(current!))
    await writePrivateFileAtomic(paths.launcherCurrent, pointer(launcher!))
    await writeFile(join(paths.root, 'launcher-previous-old.json'), '{}')
    await writeFile(join(paths.root, 'launcher-previous-now.json'), '{}')
    await pruneInstalledVersions(data, previous, 'now')
    expect((await readdir(paths.versions)).toSorted()).toEqual([current, launcher, previous])
    expect(await present(join(paths.root, 'launcher-previous-old.json'))).toBe(false)
    expect(await present(join(paths.root, 'launcher-previous-now.json'))).toBe(true)
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})

posixOnly('升级备份跳过会自行刷新的订阅凭据', async () => {
  const data = await makePrivateTempDirectory('baton-entries-')
  try {
    await mkdir(join(data, 'credentials'), { mode: 0o700 })
    await writeFile(join(data, 'credentials', 'openai-codex.json'), '{}', { mode: 0o600 })
    await writeFile(join(data, 'identity.json'), '{}', { mode: 0o600 })
    const paths = (await dataEntries(data)).map((entry) => entry.path)
    expect(paths).toContain('identity.json')
    expect(paths.filter((path) => path.startsWith('credentials'))).toEqual([])
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})
