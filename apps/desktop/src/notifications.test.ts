import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'
import { Schema } from 'effect'
import {
  notificationState,
  notificationPresenter,
  type NativeNotice,
  type NotificationTarget,
} from './notifications.ts'
import { EventEmitter } from 'node:events'
import { NotificationBatch, TrayActivity, authorizeBridge } from './bridge.ts'
import { desktopCapabilities } from './capabilities.ts'
import { trayPixels, traySummary } from './tray-model.ts'
import { windowsNotificationsDisabled, notificationSettingsURL } from './notification-permission.ts'

const notice: NativeNotice = {
  event_id: 'event-one',
  thread_id: 'thread-one',
  title: 'Review logs',
  body: 'Codex finished replying.',
}

it('通知持久去重，聚焦查看和关闭通知时也消费事件，计数继续独立更新', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-notifications-'))
  const shown: NativeNotice[] = []
  try {
    const state = await notificationState(directory, (event) => shown.push(event))
    expect(state.enabled()).toBe(true)
    expect(await state.cursor('employee')).toBeNull()
    await Promise.all([state.deliver('employee', [notice], '1', null), state.deliver('employee', [notice], '1', null)])
    expect(shown).toEqual([notice])
    const restored = await notificationState(directory, (event) => shown.push(event))
    expect(await restored.cursor('employee')).toBe('1')
    await restored.deliver('employee', [notice], '1', null)
    await restored.deliver('employee', [{ ...notice, event_id: 'focused' }], '2', notice.thread_id!)
    await restored.deliver('employee', [{ ...notice, event_id: 'focused' }], '2', null)
    expect(shown).toHaveLength(1)
    await restored.setEnabled(false)
    await restored.deliver('employee', [{ ...notice, event_id: 'off' }], '3', null)
    const disabled = await notificationState(directory, (event) => shown.push(event))
    expect(disabled.enabled()).toBe(false)
    expect(await disabled.cursor('employee')).toBe('3')
    await disabled.setEnabled(true)
    await disabled.deliver('employee', [{ ...notice, event_id: 'off' }], '3', null)
    await disabled.deliver(
      'employee',
      [{ ...notice, event_id: 'other-thread', thread_id: 'thread-two' }],
      '4',
      notice.thread_id!,
    )
    expect(shown).toHaveLength(2)
    expect(shown.at(-1)?.thread_id).toBe('thread-two')
    await disabled.deliver('other-employee', [notice], '1', null)
    expect(shown).toHaveLength(3)
    expect(JSON.parse(await readFile(join(directory, 'notifications.json'), 'utf8')).enabled).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('点击系统通知把对应对象交给窗口导航', () => {
  class Notice extends EventEmitter {
    show() {}
  }
  const delivered = new Notice()
  const targets: NotificationTarget[] = []
  const present = notificationPresenter(
    () => delivered,
    (target) => targets.push(target),
  )
  present(notice)
  expect(targets).toEqual([])
  delivered.emit('click')
  expect(targets).toEqual([{ thread_id: 'thread-one' }])
})

it('桥接声明可扩展的版本能力，来源和输入大小在主进程核查', () => {
  expect(desktopCapabilities).toEqual(
    expect.arrayContaining([
      { name: 'update', version: 1 },
      { name: 'notifications', version: 1 },
      { name: 'tray-status', version: 1 },
    ]),
  )
  for (const [url, main] of [
    ['https://other.test', true],
    ['https://center.test', false],
    ['file:///setup.html', true],
  ] as const)
    expect(() => authorizeBridge(url, 'https://center.test', main)).toThrow()
  expect(() => authorizeBridge('https://center.test/threads', 'https://center.test', true)).not.toThrow()
  expect(Schema.is(NotificationBatch)({ scope: 'employee', cursor: '1', events: [notice] })).toBe(true)
  expect(
    Schema.is(NotificationBatch)({ scope: 'employee', cursor: '1', events: [{ ...notice, body: 'x'.repeat(4097) }] }),
  ).toBe(false)
  expect(Schema.is(TrayActivity)({ running: -1, waiting: 0, threads: [] })).toBe(false)
  expect(Schema.is(TrayActivity)({ running: 2, waiting: 7, threads: Array(6).fill({ id: 'a', title: 'a' }) })).toBe(
    false,
  )
})

it('托盘按等待数加标记，菜单摘要使用员工全部 Thread 计数', () => {
  expect(traySummary({ running: 2, waiting: 7, threads: [] })).toBe('2 个运行中 · 7 个待处理')
  expect(trayPixels(true).equals(trayPixels(false))).toBe(false)
  expect(windowsNotificationsDisabled('Enabled    REG_DWORD    0x0')).toBe(true)
  expect(windowsNotificationsDisabled('ToastEnabled    REG_DWORD    0x0')).toBe(true)
  expect(windowsNotificationsDisabled('Enabled    REG_DWORD    0x1')).toBe(false)
  expect(notificationSettingsURL('darwin')).toMatch(/^x-apple.systempreferences:/)
  expect(notificationSettingsURL('win32')).toBe('ms-settings:notifications')
})
