import { expect, it, vi } from 'vite-plus/test'
import { join } from 'node:path'
import { Batond, lastFailure, type Spawn } from './batond.ts'
import { fakeProcess } from './testing/process.ts'

it('失败不向网页返回子进程原始输出或凭据', async () => {
  const batond = new Batond('/resources', '/data', () => {
    const child = fakeProcess()
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('private-token\n{"code":"upgrade_failed","message":"升级失败"}'))
      child.emit('close', 1)
    })
    return child
  })
  const error = await batond.update().catch((error: unknown) => error)
  expect(error).toMatchObject({ code: 'upgrade_failed' })
  expect(String(error)).toContain('升级失败')
  expect(String(error)).not.toContain('private-token')
})

it('引导持久入口后通过同一入口查询更新', async () => {
  const calls: Array<{ file: string; args: string[] }> = []
  const launcher = join('/program', 'launcher', process.platform === 'win32' ? 'batond.exe' : 'batond')
  const prefix = ['dispatch', '--data-dir', '/data', '--']
  const batond = new Batond('/resources', '/data', (file, args) => {
    calls.push({ file, args })
    const child = fakeProcess()
    queueMicrotask(() => {
      const output =
        args[0] === 'update' && args[1] === 'bootstrap'
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

it('从标准输入传递模型连接密钥，不出现在命令行', async () => {
  let stdin = ''
  const spawn = vi.fn<Spawn>((_file, args) => {
    expect(args).toEqual(['project-runtime', 'connection-key', 'connection', '--data-dir', '/data'])
    const child = fakeProcess()
    child.stdin.on('data', (chunk: Buffer) => (stdin += chunk.toString()))
    child.stdin.on('finish', () => {
      child.emit('close', 0)
    })
    return child
  })
  await new Batond('/resources', '/data', spawn).setModelConnectionKey('connection', 'offline-secret')
  expect(stdin).toBe('offline-secret')
  expect(JSON.stringify(spawn.mock.calls)).not.toContain('offline-secret')
})

it('解析最后一行结构化错误，普通诊断输出返回空错误', () => {
  expect(lastFailure('{"code":"upgrade_failed","message":"失败"}')).toEqual({
    code: 'upgrade_failed',
    message: '失败',
  })
  expect(lastFailure('diagnostic line')).toEqual({})
})
