import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { NodeIdentity } from '@baton/protocol'
import { manageService, renderLaunchAgent, renderSystemdUnit, type ServiceRunner } from './service.ts'
import { acquireProcessLock } from '../platform/lock.ts'
import { loadEnvironment, updateEnvironment } from '../environment.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(platform: 'darwin' | 'linux') {
  const home = await mkdtemp(join(tmpdir(), 'baton-service-'))
  directories.push(home)
  const data = join(home, 'private data')
  await mkdir(data, { mode: 0o700 })
  const identity: NodeIdentity = {
    node_id: '729f92e9-e68c-4a30-817a-0adb2da87b51',
    employee_id: '74b66275-348c-4dd3-ae1d-7f3d21440f70',
    display_name: 'Offline node',
    system: platform === 'darwin' ? 'macos' : 'linux',
    role: '',
    capabilities: [],
    registration_seq: 1,
    registered_at: '2026-10-23T02:00:00Z',
    coordinator_url: 'https://localhost:1',
    credential: {
      id: 'c6559d72-c581-4f4d-bef0-3f80724d1856',
      token: 'offline-test-token',
      version: 1,
      expires_at: '2099-01-01T00:00:00Z',
    },
  }
  await writeFile(join(data, 'identity.json'), JSON.stringify(identity), { mode: 0o600 })
  const path =
    platform === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', 'dev.baton.batond.plist')
      : join(home, '.config', 'systemd', 'user', 'baton-batond.service')
  const runner = vi.fn<ServiceRunner>(async () => ({ code: 0, stdout: '', stderr: '' }))
  const options = {
    platform,
    homeDirectory: home,
    uid: 123,
    user: 'offline-user',
    env: { XDG_RUNTIME_DIR: join(home, 'runtime') },
    command: { executable: process.execPath, args: ['/installation/batond.cjs'] },
    runner,
  }
  return { home, data, path, runner, options }
}

async function statusFixture(platform: 'darwin' | 'linux') {
  const f = await fixture(platform)
  await manageService('install', f.data, f.options)
  f.runner.mockImplementation(async (file) => ({
    code: 0,
    stderr: '',
    stdout:
      file === 'plutil'
        ? JSON.stringify({ ProgramArguments: [process.execPath], StandardOutPath: join(f.data, 'logs', 'batond.log') })
        : file === 'loginctl'
          ? 'Linger=yes\n'
          : `state = running\nActiveState=active\nMainPID=${process.pid}\n`,
  }))
  return f
}

it.each(['darwin', 'linux'] as const)('preserves configured environment across %s reinstall', async (platform) => {
  const f = await fixture(platform)
  await manageService('install', f.data, { ...f.options, env: { ...f.options.env, PATH: '/first' } })
  await updateEnvironment(f.data, (config) => ({ ...config, scopes: { device: { PATH: '/custom' } } }))
  const before = await loadEnvironment(f.data)
  await manageService('install', f.data, { ...f.options, env: { ...f.options.env, PATH: '/second' } })
  const after = await loadEnvironment(f.data)
  expect(after).toEqual(before)
  expect(after.scopes.device?.PATH).toBe('/custom')
})

it.each(['darwin', 'linux'] as const)(
  'reports daemon states and rejection details from the installed %s data directory',
  async (platform) => {
    const f = await statusFixture(platform)
    const release = await acquireProcessLock(join(f.data, 'daemon.lock'))
    const path = join(f.data, 'daemon-status.json')
    try {
      for (const state of ['connecting', 'online', 'rejected', 'stopping']) {
        const daemon = {
          pid: process.pid,
          state,
          updated_at: '2026-10-28T00:00:00Z',
          ...(state === 'rejected' ? { code: 'node_version_incompatible', message: '请从中心下载新版客户端' } : {}),
        }
        await writeFile(path, JSON.stringify({ ...daemon, ignored: 'not public' }), { mode: 0o600 })
        expect(await manageService('status', '/unrelated-data', f.options)).toHaveProperty('daemon', {
          ...daemon,
          stale: false,
        })
      }
      const daemon = { pid: process.pid + 1, state: 'online', updated_at: '2026-10-28T00:00:00Z' }
      await writeFile(path, JSON.stringify(daemon))
      expect(await manageService('status', f.data, f.options)).toHaveProperty('daemon', { ...daemon, stale: true })
    } finally {
      await release()
    }
    const rejected = {
      pid: process.pid,
      state: 'rejected',
      code: 'needs_reauth',
      message: '设备需要重新认证',
      updated_at: '2026-10-28T00:00:00Z',
    }
    await writeFile(path, JSON.stringify(rejected))
    expect(await manageService('status', f.data, f.options)).toHaveProperty('daemon', { ...rejected, stale: true })
  },
)

