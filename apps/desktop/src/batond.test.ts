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
  expect(calls[2]!.env?.BATON_DESKTOP_MANAGED).toBe('1')
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

it('引导持久入口后通过同一入口运行和查询更新', async () => {
  const calls: Array<{ file: string; args: string[] }> = []
  const launcher = join('/data', 'installation', 'launcher', process.platform === 'win32' ? 'batond.exe' : 'batond')
  const prefix = ['dispatch', '--data-dir', '/data', '--']
  const batond = new Batond('/resources', '/data', (file, args) => {
    calls.push({ file, args })
    const child = fakeProcess()
    queueMicrotask(() => {
      const output =
        args[0] === 'update'
          ? { executable: launcher, args: prefix }
          : {
              state: {
                operation_id: 'operation',
                attempt: 1,
                phase: 'draining',
                source_version: 'v1',
                target_version: 'v2',
              },
            }
      child.stdout.emit('data', Buffer.from(JSON.stringify(output)))
      child.emit('close', 0)
    })
    return child
  })
  await batond.bootstrap()
  expect(await batond.updateStatus()).toMatchObject({ phase: 'draining', target_version: 'v2' })
  await batond.update()
  await batond.cancelUpdate()
  expect(calls[0]?.args).toEqual(['update', 'bootstrap', '--data-dir', '/data'])
  expect(calls.slice(1).map((call) => call.file)).toEqual([launcher, launcher, launcher, launcher])
  expect(calls[1]?.args).toEqual([
    ...prefix,
    'env',
    'init',
    ...(process.platform === 'win32' ? [] : ['--shell']),
    '--data-dir',
    '/data',
  ])
  expect(calls[2]?.args).toEqual([...prefix, 'update', 'status', '--data-dir', '/data'])
  expect(calls[3]?.args).toEqual([...prefix, 'update', '--data-dir', '/data'])
  expect(calls[4]?.args).toEqual([...prefix, 'update', 'cancel', '--data-dir', '/data'])
})

it('通过设备命令读取并保存更新策略', async () => {
  const calls: string[][] = []
  const batond = new Batond('/resources', '/data', (_file, args) => {
    calls.push(args)
    const child = fakeProcess()
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ policy: args.includes('idle') ? 'idle' : 'manual' })))
      child.emit('close', 0)
    })
    return child
  })
  expect(await batond.updatePolicy()).toBe('manual')
  expect(await batond.updatePolicy('idle')).toBe('idle')
  expect(calls).toEqual([
    ['update', 'policy', '--data-dir', '/data'],
    ['update', 'policy', 'idle', '--data-dir', '/data'],
  ])
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
