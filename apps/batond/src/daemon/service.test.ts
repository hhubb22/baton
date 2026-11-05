import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { NodeIdentity } from '@baton/protocol'
import {
  isUserServiceInstalled,
  manageService,
  renderLaunchAgent,
  renderSystemdUnit,
  type ServiceRunner,
} from './service.ts'
import { acquireProcessLock, processLockIsHeld } from '../platform/lock.ts'
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
    },
  }
  await writeFile(join(data, 'identity.json'), JSON.stringify(identity), { mode: 0o600 })
  const path =
    platform === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', 'dev.baton.batond.plist')
      : join(home, '.config', 'systemd', 'user', 'baton-batond.service')
  const runner = vi.fn<ServiceRunner>(async (file, args) => ({
    code: file === 'launchctl' && args[0] === 'print' && args[1]?.endsWith('/dev.baton.batond') ? 113 : 0,
    stdout: '',
    stderr: '',
  }))
  const options = {
    platform,
    homeDirectory: home,
    uid: 123,
    user: 'offline-user',
    env: { XDG_RUNTIME_DIR: join(home, 'runtime') },
    command: { executable: process.execPath, args: ['/installation/batond.cjs'] },
    runner,
    controlClient: () => ({ request: async () => ({ ok: true }), ensureDaemon: async () => {} }),
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
      for (const state of ['unbound', 'authorizing', 'connecting', 'syncing', 'online', 'rejected', 'stopping']) {
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
      code: 'credential_revoked',
      message: '设备连接凭据已吊销',
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
  expect(text).toContain('<key>KeepAlive</key><true/>')
  expect(text).toContain('<key>ThrottleInterval</key><integer>10</integer>')
  for (const key of ['StandardOutPath', 'StandardErrorPath'])
    expect(text).toContain(`<key>${key}</key><string>${join('/data &quot;one&quot;', 'logs', 'batond.log')}</string>`)
})

it('renders systemd with literal paths, no shell expansion, restart policy and append logs', () => {
  const text = renderSystemdUnit({
    command: { executable: '/bin/baton "new"', args: [] },
    dataDirectory: '/data %n $HOME\\one',
  })
  expect(text).toContain('ExecStart="/bin/baton \\"new\\"" "run" "--data-dir" "/data %%n $$HOME\\\\one"')
  expect(text).toContain('Restart=always\nRestartSec=5')
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
    await expect(isUserServiceInstalled(otherData, f.options)).resolves.toBe(true)
    await expect(isUserServiceInstalled(f.data, f.options)).resolves.toBe(false)
    expect(await readdir(dirname(f.path))).toEqual([basename(f.path)])
    expect(await readdir(join(otherData, 'logs'))).toEqual([])
  },
)