it.each(['darwin', 'linux'] as const)('returns null for missing or corrupt %s daemon snapshots', async (platform) => {
  const f = await statusFixture(platform)
  expect(await manageService('status', f.data, f.options)).toHaveProperty('daemon', null)
  for (const content of [
    '{broken',
    '{}',
    JSON.stringify({ pid: '123', state: 'online', updated_at: '2026-10-28T00:00:00Z' }),
    JSON.stringify({ pid: 123, state: 'unknown', updated_at: '2026-10-28T00:00:00Z' }),
    JSON.stringify({ pid: 123, state: 'online', updated_at: 'invalid' }),
  ]) {
    await writeFile(join(f.data, 'daemon-status.json'), content, { mode: 0o600 })
    expect(await manageService('status', f.data, f.options)).toHaveProperty('daemon', null)
  }
})

it('renders launchd arguments, XML escaping, restart policy and combined logs', () => {
  const text = renderLaunchAgent({
    command: { executable: '/Baton & <node>', args: ['/app/batond.cjs'] },
    dataDirectory: '/data "one"',
  })
  expect(text).toContain('<key>Label</key><string>dev.baton.batond</string>')
  expect(text).toContain(
    '<string>/Baton &amp; &lt;node&gt;</string>\n      <string>/app/batond.cjs</string>\n      <string>run</string>\n      <string>--data-dir</string>\n      <string>/data &quot;one&quot;</string>',
  )
  expect(text).toContain('<key>RunAtLoad</key><true/>')
  expect(text).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>')
  expect(text).toContain('<key>ThrottleInterval</key><integer>30</integer>')
  for (const key of ['StandardOutPath', 'StandardErrorPath'])
    expect(text).toContain(`<key>${key}</key><string>${join('/data &quot;one&quot;', 'logs', 'batond.log')}</string>`)
})

it('renders systemd with literal paths, no shell expansion, exit 78 and append logs', () => {
  const text = renderSystemdUnit({
    command: { executable: '/bin/baton "new"', args: [] },
    dataDirectory: '/data %n $HOME\\one',
  })
  expect(text).toContain('ExecStart="/bin/baton \\"new\\"" "run" "--data-dir" "/data %%n $$HOME\\\\one"')
  expect(text).toContain('Restart=on-failure\nRestartSec=5\nRestartPreventExitStatus=78')
  const log = join('/data %%n $HOME\\one', 'logs', 'batond.log')
  expect(text).toContain(`StandardOutput=append:${log}`)
  expect(text).toContain(`StandardError=append:${log}`)
  expect(text).toContain('WantedBy=default.target')
})

it.each([renderLaunchAgent, renderSystemdUnit])('rejects line injection in service arguments', (render) => {
  expect(() =>
    render({ command: { executable: '/batond', args: [] }, dataDirectory: '/data\nExecStart=/other' }),
  ).toThrow('控制字符')
})

