import { describe, expect, it } from 'vitest'
import type { ProjectPatch, SaveMemoryInput } from '../types'
import { createMockClient } from './client'
import { createWorld, type ScenarioId } from './scenarios'
import { manualScheduler } from './scheduler'
import { browserLatency, MockStore } from './store'

const projectId = 'prj-compat'
const noteId = 'mem-compat-1'

function setup(scenario: ScenarioId = 'maintenance') {
  const scheduler = manualScheduler()
  const store = new MockStore(scenario, scheduler, browserLatency)
  return { store, scheduler }
}

function memoryInput(fields: Partial<SaveMemoryInput> = {}): SaveMemoryInput {
  return { projectId, noteId, body: 'Release checklist', version: 1, clientId: 'edit-1', ...fields }
}

function assistants(store: MockStore, id = projectId) {
  return store.projectEntries(id).filter((entry) => entry.kind === 'assistant')
}

function message(store: MockStore, body = 'Hello', clientId = 'message-1', id = projectId) {
  const entry = store.sendProjectMessage(id, body, clientId)
  if (entry.kind !== 'user') throw new Error('Expected a user entry')
  return entry
}

describe('project maintenance', () => {
  it('validates a complete settings patch before changing any field', () => {
    const { store } = setup()
    const before = structuredClone(store.project(projectId))
    for (const patch of [
      { name: '  ' },
      { name: 'Release', goal: 42 },
      { name: 'Release', goal: undefined },
      { name: 'Release', model: 'unknown' },
      { name: 'Release', subscription: 'Claude' },
      { name: 'Release', subscription: '__proto__' },
      { name: 'Release', status: 'archived' },
    ]) {
      expect(() => store.updateProject(projectId, patch as ProjectPatch)).toThrow()
      expect(store.project(projectId)).toEqual(before)
      expect(store.snapshot().passiveInputs).toEqual([])
    }
    expect(
      store.updateProject(projectId, {
        name: '  Release  ',
        goal: '  Ship Windows support  ',
        subscription: 'Claude',
        model: 'claude-opus-5-5',
      }),
    ).toMatchObject({ name: 'Release', goal: 'Ship Windows support', subscription: 'Claude', model: 'claude-opus-5-5' })
    expect(store.updateProject(projectId, { goal: '' }).goal).toBe('')
  })

  it('keeps settings and memory updates passive and coalesces repeated memory edits', () => {
    const { store, scheduler } = setup()
    store.updateProject(projectId, { name: 'Release' })
    store.updateProject(projectId, { goal: 'Windows release' })
    const saved = store.saveMemory(memoryInput())
    store.saveMemory(memoryInput({ body: 'Newest checklist', version: saved.note.version, clientId: 'edit-2' }))
    scheduler.advance(browserLatency.run * 3)
    expect(store.project(projectId).agent.state).toBe('idle')
    expect(assistants(store)).toHaveLength(2)
    const pending = store.snapshot().passiveInputs
    expect(pending).toEqual([
      expect.objectContaining({ kind: 'settings', patch: { name: 'Release', goal: 'Windows release' } }),
      expect.objectContaining({ kind: 'memory', noteId, version: 3, body: 'Newest checklist' }),
    ])
    message(store)
    scheduler.advance(browserLatency.save)
    expect(store.snapshot().assistantContexts[projectId].passiveInputs).toEqual(pending)
    expect(store.snapshot().passiveInputs).toEqual([])
    scheduler.advance(browserLatency.run)
    expect(store.project(projectId).agent.state).toBe('idle')
    expect(assistants(store)).toHaveLength(3)
  })

  it('uses a changed subscription and model on the next run without restarting the current run', () => {
    const { store, scheduler } = setup()
    message(store)
    scheduler.advance(browserLatency.save)
    const first = store.snapshot().assistantContexts[projectId]
    expect(first).toMatchObject({ subscription: 'ChatGPT', model: 'gpt-6.1-sol' })
    scheduler.advance(1000)
    const agent = structuredClone(store.project(projectId).agent)
    store.updateProject(projectId, { subscription: 'Claude', model: 'claude-opus-5-5' })
    expect(store.project(projectId).agent).toEqual(agent)
    expect(store.snapshot().assistantContexts[projectId]).toEqual(first)
    scheduler.advance(browserLatency.run / 2 - 1000)
    expect(assistants(store)).toHaveLength(3)
    expect(store.project(projectId).agent.state).toBe('idle')
    expect(store.snapshot().passiveInputs).toEqual([])
    message(store, 'Hello again', 'message-2')
    scheduler.advance(browserLatency.save)
    expect(store.snapshot().assistantContexts[projectId]).toMatchObject({
      subscription: 'Claude',
      model: 'claude-opus-5-5',
    })
    expect(store.project(projectId).agent.deviceId).toBe('dev-ubuntu')
  })

  it('keeps the current subscription during device failover after a model change', () => {
    const { store, scheduler } = setup()
    const id = 'prj-baton'
    store.updateProject(id, { subscription: 'Claude', model: 'claude-opus-5-5' })
    store.setDeviceConnection('dev-ubuntu', 'offline')
    expect(store.project(id).agent).toMatchObject({ state: 'running', deviceId: 'dev-mac' })
    expect(store.snapshot().assistantContexts[id]).toMatchObject({ subscription: 'ChatGPT', model: 'gpt-6.1-sol' })
    scheduler.advance(browserLatency.run / 2)
    message(store, 'Hello', 'next-configuration', id)
    scheduler.advance(browserLatency.save)
    expect(store.project(id).agent.state).toBe('waitingDevice')
    store.setDeviceConnection('dev-ubuntu', 'online')
    expect(store.project(id).agent).toMatchObject({ state: 'running', deviceId: 'dev-ubuntu' })
    expect(store.snapshot().assistantContexts[id]).toMatchObject({ subscription: 'Claude', model: 'claude-opus-5-5' })
  })

  it('retains all memory versions and records user and assistant sources', () => {
    const { store, scheduler } = setup()
    const original = structuredClone(store.projectMemory(projectId)[0])
    expect(original).toMatchObject({
      version: 1,
      source: 'assistant',
      versions: [expect.objectContaining({ version: 1, source: 'assistant' })],
    })
    scheduler.advance(10)
    const saved = store.saveMemory(memoryInput())
    expect(saved).toMatchObject({
      state: 'saved',
      note: { version: 2, body: 'Release checklist', source: 'you', updatedAt: scheduler.now() },
    })
    expect(saved.note.versions).toEqual([
      original.versions[0],
      { version: 2, body: 'Release checklist', source: 'you', updatedAt: scheduler.now() },
    ])
    message(store, 'Run tests on MacBook Pro')
    scheduler.advance(browserLatency.save + browserLatency.run / 2)
    const generated = store.projectMemory(projectId).find((note) => note.id !== noteId)!
    expect(generated).toMatchObject({
      version: 1,
      source: 'assistant',
      versions: [expect.objectContaining({ version: 1, source: 'assistant' })],
    })
    expect(generated.versions[0].body).toBe(generated.body)
  })

  it('returns the latest assistant revision on conflict without overwriting it', () => {
    const { store } = setup('memoryConflict')
    const before = structuredClone(store.projectMemory(projectId)[0])
    const conflict = store.saveMemory(memoryInput())
    expect(conflict).toMatchObject({
      state: 'conflict',
      note: { version: 2, source: 'assistant', body: 'Run the Windows drive-letter tests before every release.' },
    })
    expect(conflict.note.versions[0]).toEqual(before.versions[0])
    expect(store.snapshot().passiveInputs).toEqual([])
    const stale = store.saveMemory(memoryInput({ clientId: 'other-editor' }))
    expect(stale).toEqual(conflict)
    expect(store.projectMemory(projectId)[0].versions).toHaveLength(2)
    const saved = store.saveMemory(memoryInput({ version: conflict.note.version }))
    expect(saved).toMatchObject({ state: 'saved', note: { version: 3, body: 'Release checklist', source: 'you' } })
  })

  it('deduplicates new notes and edit retries by clientId, including after newer edits', () => {
    const { store } = setup()
    const input = memoryInput({ noteId: null, version: null, clientId: 'add-1' })
    const first = structuredClone(store.saveMemory(input))
    expect(store.saveMemory(input)).toEqual(first)
    expect(store.projectMemory(projectId)).toHaveLength(2)
    const edit = memoryInput({ noteId: first.note.id, body: 'Second revision', clientId: 'edit-new' })
    const second = structuredClone(store.saveMemory(edit))
    store.saveMemory({ ...edit, body: 'Third revision', version: 2, clientId: 'edit-newer' })
    expect(store.saveMemory(input)).toEqual(first)
    expect(store.saveMemory(edit)).toEqual(second)
    expect(store.projectMemory(projectId).find((note) => note.id === first.note.id)!.versions).toHaveLength(3)
    expect(() => store.saveMemory({ ...input, body: 'Different payload' })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    )
    expect(() => store.saveMemory({ ...input, projectId: 'prj-baton' })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    )
    expect(store.snapshot().passiveInputs.filter((input) => input.kind === 'memory')).toHaveLength(1)
  })

  it('rejects empty notes, invalid versions and notes belonging to another project', () => {
    const { store } = setup()
    const before = store.snapshot().memory
    for (const input of [
      memoryInput({ body: '  ' }),
      memoryInput({ version: null }),
      memoryInput({ version: 1.5 }),
      memoryInput({ noteId: null }),
      memoryInput({ clientId: '' }),
    ])
      expect(() => store.saveMemory(input)).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => store.saveMemory(memoryInput({ noteId: 'mem-baton-1' }))).toThrow(
      expect.objectContaining({ code: 'notFound' }),
    )
    expect(store.snapshot().memory).toEqual(before)
  })
})

