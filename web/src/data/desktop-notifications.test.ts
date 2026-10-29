import type { BrowserNotification } from '@baton/protocol'
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { ChangeEvent, NotificationReplay } from './client'
import { desktopBridge, desktopCapability } from './desktop'
import { desktopActivity, notificationScope, relayDesktopNotifications } from './desktop-notifications'
import { createMockClient } from './mock/client'
import { createDesktopBridge } from '../test/desktop'

it('counts projects needing attention alongside waiting threads', async () => {
  const client = createMockClient('normal')
  const thread = (await client.listThreads())[0]!
  const project = (await client.listProjects())[0]!
  const waiting = {
    ...thread,
    status: 'idle' as const,
    pendingQuestions: [{ request_id: 'q', kind: 'user_input' as const, questions: [] }],
  }
  const activity = desktopActivity(
    [waiting],
    [
      { ...project, id: 'a', latestReplySeq: 2, readReplySeq: 1 },
      { ...project, id: 'b', latestReplySeq: 3, readReplySeq: 2, attention: 'failing' },
      { ...project, id: 'c', latestReplySeq: 2, readReplySeq: 2 },
    ],
  )
  expect(activity.waiting).toBe(3)
  expect(activity.threads.map((entry) => entry.id)).toEqual([thread.id])
})

it('keeps a newer reply unread when an older reply is marked read', async () => {
  const client = createMockClient('normal')
  await client.markProjectRead('prj-compat', 2)
  expect(await client.getProject('prj-compat')).toMatchObject({ latestReplySeq: 3, readReplySeq: 2 })
})

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
