import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { expect, it, vi } from 'vite-plus/test'
import { launchNSIS } from './update-install.ts'

it('以更新和静默参数启动 NSIS，确认启动后才交出旧进程', async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  const spawn = vi.fn(() => {
    queueMicrotask(() => child.emit('spawn'))
    return child as unknown as ChildProcess
  })
  await launchNSIS('C:\\cache\\baton.exe', spawn)
  expect(spawn).toHaveBeenCalledWith('C:\\cache\\baton.exe', ['--updated', '/S', '--force-run'])
  expect(child.unref).toHaveBeenCalledOnce()
})

it('安装进程无法启动时保留原客户端和可重试错误', async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  await expect(
    launchNSIS('/installer.exe', () => {
      queueMicrotask(() => child.emit('error', new Error('安装包无法执行')))
      return child as unknown as ChildProcess
    }),
  ).rejects.toThrow('安装包无法执行')
  expect(child.unref).not.toHaveBeenCalled()
})