it.each(['darwin', 'linux'] as const)(
  'installs one %s service and replaces its executable and data directory',
  async (platform) => {
    const f = await fixture(platform)
    const link = join(f.home, 'batond-link')
    if (process.platform !== 'win32') await symlink(process.execPath, link)
    f.options.command = {
      executable: process.platform === 'win32' ? process.execPath : link,
      args: ['/first/batond.cjs'],
    }
    await expect(manageService('install', f.data, f.options)).resolves.toEqual({ installed: true })
    const original = await readFile(f.path, 'utf8')
    const executable = await realpath(process.execPath)
    expect(original).toContain(platform === 'linux' ? JSON.stringify(executable).slice(1, -1) : executable)
    expect(original).not.toContain('batond-link')
    const otherData = join(f.home, 'other-data')
    await mkdir(otherData, { mode: 0o700 })
    await writeFile(join(otherData, 'identity.json'), await readFile(join(f.data, 'identity.json')), { mode: 0o600 })
    f.options.command = { executable: process.execPath, args: ['/second/batond.cjs'] }
    await manageService('install', otherData, f.options)
    const replacement = await readFile(f.path, 'utf8')
    expect(replacement).toContain('/second/batond.cjs')
    expect(replacement).toContain(platform === 'linux' ? JSON.stringify(otherData).slice(1, -1) : otherData)
    expect(replacement).not.toContain('/first/batond.cjs')
    expect(replacement).not.toContain(f.data)
    expect(await readdir(dirname(f.path))).toEqual([basename(f.path)])
    expect(await readdir(join(otherData, 'logs'))).toEqual([])
  },
)

