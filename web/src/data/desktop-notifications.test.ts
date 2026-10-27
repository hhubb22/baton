import type { BrowserNotification } from '@baton/protocol'
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { ChangeEvent, NotificationReplay } from './client'
import { desktopBridge, desktopCapability } from './desktop'
import { desktopActivity, notificationScope, relayDesktopNotifications } from './desktop-notifications'
import { createMockClient } from './mock/client'
import { createDesktopBridge } from '../test/desktop'

const event = (cursor: string): BrowserNotification => ({
  type: 'notification',
  event_id: `00000000-0000-4000-8000-${cursor.padStart(12, '0').slice(-12)}`,
  cursor,
  kind: 'turn_ended',
  thread_id: '00000000-0000-4000-8000-000000000001',
  title: 'Review reconnect logs',
  body: 'Codex finished replying.',
})
const scope = notificationScope('https://baton.test', 'employee')

function relayFixture(initial: string | null = '0') {
  const client = createMockClient('normal')
  const listeners = new Set<(change: ChangeEvent) => void>()
  client.subscribe = (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  let stored = initial
  const bridge = {
    ...createDesktopBridge().bridge,
    notificationCursor: vi.fn(async () => stored),
    deliverNotifications: vi.fn(
      async (input: { scope: string; events: BrowserNotification[]; cursor: string | null }) => {
        stored = input.cursor
      },
    ),
  }
  const replay = vi.fn<(after?: string) => Promise<NotificationReplay>>()
  client.replayNotifications = replay
  const onError = vi.fn()
  return {
    client,
    bridge,
    replay,
    listeners,
    onError,
    start: () => relayDesktopNotifications(client, bridge, scope, onError),
    refresh(change: ChangeEvent = { topics: [], browserEvent: { type: 'ready' } }) {
      for (const listener of listeners) listener(change)
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('desktop capabilities', () => {
  it('preserves enrollment in old clients and enables only recognized capability versions', async () => {
    vi.stubGlobal('batonDesktop', undefined)
    expect(desktopBridge()).toBeNull()
    expect(desktopCapability('notifications')).toBeNull()
    const { bridge } = createDesktopBridge()
    vi.stubGlobal('batonDesktop', bridge)
    await desktopBridge()!.enroll({ code: 'setup-code' })
    expect(bridge.enroll).toHaveBeenCalledWith({ code: 'setup-code' })
    expect(desktopCapability('notifications')).toBeNull()
    vi.stubGlobal('batonDesktop', {
      ...bridge,
      capabilities: [
        { name: 'future-feature', version: 1 },
        { name: 'notifications', version: 2 },
        { name: 'tray-status', version: 1 },
      ],
    })
    expect(desktopCapability('notifications')).toBeNull()
    expect(desktopCapability('tray-status')).not.toBeNull()
    vi.stubGlobal('batonDesktop', { ...bridge, capabilities: [{ name: 'notifications', version: 1 }] })
    expect(desktopCapability('notifications')).not.toBeNull()
    expect(desktopCapability('tray-status')).toBeNull()
  })
})

describe('desktop notification relay', () => {
  it('initializes at the server baseline and resumes from the native cursor after reload', async () => {
    const f = relayFixture(null)
    f.replay.mockResolvedValueOnce({ events: [], cursor: '10', has_more: false })
    let stop = f.start()
    await waitFor(() => expect(f.bridge.deliverNotifications).toHaveBeenCalledWith({ scope, events: [], cursor: '10' }))
    expect(f.replay).toHaveBeenCalledWith(undefined)
    stop()
    f.replay.mockResolvedValueOnce({ events: [event('11')], cursor: '11', has_more: false })
    stop = f.start()
    await waitFor(() =>
      expect(f.bridge.deliverNotifications).toHaveBeenLastCalledWith({ scope, events: [event('11')], cursor: '11' }),
    )
    expect(f.replay).toHaveBeenLastCalledWith('10')
    stop()
    expect(f.listeners.size).toBe(0)
    expect(notificationScope('https://other.test', 'employee')).not.toBe(scope)
    expect(notificationScope('https://baton.test', 'other')).not.toBe(scope)
  })

  it('replays gaps in order while live notifications arrive and does not advance to a live cursor', async () => {
    const f = relayFixture('9007199254740993')
    let resolve!: (page: NotificationReplay) => void
    f.replay.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    f.replay.mockResolvedValueOnce({ events: [event('9007199254740995')], cursor: '9007199254740995', has_more: false })
    const stop = f.start()
    await waitFor(() => expect(f.replay).toHaveBeenCalledTimes(1))
    f.refresh({ topics: [], browserEvent: event('9007199254740995') })
    resolve({ events: [event('9007199254740994')], cursor: '9007199254740994', has_more: true })
    await waitFor(() => expect(f.bridge.deliverNotifications).toHaveBeenCalledTimes(2))
    expect(f.replay.mock.calls).toEqual([['9007199254740993'], ['9007199254740994']])
    expect(
      f.bridge.deliverNotifications.mock.calls.flatMap(([input]) => input.events.map((item) => item.cursor)),
    ).toEqual(['9007199254740994', '9007199254740995'])
    stop()
  })

  it('retries an offline replay and failed native delivery without skipping an event', async () => {
    const f = relayFixture()
    const page = { events: [event('1')], cursor: '1', has_more: false }
    f.replay.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page)
    const stop = f.start()
    await waitFor(() => expect(f.onError).toHaveBeenCalledTimes(1))
    f.bridge.deliverNotifications.mockRejectedValueOnce(new Error('could not save cursor'))
    f.refresh()
    await waitFor(() => expect(f.onError).toHaveBeenCalledTimes(2))
    f.refresh()
    await waitFor(() => expect(f.bridge.deliverNotifications).toHaveBeenCalledTimes(2))
    expect(f.replay.mock.calls).toEqual([['0'], ['0'], ['0']])
    expect(f.bridge.deliverNotifications).toHaveBeenLastCalledWith({ scope, events: page.events, cursor: page.cursor })
    stop()
  })

  it('does not deliver an outstanding page after logout', async () => {
    const f = relayFixture()
    let resolve!: (page: NotificationReplay) => void
    f.replay.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const stop = f.start()
    await waitFor(() => expect(f.replay).toHaveBeenCalledTimes(1))
    stop()
    resolve({ events: [event('1')], cursor: '1', has_more: false })
    await Promise.resolve()
    expect(f.bridge.deliverNotifications).not.toHaveBeenCalled()
  })
})

it('bounds tray labels to 512 while relaying 4096-character notification titles unchanged', async () => {
  const client = createMockClient('normal')
  const thread = (await client.listThreads())[0]!
  const question = (await client.listInbox()).find((item) => item.kind === 'question')!
  const title = 't'.repeat(1000)
  expect(
    desktopActivity([{ ...thread, title }], [{ ...question, status: 'pending', threadId: thread.id }]).threads,
  ).toEqual([{ id: thread.id, title: title.slice(0, 512) }])
  const f = relayFixture()
  const notification = { ...event('1'), title: 'n'.repeat(4096), body: 'b'.repeat(4096) }
  f.replay.mockResolvedValueOnce({ events: [notification], cursor: '1', has_more: false })
  const stop = f.start()
  await waitFor(() =>
    expect(f.bridge.deliverNotifications).toHaveBeenCalledWith({ scope, events: [notification], cursor: '1' }),
  )
  stop()
})

it('counts distinct waiting threads on every device, including project threads, and caps the menu at five', async () => {
  const client = createMockClient('normal')
  const base = (await client.listThreads())[0]!
  const item = (await client.listInbox()).find((entry) => entry.kind === 'question')!
  const threads = Array.from({ length: 7 }, (_, index) => ({
    ...base,
    id: `thread-${index}`,
    deviceId: `device-${index}`,
    projectId: index % 2 ? 'project' : null,
    status: index < 2 ? ('running' as const) : ('idle' as const),
    pendingQuestions: [{ request_id: `request-${index}`, kind: 'user_input' as const, questions: [] }],
    updatedAt: index,
  }))
  const inbox = [
    { ...item, id: 'one', status: 'pending' as const, threadId: 'thread-0' },
    { ...item, id: 'two', status: 'pending' as const, threadId: 'thread-0' },
    { ...item, id: 'project-only', status: 'pending' as const, threadId: null },
    { ...item, id: 'system', kind: 'system' as const, status: 'pending' as const, threadId: 'ignored' },
  ]
  const archived = {
    ...base,
    id: 'archived',
    status: 'archived' as const,
    pendingQuestions: threads[0]!.pendingQuestions,
  }
  const activity = desktopActivity([...threads, archived], inbox)
  expect(activity.running).toBe(2)
  expect(activity.waiting).toBe(7)
  expect(activity.threads.map((thread) => thread.id)).toEqual([
    'thread-6',
    'thread-5',
    'thread-4',
    'thread-3',
    'thread-2',
  ])
  expect(
    desktopActivity(
      [{ ...base, id: 'only-inbox', pendingQuestions: [] }],
      [
        { ...item, status: 'pending', threadId: 'only-inbox' },
        { ...item, status: 'answered', threadId: 'other' },
      ],
    ).waiting,
  ).toBe(1)
})