describe('project pause and archive', () => {
  it('cancels an in-flight assistant callback and processes saved inputs once on resume', () => {
    const { store, scheduler } = setup()
    const first = message(store, 'Run tests on MacBook Pro')
    scheduler.advance(browserLatency.save)
    expect(first.delivery).toBe('delivered')
    store.setProjectStatus(projectId, 'paused')
    expect(first.delivery).toBe('saved')
    const second = message(store, 'Hello again', 'message-2')
    scheduler.advance(browserLatency.run * 2)
    expect(second.delivery).toBe('saved')
    expect(assistants(store)).toHaveLength(2)
    const threads = store.snapshot().threads.length
    store.setProjectStatus(projectId, 'active')
    store.setProjectStatus(projectId, 'active')
    expect(first.delivery).toBe('delivered')
    expect(second.delivery).toBe('delivered')
    scheduler.advance(browserLatency.run / 2)
    expect(assistants(store)).toHaveLength(3)
    expect(store.snapshot().threads).toHaveLength(threads + 1)
    scheduler.advance(browserLatency.run * 3)
    expect(store.snapshot().threads).toHaveLength(threads + 1)
    expect(assistants(store).filter((entry) => entry.threads?.action === 'opened')).toHaveLength(2)
  })

  it('restores passive inputs on cancellation and keeps the newest pending memory version', () => {
    const { store, scheduler } = setup()
    store.saveMemory(memoryInput())
    store.updateProject(projectId, { name: 'Release' })
    message(store)
    scheduler.advance(browserLatency.save)
    store.saveMemory(memoryInput({ version: 2, body: 'Latest version', clientId: 'edit-2' }))
    store.updateProject(projectId, { goal: 'Updated goal' })
    store.setProjectStatus(projectId, 'paused')
    store.setProjectStatus(projectId, 'active')
    const passive = store.snapshot().assistantContexts[projectId].passiveInputs
    expect(passive).toHaveLength(2)
    expect(passive).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'memory', noteId, version: 3, body: 'Latest version' }),
        expect.objectContaining({ kind: 'settings', patch: { name: 'Release', goal: 'Updated goal' } }),
      ]),
    )
    scheduler.advance(browserLatency.run / 2)
    expect(store.snapshot().passiveInputs).toEqual([])
    message(store, 'Hello again', 'message-2')
    scheduler.advance(browserLatency.save)
    expect(store.snapshot().assistantContexts[projectId].passiveInputs).toEqual([])
  })

  it.each([0, browserLatency.run])('retains Thread results when pausing at %i ms', (pauseAt) => {
    const { store, scheduler } = setup()
    const id = 'prj-baton'
    scheduler.advance(pauseAt)
    expect(store.project(id).agent.state).toBe('running')
    store.setProjectStatus(id, 'paused')
    scheduler.advance(browserLatency.run * 2)
    expect(assistants(store, id).filter((entry) => entry.threads?.action === 'replies')).toHaveLength(0)
    expect(store.thread('thr-gateway').status).toBe('idle')
    store.setProjectStatus(id, 'active')
    scheduler.advance(browserLatency.run / 2)
    expect(assistants(store, id).filter((entry) => entry.threads?.action === 'replies')).toHaveLength(1)
    store.setProjectStatus(id, 'paused')
    store.setProjectStatus(id, 'active')
    scheduler.advance(browserLatency.run * 2)
    expect(assistants(store, id).filter((entry) => entry.threads?.action === 'replies')).toHaveLength(1)
  })

  it('keeps running Threads and Inbox answers usable during pause', () => {
    const { store, scheduler } = setup()
    store.setProjectStatus('prj-baton', 'paused')
    expect(store.thread('thr-gateway').status).toBe('running')
    store.setProjectStatus(projectId, 'paused')
    const item = store.snapshot().inbox.find((item) => item.id === 'itm-compat-paths')!
    store.handleItem(item.id, { kind: 'answer', option: item.options[0], note: '' }, item.revision)
    const op = store.sendMessage('thr-compat', 'Hello', 'thread-message')
    store.setDeviceConnection('dev-windows', 'online')
    scheduler.advance(browserLatency.save + browserLatency.run)
    expect(store.operation(op.id).phase).toBe('done')
    expect(store.thread('thr-gateway').status).toBe('idle')
    expect(
      store
        .projectEntries(projectId)
        .find(
          (entry) =>
            entry.id === store.snapshot().inbox.find((item) => item.id === 'itm-compat-paths')!.result!.inputId,
        ),
    ).toMatchObject({ delivery: 'saved' })
    store.setProjectStatus(projectId, 'active')
    scheduler.advance(browserLatency.run / 2)
    expect(assistants(store)).toHaveLength(3)
  })

  it('preserves a system block across pause and resume until Retry', () => {
    const { store, scheduler } = setup('error')
    const id = 'prj-baton'
    const blocked = structuredClone(store.project(id).agent)
    const first = message(store, 'Hello', 'blocked-message', id)
    store.setProjectStatus(id, 'paused')
    const second = message(store, 'Hello again', 'paused-message', id)
    scheduler.advance(browserLatency.save)
    store.setProjectStatus(id, 'active')
    expect(store.project(id).agent).toEqual(blocked)
    expect([first.delivery, second.delivery]).toEqual(['saved', 'saved'])
    expect(store.snapshot().inbox.find((item) => item.id === 'itm-baton-signin')!.status).toBe('pending')
    store.retryProject(id)
    expect(store.project(id).agent.state).toBe('running')
    expect([first.delivery, second.delivery]).toEqual(['delivered', 'delivered'])
    scheduler.advance(browserLatency.run / 2)
    expect(assistants(store, id)).toHaveLength(2)
    expect(store.snapshot().inbox.find((item) => item.id === 'itm-baton-signin')!.status).toBe('resolved')
  })

  it('archives with a stable timestamp, withdrawing both questions and system notices', () => {
    const { store, scheduler } = setup('error')
    const before = store.snapshot()
    const id = 'prj-baton'
    const archivedAt = scheduler.now()
    const events: string[][] = []
    store.subscribe((event) => events.push(event.topics))
    store.setProjectStatus(id, 'archived')
    store.setProjectStatus(projectId, 'archived')
    const after = store.snapshot()
    expect(after.threads).toEqual(before.threads)
    expect(after.memory).toEqual(before.memory)
    expect(after.projectEntries).toEqual(before.projectEntries)
    for (const item of after.inbox.filter((item) => item.projectId === id || item.projectId === projectId)) {
      expect(item).toMatchObject({ status: 'withdrawn', revision: 2, result: { reason: 'Project archived' } })
    }
    expect(events.at(-1)).toEqual(expect.arrayContaining(['projects', 'inbox']))
    scheduler.advance(100)
    const inbox = store.snapshot().inbox
    const eventCount = events.length
    expect(store.setProjectStatus(id, 'archived')).toMatchObject({ archivedAt, status: 'archived' })
    expect(store.snapshot().inbox).toEqual(inbox)
    expect(events).toHaveLength(eventCount)
    for (const status of ['active', 'paused'] as const) {
      expect(() => store.setProjectStatus(id, status)).toThrow(expect.objectContaining({ code: 'invalid' }))
    }
  })

  it('cancels a running assistant permanently when archived and keeps its Threads operating', () => {
    const { store, scheduler } = setup()
    const entry = message(store, 'Run tests on Windows Desktop')
    scheduler.advance(browserLatency.save)
    store.setProjectStatus(projectId, 'archived')
    const before = store.projectEntries(projectId).length
    const threadCount = store.snapshot().threads.length
    scheduler.advance(browserLatency.run * 3)
    expect(store.projectEntries(projectId)).toHaveLength(before)
    expect(entry.delivery).toBe('saved')
    expect(store.snapshot().threads).toHaveLength(threadCount)
    const op = store.sendMessage('thr-compat', 'Hello', 'archived-thread')
    store.setDeviceConnection('dev-windows', 'online')
    scheduler.advance(browserLatency.save + browserLatency.run)
    expect(store.operation(op.id).phase).toBe('done')
    expect(store.project(projectId)).toMatchObject({ status: 'archived', agent: { state: 'stopped' } })
    expect(store.projectEntries(projectId)).toHaveLength(before)
  })

  it.each(['paused', 'archived'] as const)('cancels a pending stopProjectRun callback on %s', (status) => {
    const { store, scheduler } = setup()
    const id = 'prj-baton'
    store.stopProjectRun(id)
    expect(store.project(id).agent.state).toBe('stopping')
    store.setProjectStatus(id, status)
    const before = structuredClone(store.projectEntries(id))
    scheduler.advance(browserLatency.device)
    expect(store.projectEntries(id)).toEqual(before)
    expect(store.project(id).status).toBe(status)
    expect(store.project(id).agent.state).toBe(status === 'paused' ? 'idle' : 'stopped')
    expect(store.thread('thr-gateway').status).toBe('running')
  })

  it('never wakes an archived project from Thread results or device reconnection', () => {
    const { store, scheduler } = setup()
    const id = 'prj-baton'
    store.setProjectStatus(id, 'archived')
    const before = structuredClone(store.projectEntries(id))
    store.setDeviceConnection('dev-ubuntu', 'offline')
    store.setDeviceConnection('dev-ubuntu', 'online')
    scheduler.advance(browserLatency.run * 4)
    expect(store.projectEntries(id)).toEqual(before)
    expect(store.project(id).agent.state).toBe('stopped')
    expect(store.thread('thr-gateway').status).toBe('idle')
  })

  it('rejects archived project writes, including retries, and retains readable records', () => {
    const { store } = setup()
    const saved = memoryInput({ noteId: null, version: null })
    store.saveMemory(saved)
    message(store)
    store.setProjectStatus(projectId, 'archived')
    expect(() => store.updateProject(projectId, { name: 'Another name' })).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    )
    expect(() => store.saveMemory(saved)).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => message(store)).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => store.retryProject(projectId)).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(store.projectMemory(projectId)).toHaveLength(2)
    expect(store.projectEntries(projectId)).toHaveLength(4)
  })

  it('rejects stale assistant and stop callbacks even if timer cancellation arrives too late', () => {
    const clock = manualScheduler()
    const scheduler = {
      ...clock,
      after: (ms: number, task: () => void) => {
        clock.after(ms, task)
        return () => {}
      },
    }
    const store = new MockStore('maintenance', scheduler, browserLatency)
    message(store)
    clock.advance(browserLatency.save)
    clock.advance(1000)
    store.setProjectStatus(projectId, 'paused')
    store.setProjectStatus(projectId, 'active')
    clock.advance(browserLatency.run / 2 - 1000)
    expect(store.project(projectId).agent.state).toBe('running')
    expect(assistants(store)).toHaveLength(2)
    clock.advance(1000)
    expect(assistants(store)).toHaveLength(3)
    message(store, 'Hello again', 'message-2')
    clock.advance(browserLatency.save)
    store.stopProjectRun(projectId)
    store.setProjectStatus(projectId, 'paused')
    message(store, 'Hello once more', 'message-3')
    clock.advance(browserLatency.save)
    store.setProjectStatus(projectId, 'active')
    clock.advance(browserLatency.device)
    expect(store.project(projectId).agent.state).toBe('running')
    expect(assistants(store)).toHaveLength(3)
    expect(
      store.projectEntries(projectId).some((entry) => entry.kind === 'note' && entry.body.includes('stopped')),
    ).toBe(false)
    clock.advance(browserLatency.run)
    expect(assistants(store)).toHaveLength(4)
  })

  it('saves a submitted message after archive without waking the assistant', () => {
    const { store, scheduler } = setup()
    const entry = message(store)
    expect(entry.delivery).toBe('submitted')
    store.setProjectStatus(projectId, 'archived')
    scheduler.advance(browserLatency.save + browserLatency.run)
    expect(entry.delivery).toBe('saved')
    expect(assistants(store)).toHaveLength(2)
    expect(store.project(projectId).agent.state).toBe('stopped')
  })

  it('drops stale assistant and stop callbacks on scenario reset', () => {
    const { store, scheduler } = setup()
    message(store)
    scheduler.advance(browserLatency.save)
    store.stopProjectRun('prj-baton')
    store.reset('maintenance')
    const entries = structuredClone(store.snapshot().projectEntries)
    scheduler.advance(browserLatency.run / 2)
    expect(store.snapshot().projectEntries).toEqual(entries)
    expect(store.project(projectId).agent.state).toBe('idle')
    expect(store.project('prj-baton').agent.state).toBe('idle')
  })
})

