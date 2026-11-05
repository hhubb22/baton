import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { ensurePrivateDirectory } from '../platform/files.ts'
import { defaultCredentialsDirectory, defaultDataDirectory, programRoot } from '../platform/layout.ts'
import { acquireProcessLock } from '../platform/lock.ts'

const state = vi.hoisted(() => ({
  serviceInstalled: true,
  reload: vi.fn(),
  uninstall: vi.fn(),
  onShutdown: async () => {},
}))
vi.mock('./service.ts', () => ({
  isUserServiceInstalled: vi.fn(async () => state.serviceInstalled),
  manageService: vi.fn(async (action: string) =>
    action === 'install'
      ? state.reload()
      : action === 'status'
        ? {
            installed: true,
            running: false,
            program_path: join(defaultDataDirectory(), 'batond'),
            log_path: join(defaultDataDirectory(), 'logs', 'batond.log'),
          }
        : state.uninstall(),
  ),
}))
vi.mock('./control-client.ts', () => ({
  ControlClient: class {
    async shutdown() {
      await state.onShutdown()
      return { ok: true }
    }
  },
}))

const { diagnoseInstallation, installBatond, shimPath, uninstallBatond, writeShim } = await import('./install.ts')

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
  state.serviceInstalled = true
  state.reload.mockClear()
  state.uninstall.mockClear()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

async function sourcePackage() {
  const source = await makePrivateTempDirectory('baton-package-')
  await writeFile(join(source, 'batond'), '#!/bin/sh\necho batond\n', { mode: 0o755 })
  await mkdir(join(source, 'node_modules', 'native'), { recursive: true })
  await writeFile(join(source, 'node_modules', 'native', 'binding.node'), 'binary')
  return source
}

async function installed() {
  const data = defaultDataDirectory()
  await mkdir(data, { recursive: true, mode: 0o700 })
  await writeFile(join(data, 'identity.json'), '{}')
  await mkdir(programRoot(data), { recursive: true })
  await writeFile(join(programRoot(data), 'batond'), '#!/bin/sh\necho old\n')
  return data
}

posixOnly('默认目录把程序放在数据目录旁边，指定目录保持自包含', () => {
  const data = defaultDataDirectory()
  expect(data).toBe(join(home, '.baton', 'data'))
  expect(programRoot(data)).toBe(join(home, '.baton', 'program'))
  expect(defaultCredentialsDirectory()).toBe(join(data, 'credentials'))
  expect(programRoot('/srv/node')).toBe(join('/srv/node', 'installation'))
})

posixOnly('首次使用时能建立默认数据目录，其他路径的上级缺失仍然报错', async () => {
  await ensurePrivateDirectory(defaultDataDirectory())
  expect((await lstat(defaultDataDirectory())).mode & 0o777).toBe(0o700)
  await expect(ensurePrivateDirectory(join(home, 'missing', 'data'))).rejects.toThrow()
})

posixOnly('命令入口转发到安装后的程序，且不覆盖同名的其他程序', async () => {
  const entry = shimPath()
  const launcher = join(home, "it's", 'batond')
  await writeShim(entry, launcher)
  expect(await readFile(entry, 'utf8')).toContain(`exec '${home}/it'\\''s/batond' "$@"`)
  await writeShim(entry, join(home, 'next'))
  expect(await readFile(entry, 'utf8')).toContain('next')
  await writeFile(entry, '#!/bin/sh\necho other\n')
  await expect(writeShim(entry, launcher)).rejects.toThrow('已是其他程序')
  expect(await readFile(entry, 'utf8')).toContain('echo other')
})

posixOnly('安装前停止运行中的守护进程，替换程序目录并重载已安装服务', async () => {
  const source = await sourcePackage()
  const data = defaultDataDirectory()
  await mkdir(data, { recursive: true, mode: 0o700 })
  const release = await acquireProcessLock(join(data, 'daemon.lock'))
  state.onShutdown = async () => {
    await release()
  }
  try {
    const result = await installBatond(data, source)
    expect(result).toMatchObject({ installed: true, replaced: true, data_directory: data })
    expect(await readFile(join(programRoot(data), 'batond'), 'utf8')).toContain('echo batond')
    expect(await present(join(programRoot(data), 'node_modules', 'native', 'binding.node'))).toBe(true)
    expect(await readFile(shimPath(), 'utf8')).toContain(join(programRoot(data), 'batond'))
    expect(state.reload).toHaveBeenCalledOnce()
  } finally {
    await rm(source, { recursive: true, force: true })
  }
})

posixOnly('未安装服务时不重载服务', async () => {
  const source = await sourcePackage()
  const data = defaultDataDirectory()
  state.serviceInstalled = false
  try {
    await installBatond(data, source)
    expect(state.reload).not.toHaveBeenCalled()
  } finally {
    await rm(source, { recursive: true, force: true })
  }
})

posixOnly('卸载默认保留数据，只删除程序和自己的入口', async () => {
  const data = await installed()
  await writeShim(shimPath(), join(programRoot(data), 'batond'))
  await uninstallBatond(data, { purge: false })
  expect(await present(programRoot(data))).toBe(false)
  expect(await present(shimPath())).toBe(false)
  expect(await present(join(data, 'identity.json'))).toBe(true)
  expect(state.uninstall).toHaveBeenCalledOnce()
})

posixOnly('卸载不删除别的程序占用的入口', async () => {
  const data = await installed()
  await mkdir(join(home, '.local', 'bin'), { recursive: true })
  await writeFile(shimPath(), '#!/bin/sh\necho other\n')
  await uninstallBatond(data, { purge: false })
  expect(await present(shimPath())).toBe(true)
})

posixOnly('彻底卸载删除整个默认目录', async () => {
  const data = await installed()
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

posixOnly('诊断报告程序位置和服务状态', async () => {
  const data = await installed()
  const report = await diagnoseInstallation(data)
  expect(report).toMatchObject({
    data_directory: data,
    program_directory: programRoot(data),
    installed: true,
    service: { installed: true },
  })
  expect(report.warnings).toEqual([])
})
