import { expect, it, vi } from 'vite-plus/test'
import { join } from 'node:path'
import { Batond, lastFailure, type Spawn } from './batond.ts'
import { fakeProcess } from './testing/process.ts'

it('失败不向网页返回子进程原始输出或凭据', async () => {
  const batond = new Batond('/resources', '/data', () => {
    const child = fakeProcess()
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('private-token\n{"code":"update_failed","message":"更新失败"}'))
      child.emit('close', 1)
    })
    return child
  })
  const error = await batond.bootstrap().catch((error: unknown) => error)
  expect(error).toMatchObject({ code: 'update_failed' })
  expect(String(error)).toContain('batond 操作失败')
  expect(String(error)).not.toContain('private-token')
  expect(String(error)).not.toContain('更新失败')
})

it('直接使用随客户端附带的 batond 初始化环境', async () => {
  const calls: Array<{ file: string; args: string[] }> = []
  const batond = new Batond('/resources', '/data', (file, args) => {
    calls.push({ file, args })
    const child = fakeProcess()
    queueMicrotask(() => child.emit('close', 0))
    return child
  })
  await batond.bootstrap()
  expect(calls).toEqual([
    {
      file: join('/resources', 'batond', process.platform === 'win32' ? 'batond.exe' : 'batond'),
      args: ['env', 'init', ...(process.platform === 'win32' ? [] : ['--shell']), '--data-dir', '/data'],
    },
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
  expect(lastFailure('{"code":"update_failed","message":"失败"}')).toEqual({
    code: 'update_failed',
    message: '失败',
  })
  expect(lastFailure('diagnostic line')).toEqual({})
})