it.each([
  ['darwin', 'bootout'],
  ['darwin', 'bootstrap'],
  ['linux', 'daemon-reload'],
  ['linux', 'enable'],
  ['linux', 'restart'],
] as const)('rolls back first installation and replacement after %s %s failure', async (platform, failure) => {
  const f = await fixture(platform)
  for (const previous of [undefined, 'original service definition\n']) {
    if (previous !== undefined) {
      await mkdir(dirname(f.path), { recursive: true })
      await writeFile(f.path, previous)
    }
    let failed = false
    f.runner.mockImplementation(async (_file, args) => {
      if (!failed && args.includes(failure)) {
        failed = true
        expect(await readFile(f.path, 'utf8')).toContain('/installation/batond.cjs')
        return { code: 1, stdout: '', stderr: 'injected failure' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(manageService('install', f.data, f.options)).rejects.toMatchObject({
      code: 'service_unavailable',
      message: expect.stringContaining('injected failure'),
    })
    expect(failed).toBe(true)
    if (previous === undefined) await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(f.path, 'utf8')).toBe(previous)
    expect(await readdir(dirname(f.path))).toEqual(previous === undefined ? [] : [basename(f.path)])
  }
})

it.each(['darwin', 'linux'] as const)('uninstalls %s service while preserving identity and logs', async (platform) => {
  const f = await fixture(platform)
  await manageService('install', f.data, f.options)
  const log = join(f.data, 'logs', 'batond.log')
  await writeFile(log, 'saved log')
  const identity = await readFile(join(f.data, 'identity.json'), 'utf8')
  await expect(manageService('uninstall', f.data, f.options)).resolves.toEqual({ installed: false })
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(log, 'utf8')).toBe('saved log')
  expect(await readFile(join(f.data, 'identity.json'), 'utf8')).toBe(identity)
  await manageService('uninstall', f.data, f.options)
})

it('reports launchd state and paths from the installed definition, independent of --data-dir', async () => {
  const f = await fixture('darwin')
  await manageService('install', f.data, f.options)
  const definition = {
    ProgramArguments: [await realpath(process.execPath)],
    StandardOutPath: join(f.data, 'logs', 'batond.log'),
  }
  f.runner.mockImplementation(async (file, args) => ({
    code: 0,
    stderr: '',
    stdout:
      file === 'plutil'
        ? JSON.stringify(definition)
        : args.at(-1)?.endsWith('dev.baton.batond')
          ? '  state = running\n'
          : '',
  }))
  await expect(manageService('status', '/unrelated-data', f.options)).resolves.toEqual({
    installed: true,
    running: true,
    program_path: definition.ProgramArguments[0],
    log_path: definition.StandardOutPath,
    daemon: null,
  })
  f.runner.mockResolvedValue({ code: 113, stdout: '', stderr: 'not loaded' })
  f.runner.mockImplementationOnce(async () => ({ code: 0, stdout: '', stderr: '' }))
  f.runner.mockImplementationOnce(async () => ({ code: 113, stdout: '', stderr: 'not loaded' }))
  f.runner.mockImplementationOnce(async () => ({ code: 0, stdout: JSON.stringify(definition), stderr: '' }))
  await expect(manageService('status', f.data, f.options)).resolves.toMatchObject({ installed: true, running: false })
})

it.each(['yes', 'no', 'unknown'])('reports Linux activity, installed paths and linger=%s', async (linger) => {
  const f = await fixture('linux')
  await manageService('install', f.data, f.options)
  f.runner.mockImplementation(async (file) => ({
    code: 0,
    stderr: '',
    stdout: file === 'loginctl' ? `Linger=${linger}\n` : 'ActiveState=active\nMainPID=123\n',
  }))
  const status = await manageService('status', '/unrelated-data', f.options)
  expect(status).toMatchObject({
    installed: true,
    running: true,
    program_path: await realpath(process.execPath),
    log_path: join(f.data, 'logs', 'batond.log'),
    linger: linger === 'unknown' ? null : linger === 'yes',
  })
  if (linger === 'no') expect(status).toHaveProperty('message', expect.stringContaining('管理员'))
})

it('reports an absent service without registering or creating any files', async () => {
  const f = await fixture('darwin')
  f.runner.mockImplementation(async (_file, args) => ({
    code: args.at(-1)?.endsWith('dev.baton.batond') ? 113 : 0,
    stdout: '',
    stderr: '',
  }))
  await expect(manageService('status', f.data, f.options)).resolves.toEqual({
    installed: false,
    running: false,
    program_path: null,
    log_path: null,
    daemon: null,
  })
  expect(await readdir(f.home)).toEqual(['private data'])
})

it('reports a missing Linux unit and an unavailable linger query without creating a definition', async () => {
  const f = await fixture('linux')
  f.runner.mockImplementation(async (file, args) => {
    if (file === 'loginctl') throw new Error('loginctl not found')
    return { code: args.includes('show') ? 1 : 0, stdout: '', stderr: 'unit not found' }
  })
  await expect(manageService('status', f.data, f.options)).resolves.toMatchObject({
    installed: false,
    running: false,
    program_path: null,
    log_path: null,
    linger: null,
  })
  expect(await readdir(f.home)).toEqual(['private data'])
})

it('refuses unregistered devices, unsupported systems and unavailable user sessions without definitions', async () => {
  const f = await fixture('linux')
  await rm(join(f.data, 'identity.json'))
  await expect(manageService('install', f.data, f.options)).rejects.toMatchObject({
    code: 'service_not_registered',
    message: expect.stringContaining('batond register'),
  })
  await expect(manageService('install', f.data, { ...f.options, platform: 'win32' })).rejects.toMatchObject({
    code: 'service_unsupported',
    message: expect.stringContaining('桌面客户端'),
  })
  await expect(manageService('install', f.data, { ...f.options, platform: 'freebsd' })).rejects.toMatchObject({
    code: 'service_unavailable',
  })
  await expect(manageService('install', f.data, { ...f.options, env: {} })).rejects.toMatchObject({
    code: 'service_unavailable',
    message: expect.stringContaining('XDG_RUNTIME_DIR'),
  })
  f.runner.mockResolvedValue({ code: 1, stdout: '', stderr: 'user instance unavailable' })
  await expect(manageService('install', f.data, f.options)).rejects.toMatchObject({
    code: 'service_unavailable',
    message: expect.stringContaining('user instance unavailable'),
  })
  f.runner.mockRejectedValue(new Error('command not found'))
  await expect(manageService('install', f.data, f.options)).rejects.toMatchObject({ code: 'service_unavailable' })
  expect(await readdir(f.home)).toEqual(['private data'])
})