describe('maintenance client and scenarios', () => {
  it('fails settings, memory and status once each without partial saves, then permits retries', () => {
    const { store } = setup('maintenanceError')
    expect(() => store.listProjects()).toThrow(expect.objectContaining({ code: 'unavailable' }))
    const project = structuredClone(store.listProjects().find((project) => project.id === projectId)!)
    expect(() => store.projectMemory(projectId)).toThrow(expect.objectContaining({ code: 'unavailable' }))
    const memory = structuredClone(store.projectMemory(projectId))
    expect(() => store.updateProject(projectId, { name: 'Release', goal: 'New goal' })).toThrow(
      expect.objectContaining({ code: 'unavailable' }),
    )
    expect(store.project(projectId)).toEqual(project)
    expect(store.snapshot().passiveInputs).toEqual([])
    expect(store.updateProject(projectId, { name: 'Release', goal: 'New goal' }).name).toBe('Release')
    expect(() => store.saveMemory(memoryInput({ noteId: null, version: null }))).toThrow(
      expect.objectContaining({ code: 'unavailable' }),
    )
    expect(store.projectMemory(projectId)).toEqual(memory)
    expect(store.saveMemory(memoryInput({ noteId: null, version: null })).state).toBe('saved')
    expect(() => store.setProjectStatus(projectId, 'archived')).toThrow(
      expect.objectContaining({ code: 'unavailable' }),
    )
    expect(store.project(projectId)).toMatchObject({ status: 'active', archivedAt: null })
    expect(
      store
        .snapshot()
        .inbox.filter((item) => item.projectId === projectId)
        .every((item) => item.status === 'pending'),
    ).toBe(true)
    expect(store.setProjectStatus(projectId, 'archived').status).toBe('archived')
  })

  it('keeps an assistant running when a status save fails', () => {
    const { store, scheduler } = setup('maintenanceError')
    message(store)
    scheduler.advance(browserLatency.save)
    const before = structuredClone(store.project(projectId))
    expect(() => store.setProjectStatus(projectId, 'paused')).toThrow(expect.objectContaining({ code: 'unavailable' }))
    expect(store.project(projectId)).toEqual(before)
    scheduler.advance(browserLatency.run / 2)
    expect(assistants(store)).toHaveLength(3)
    expect(store.project(projectId)).toMatchObject({ status: 'active', agent: { state: 'idle' } })
  })

  it('rejects a memory save that commits after a concurrent archive', async () => {
    const clock = manualScheduler()
    const scheduler = {
      ...clock,
      wait: (ms: number) =>
        new Promise<void>((resolve) => {
          clock.after(ms, resolve)
        }),
    }
    const client = createMockClient('maintenance', { scheduler, latency: { ...browserLatency, read: 0 } })
    const archiving = client.setProjectStatus({ projectId, status: 'archived' })
    const saving = client.saveMemory(memoryInput({ noteId: null, version: null }))
    const updating = client.updateProject({ projectId, patch: { name: 'Release' } })
    const failures = [
      expect(saving).rejects.toMatchObject({ code: 'invalid' }),
      expect(updating).rejects.toMatchObject({ code: 'invalid' }),
    ]
    clock.advance(browserLatency.save)
    expect(await archiving).toMatchObject({ status: 'archived', archivedAt: clock.now() })
    await Promise.all(failures)
    const reading = client.listProjectMemory(projectId)
    clock.advance(0)
    expect(await reading).toHaveLength(1)
  })

  it('waits for save latency before atomically committing settings, memory and status', async () => {
    const clock = manualScheduler()
    const waits: number[] = []
    const scheduler = {
      ...clock,
      wait: (ms: number) => {
        waits.push(ms)
        return new Promise<void>((resolve) => {
          clock.after(ms, resolve)
        })
      },
    }
    const client = createMockClient('maintenance', { scheduler, latency: { ...browserLatency, read: 0 } })
    const patch = { name: 'Release', goal: 'New goal' }
    const updating = client.updateProject({ projectId, patch })
    patch.name = 'Changed after sending'
    const saving = client.saveMemory(memoryInput({ noteId: null, version: null }))
    const pausing = client.setProjectStatus({ projectId, status: 'paused' })
    clock.advance(browserLatency.save - 1)
    const reading = client.listProjects()
    clock.advance(0)
    expect((await reading).find((project) => project.id === projectId)).toMatchObject({
      name: 'Compatibility',
      status: 'active',
    })
    const memoryBefore = client.listProjectMemory(projectId)
    clock.advance(0)
    expect(await memoryBefore).toHaveLength(1)
    clock.advance(1)
    expect(await updating).toMatchObject({ name: 'Release', goal: 'New goal', status: 'active' })
    expect(await saving).toMatchObject({ state: 'saved', note: { source: 'you', version: 1 } })
    expect(await pausing).toMatchObject({ name: 'Release', goal: 'New goal', status: 'paused' })
    expect(waits.slice(0, 3)).toEqual([browserLatency.save, browserLatency.save, browserLatency.save])
  })

  it('serializes concurrent memory creation and optimistic edits at commit', async () => {
    const scheduler = manualScheduler()
    const client = createMockClient('maintenance', { scheduler, latency: browserLatency })
    const add = memoryInput({ noteId: null, version: null, clientId: 'concurrent-add' })
    const [a, b] = await Promise.all([client.saveMemory(add), client.saveMemory(add)])
    expect(a).toEqual(b)
    expect(await client.listProjectMemory(projectId)).toHaveLength(2)
    const [first, second] = await Promise.all([
      client.saveMemory(memoryInput({ body: 'First writer', clientId: 'first-writer' })),
      client.saveMemory(memoryInput({ body: 'Second writer', clientId: 'second-writer' })),
    ])
    expect(first).toMatchObject({ state: 'saved', note: { version: 2, body: 'First writer' } })
    expect(second).toMatchObject({ state: 'conflict', note: { version: 2, body: 'First writer' } })
    second.note.body = 'Changed by caller'
    expect((await client.listProjectMemory(projectId)).find((note) => note.id === noteId)!.body).toBe('First writer')
  })

  it.each(['unauthorized', 'unavailable'] as const)(
    'checks %s after the save delay and preserves all state on failure',
    async (code) => {
      const clock = manualScheduler()
      const scheduler = {
        ...clock,
        wait: (ms: number) =>
          new Promise<void>((resolve) => {
            clock.after(ms, resolve)
          }),
      }
      const client = createMockClient('maintenance', { scheduler, latency: { ...browserLatency, read: 0 } })
      const requests = [
        client.updateProject({ projectId, patch: { name: 'Release' } }),
        client.saveMemory(memoryInput()),
        client.setProjectStatus({ projectId, status: 'archived' }),
      ]
      const assertions = requests.map((request) => expect(request).rejects.toMatchObject({ code }))
      if (code === 'unauthorized') client.controls.endSession('expired')
      else client.controls.setReachable(false)
      clock.advance(browserLatency.save)
      await Promise.all(assertions)
      client.controls.setReachable(true)
      if (code === 'unauthorized') {
        const signingIn = client.signIn('kaken', 'sample')
        clock.advance(browserLatency.save)
        await signingIn
      }
      const projects = client.listProjects()
      const memory = client.listProjectMemory(projectId)
      clock.advance(0)
      expect((await projects).find((project) => project.id === projectId)).toMatchObject({
        name: 'Compatibility',
        status: 'active',
      })
      expect((await memory)[0]).toMatchObject({ version: 1, source: 'assistant' })
    },
  )

  it('makes all new scenarios deterministic and archives compat with its records available', () => {
    for (const id of ['maintenance', 'maintenanceError', 'memoryConflict', 'archived'] as const) {
      const first = createWorld(id, 12345)
      expect(createWorld(id, 12345)).toEqual(first)
      expect(
        first.projects.every((project) =>
          project.status === 'archived' ? project.archivedAt !== null : project.archivedAt === null,
        ),
      ).toBe(true)
    }
    const { store } = setup('archived')
    expect(store.project(projectId)).toMatchObject({ status: 'archived', archivedAt: expect.any(Number) })
    expect(store.projectMemory(projectId)).toHaveLength(1)
    expect(store.projectEntries(projectId)).toHaveLength(3)
    expect(store.thread('thr-compat').status).toBe('idle')
    expect(
      store
        .snapshot()
        .inbox.filter((item) => item.projectId === projectId)
        .every((item) => item.status === 'withdrawn'),
    ).toBe(true)
    const project = store.createProject(
      { name: 'New project', goal: '', subscription: 'ChatGPT', model: 'gpt-6.1-mini' },
      'new-project',
    )
    expect(project.archivedAt).toBeNull()
  })
})