it.each([
  ['darwin', 'bootstrap'],
  ['linux', 'daemon-reload'],
  ['linux', 'enable'],
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

it.each(['darwin', 'linux'] as const)('installs the %s service before device login', async (platform) => {
  const f = await fixture(platform)
  await rm(join(f.data, 'identity.json'))
  await expect(manageService('install', f.data, f.options)).resolves.toEqual({ installed: true })
  await expect(readFile(join(f.data, 'identity.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['darwin', 'linux'] as const)(
  'shuts down a detached daemon and waits for its lock before installing the %s service',
  async (platform) => {
    const f = await fixture(platform)
    const release = await acquireProcessLock(join(f.data, 'daemon.lock'))
    let pendingRelease: Promise<void> | undefined
    const client = {
      request: vi.fn(async (request: { method: 'shutdown' | 'status' }) => {
        if (request.method === 'status') return { ok: true }
        await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
        pendingRelease = delay(30).then(release)
        return { ok: true }
      }),
      ensureDaemon: vi.fn(async () => {}),
    }
    const originalRunner = f.options.runner
    f.options.runner = vi.fn(async (file, args) => {
      if (args.includes('bootstrap') || args.includes('enable')) {
        expect(await processLockIsHeld(join(f.data, 'daemon.lock'))).toBe(false)
        expect(await processLockIsHeld(join(f.data, 'autostart.lock'))).toBe(true)
      }
      return originalRunner(file, args)
    })
    try {
      await expect(manageService('install', f.data, { ...f.options, controlClient: () => client })).resolves.toEqual({
        installed: true,
      })
      expect(client.request).toHaveBeenCalledWith({ method: 'shutdown' }, { autostart: false, timeoutMs: 30_000 })
      expect(client.ensureDaemon).not.toHaveBeenCalled()
      expect(await processLockIsHeld(join(f.data, 'autostart.lock'))).toBe(false)
    } finally {
      await pendingRelease
      await release()
    }
  },
)

it('leaves no definition when a detached daemon refuses shutdown or retains its lock', async () => {
  const f = await fixture('linux')
  const release = await acquireProcessLock(join(f.data, 'daemon.lock'))
  try {
    for (const response of [{ ok: false, message: 'worker shutdown failed' }, { ok: true }]) {
      const client = {
        request: vi.fn(async () => response),
        ensureDaemon: vi.fn(async () => {}),
      }
      await expect(
        manageService('install', f.data, {
          ...f.options,
          controlClient: () => client,
          shutdownTimeoutMs: 1,
        }),
      ).rejects.toMatchObject({ code: 'service_unavailable' })
      await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await processLockIsHeld(join(f.data, 'daemon.lock'))).toBe(true)
      expect(await processLockIsHeld(join(f.data, 'autostart.lock'))).toBe(false)
      expect(client.ensureDaemon).not.toHaveBeenCalled()
    }
    expect(f.runner.mock.calls.some(([, args]) => args.includes('enable'))).toBe(false)
  } finally {
    await release()
  }
})

it('restores a stopped detached daemon when service activation fails', async () => {
  const f = await fixture('linux')
  const release = await acquireProcessLock(join(f.data, 'daemon.lock'))
  const client = {
    request: vi.fn(async () => {
      await release()
      return { ok: true }
    }),
    ensureDaemon: vi.fn(async () => {
      const unlock = await acquireProcessLock(join(f.data, 'autostart.lock'))
      await unlock()
    }),
  }
  let failed = false
  f.runner.mockImplementation(async (_file, args) => {
    if (args.includes('enable') && !failed) {
      failed = true
      return { code: 1, stdout: '', stderr: 'cannot activate service' }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
  try {
    await expect(manageService('install', f.data, { ...f.options, controlClient: () => client })).rejects.toMatchObject(
      { code: 'service_unavailable', message: expect.stringContaining('cannot activate service') },
    )
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(client.ensureDaemon).toHaveBeenCalledOnce()
  } finally {
    await release()
  }
})

it('holds the autostart lock until a service has published its control channel', async () => {
  const f = await fixture('linux')
  let published = false
  let releaseDaemon: (() => Promise<void>) | undefined
  let publication: Promise<void> | undefined
  let markActivated: (() => void) | undefined
  const activated = new Promise<void>((resolve) => {
    markActivated = resolve
  })
  const client = {
    request: vi.fn(async () => {
      if (!published) throw new Error('control not ready')
      return { ok: true }
    }),
    ensureDaemon: vi.fn(async () => {}),
  }
  f.runner.mockImplementation(async (_file, args) => {
    if (args.includes('enable')) {
      markActivated?.()
      publication = delay(50).then(async () => {
        expect(await processLockIsHeld(join(f.data, 'autostart.lock'))).toBe(true)
        releaseDaemon = await acquireProcessLock(join(f.data, 'daemon.lock'))
        published = true
      })
    }
    return { code: 0, stdout: '', stderr: '' }
  })
  const installed = manageService('install', f.data, { ...f.options, controlClient: () => client })
  try {
    await activated
    expect(await processLockIsHeld(join(f.data, 'daemon.lock'))).toBe(false)
    expect(await processLockIsHeld(join(f.data, 'autostart.lock'))).toBe(true)
    await expect(installed).resolves.toEqual({ installed: true })
    expect(published).toBe(true)
    expect(await processLockIsHeld(join(f.data, 'autostart.lock'))).toBe(false)
    expect(client.request).toHaveBeenCalledWith(
      { method: 'status' },
      { autostart: false, timeoutMs: expect.any(Number) },
    )
    expect(client.ensureDaemon).not.toHaveBeenCalled()
  } finally {
    await publication
    await installed.catch(() => {})
    await releaseDaemon?.()
  }
})

it('rolls back the definition when the installed service never becomes ready', async () => {
  const f = await fixture('linux')
  const client = {
    request: vi.fn(async () => ({ ok: false, message: 'startup failed' })),
    ensureDaemon: vi.fn(async () => {}),
  }
  await expect(
    manageService('install', f.data, { ...f.options, controlClient: () => client, readyTimeoutMs: 1 }),
  ).rejects.toMatchObject({ code: 'service_unavailable', message: expect.stringContaining('startup failed') })
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await processLockIsHeld(join(f.data, 'autostart.lock'))).toBe(false)
  expect(client.ensureDaemon).not.toHaveBeenCalled()
})

it.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])(
  'restores existing systemd enabled=%s active=%s behavior after activation failure',
  async (wasEnabled, wasActive) => {
    const f = await fixture('linux')
    const original = 'previous unit definition\n'
    await mkdir(dirname(f.path), { recursive: true })
    await writeFile(f.path, original)
    let enabled = wasEnabled
    let active = wasActive
    let failed = false
    const release = wasActive ? await acquireProcessLock(join(f.data, 'daemon.lock')) : undefined
    const client = { request: vi.fn(async () => ({ ok: true })), ensureDaemon: vi.fn(async () => {}) }
    f.runner.mockImplementation(async (_file, args) => {
      if (args.includes('show'))
        return {
          code: 0,
          stderr: '',
          stdout: `ActiveState=${active ? 'active' : 'inactive'}\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\n`,
        }
      if (args.includes('stop') || args.includes('--now')) {
        active = args.includes('enable')
        await release?.()
      }
      if (args.includes('enable')) enabled = true
      if (args.includes('disable')) enabled = false
      if (args.includes('start')) active = true
      if (args.includes('enable') && args.includes('--now') && !failed) {
        failed = true
        return { code: 1, stdout: '', stderr: 'injected activation failure' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    try {
      await expect(
        manageService('install', f.data, { ...f.options, controlClient: () => client }),
      ).rejects.toMatchObject({ code: 'service_unavailable' })
      expect(await readFile(f.path, 'utf8')).toBe(original)
      expect({ enabled, active }).toEqual({ enabled: wasEnabled, active: wasActive })
      expect(client.request).not.toHaveBeenCalledWith({ method: 'shutdown' }, expect.anything())
      expect(client.ensureDaemon).not.toHaveBeenCalled()
    } finally {
      await release?.()
    }
  },
)

it.each([true, false])('restores existing launchd loaded=%s behavior after bootstrap failure', async (wasLoaded) => {
  const f = await fixture('darwin')
  const original = 'previous launch agent\n'
  await mkdir(dirname(f.path), { recursive: true })
  await writeFile(f.path, original)
  let loaded = wasLoaded
  let failed = false
  f.runner.mockImplementation(async (_file, args) => {
    if (args[0] === 'print' && args[1]?.endsWith('/dev.baton.batond'))
      return { code: loaded ? 0 : 113, stdout: '', stderr: '' }
    if (args[0] === 'bootout') loaded = false
    if (args[0] === 'bootstrap') {
      loaded = true
      if (!failed) {
        failed = true
        return { code: 1, stdout: '', stderr: 'injected bootstrap failure' }
      }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
  await expect(manageService('install', f.data, f.options)).rejects.toMatchObject({ code: 'service_unavailable' })
  expect(await readFile(f.path, 'utf8')).toBe(original)
  expect(loaded).toBe(wasLoaded)
})

it('refuses unsupported systems and unavailable user sessions without definitions', async () => {
  const f = await fixture('linux')
  await rm(join(f.data, 'identity.json'))
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
