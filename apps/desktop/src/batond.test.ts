import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { Batond, daemonLog, type Spawn } from './batond.ts'
import { fakeProcess } from './testing/process.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

it('凭据仅通过注册子进程环境传入，命令输出只返回公开身份', async () => {
  vi.stubEnv('BATON_ENROLLMENT_TOKEN', 'inherited-secret-must-be-removed')
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = []
  const identity = {
    registered: true,
    coordinator_url: 'https://center.test',
    node_id: 'node',
    display_name: 'Local',
    system: 'macos',
  }
  const batond = new Batond('/resources', '/data', (_file, args, options) => {
    calls.push({ args, env: options.env })
    const child = fakeProcess()
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ ...identity, credential: 'must-not-leak' })))
      child.emit('close', 0)
    })
    return child
  })
  expect(
    await batond.enroll(
      { format: 1, coordinator_url: 'https://center.test', ca_pem: 'test-ca' },
      '/user',
      'enrollment-secret',
      'Local',
    ),
  ).toEqual(identity)
  expect(calls[0]!.args).toEqual([
    'register',
    '--coordinator',
    'https://center.test',
    '--display-name',
    'Local',
    '--ca-file',
    join('/user', 'ca.pem'),
    '--data-dir',
    '/data',
  ])
  expect(calls[0]!.env?.BATON_ENROLLMENT_TOKEN).toBe('enrollment-secret')
  expect(calls[1]!.env?.BATON_ENROLLMENT_TOKEN).toBeUndefined()
  expect(JSON.stringify(calls.map((call) => call.args))).not.toContain('enrollment-secret')
  const daemon = batond.run()
  expect(calls[2]!.args).toEqual(['run', '--exit-with-stdin', '--data-dir', '/data'])
  expect(calls[2]!.env?.BATON_ENROLLMENT_TOKEN).toBeUndefined()
  daemon.stdin.end()
})

it('目录查询只传 Thread ID，返回公开身份与可信路径，并保留目录缺失提示', async () => {
  const saved = {
    node_id: '11111111-1111-4111-8111-111111111111',
    employee_id: '22222222-2222-4222-8222-222222222222',
    coordinator_url: 'https://center.test',
    working_directory: '/workspace',
  }
  let missing = false
  const spawn = vi.fn<Spawn>((_file, _args, _options) => {
    const child = fakeProcess()
    queueMicrotask(() => {
      if (missing)
        child.stderr.emit('data', Buffer.from(JSON.stringify({ code: 'directory_missing', message: 'private-detail' })))
      else child.stdout.emit('data', Buffer.from(JSON.stringify({ ...saved, credential: 'must-not-leak' })))
      child.emit('close', missing ? 1 : 0)
    })
    return child
  })
  const batond = new Batond('/resources', '/data', spawn)
  const id = '33333333-3333-4333-8333-333333333333'
  expect(await batond.directory(id)).toEqual(saved)
  expect(spawn.mock.calls[0]?.[1]).toEqual(['desktop-directory', '--thread-id', id, '--data-dir', '/data'])
  missing = true
  await expect(batond.directory(id)).rejects.toThrow('此文件夹已不存在。')
})

it('失败不向网页返回子进程原始输出或注册凭据', async () => {
  const batond = new Batond('/resources', '/data', () => {
    const child = fakeProcess()
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('{"code":"enrollment_expired","message":"enrollment-secret"}'))
      child.emit('close', 1)
    })
    return child
  })
  const error = await batond
    .reauth({ format: 1, coordinator_url: 'https://center.test' }, '/user', 'enrollment-secret')
    .catch((error: unknown) => error)
  expect(error).toMatchObject({ code: 'enrollment_expired' })
  expect(String(error)).not.toContain('enrollment-secret')
})

it('升级命令沿用原入口，迁移超过普通命令时限仍等待并保留原因', async () => {
  vi.useFakeTimers()
  const calls: string[][] = []
  const migration = fakeProcess()
  const kill = vi.spyOn(migration, 'kill')
  const snapshot = { state: null, blockers: [], pending_reports: 0 }
  const batond = new Batond('/resources', '/data', (_file, args) => {
    calls.push(args)
    if (args[1] === 'migrate') return migration
    const child = fakeProcess()
    void Promise.resolve().then(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify(snapshot)))
      child.emit('close', 0)
    })
    return child
  })
  await batond.prepareVersion('v1.2.3')
  await batond.prepareSelf('/new/resources/batond')
  const migrating = batond.migrate()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(kill).not.toHaveBeenCalled()
  migration.emit('close', 0)
  await expect(migrating).resolves.toEqual(snapshot)
  expect(calls).toContainEqual(['upgrade', 'prepare', '--version', 'v1.2.3', '--data-dir', '/data'])
  expect(calls).toContainEqual([
    'upgrade',
    'prepare',
    '--package',
    '/new/resources/batond',
    '--self',
    '--data-dir',
    '/data',
  ])

  const failed = new Batond('/resources', '/data', () => {
    const child = fakeProcess()
    void Promise.resolve().then(() => {
      child.stderr.emit(
        'data',
        Buffer.from('{"code":"upgrade_migration_failed","message":"thread.db: storage_version_unsupported"}'),
      )
      child.emit('close', 1)
    })
    return child
  })
  await expect(failed.migrate()).rejects.toThrow('thread.db: storage_version_unsupported')
})

it('运行日志超过 10MB 时只保留一份轮转文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-log-'))
  try {
    const failed = vi.fn()
    const log = daemonLog(directory, failed)
    log.write(Buffer.alloc(9 * 1024 * 1024, 'a'))
    log.write(Buffer.alloc(2 * 1024 * 1024, 'b'))
    await log.flush()
    const file = join(directory, 'logs', 'desktop-batond.log')
    expect((await stat(file + '.1')).size).toBe(9 * 1024 * 1024)
    expect((await readFile(file)).length).toBe(2 * 1024 * 1024)
    expect(failed).not.toHaveBeenCalled()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
