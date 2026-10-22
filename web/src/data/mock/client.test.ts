import { describe, expect, it } from 'vitest'
import type { ChangeEvent } from '../client'
import { previewProblem, threadView, projectAgentStatus } from '../derive'
import { createMockClient } from './client'
import { scenarioIds } from './scenarios'
import { manualScheduler } from './scheduler'
import { browserLatency } from './store'

function setup(scenario: Parameters<typeof createMockClient>[0] = 'normal') {
  const scheduler = manualScheduler()
  const client = createMockClient(scenario, { scheduler, latency: browserLatency })
  const events: ChangeEvent[] = []
  client.subscribe((event) => events.push(event))
  return { client, scheduler, events }
}

async function state(client: ReturnType<typeof createMockClient>) {
  const [session, devices, projects, threads, inbox] = await Promise.all([
    client.getSession(),
    client.listDevices().catch(() => []),
    client.listProjects().catch(() => []),
    client.listThreads().catch(() => []),
    client.listInbox().catch(() => []),
  ])
  return { session, devices, projects, threads, inbox }
}

describe('mock scenarios', () => {
  it.each(scenarioIds)('reset reproduces %s', async (id) => {
    const { client } = setup(id)
    const first = await state(client)
    if (first.devices.length > 0) client.controls.setDeviceConnection('dev-mac', 'offline')
    await client.sendMessage({ threadId: 'thr-webui', body: 'Ping', clientId: 'c1' }).catch(() => undefined)
    client.controls.reset()
    expect(await state(client)).toEqual(first)
  })

  it('switches scenario on reset', async () => {
    const { client } = setup()
    client.controls.reset('empty')
    expect(await client.listDevices()).toEqual([])
    expect(client.controls.scenario).toBe('empty')
  })
})

describe('device connection', () => {
  it('updates thread, project and file preview together', async () => {
    const { client, events } = setup()
    client.controls.setDeviceConnection('dev-ubuntu', 'offline')
    // 设备离线后 Project Agent 换到另一台满足条件的设备。
    client.controls.setDeviceConnection('dev-mac', 'offline')

    const { devices, projects, threads } = await state(client)
    const ubuntu = devices.find((item) => item.id === 'dev-ubuntu')
    const gateway = threads.find((item) => item.id === 'thr-gateway')!
    expect(threadView(gateway, ubuntu).notice?.title).toBe('Ubuntu Dev is offline')

    const baton = projects.find((item) => item.id === 'prj-baton')!
    expect(baton.agent.state).toBe('waitingDevice')
    expect(projectAgentStatus(baton, devices).label).toBe('Waiting for a device to come online')

    const preview = await client.readFile('dev-ubuntu', '/home/kaken/work/baton/internal/gateway/conn.go')
    expect(preview.state).toBe('unavailable')
    expect(previewProblem(preview, ubuntu)?.title).toBe('Ubuntu Dev is offline')

    expect(events.at(-1)?.topics).toEqual(expect.arrayContaining(['devices', 'threads', 'projects', 'files']))

    client.controls.setDeviceConnection('dev-ubuntu', 'online')
    const after = await state(client)
    expect(after.projects.find((item) => item.id === 'prj-baton')!.agent).toMatchObject({
      state: 'running',
      deviceId: 'dev-ubuntu',
    })
    expect((await client.readFile('dev-ubuntu', '/home/kaken/work/baton/internal/gateway/conn.go')).state).toBe('ready')
  })

  it('moves the project agent to another eligible device', async () => {
    const { client } = setup()
    client.controls.setDeviceConnection('dev-ubuntu', 'offline')
    const projects = await client.listProjects()
    expect(projects.find((item) => item.id === 'prj-baton')!.agent).toMatchObject({
      state: 'running',
      deviceId: 'dev-mac',
    })
  })
})

describe('operations', () => {
  it('walks a message through saved, running and done', async () => {
    const { client, scheduler } = setup()
    const op = await client.sendMessage({ threadId: 'thr-webui', body: 'Add tests', clientId: 'c1' })
    expect(op.phase).toBe('submitted')
    scheduler.advance(browserLatency.save)
    expect((await client.getOperation(op.id)).phase).toBe('running')
    expect((await client.listThreads()).find((item) => item.id === 'thr-webui')!.status).toBe('running')
    scheduler.advance(browserLatency.run)
    expect((await client.getOperation(op.id)).phase).toBe('done')
    const messages = await client.listMessages('thr-webui')
    expect(messages.at(-1)).toMatchObject({ role: 'agent' })
  })

  it('keeps one message per client id', async () => {
    const { client } = setup()
    const a = await client.sendMessage({ threadId: 'thr-webui', body: 'Once', clientId: 'same' })
    const b = await client.sendMessage({ threadId: 'thr-webui', body: 'Once', clientId: 'same' })
    expect(b.id).toBe(a.id)
    await expect(client.sendMessage({ threadId: 'thr-webui', body: 'Other', clientId: 'same' })).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  it('waits for the device, then delivers on reconnect', async () => {
    const { client, scheduler } = setup()
    const op = await client.sendMessage({ threadId: 'thr-compat', body: 'Rerun', clientId: 'c1' })
    scheduler.advance(browserLatency.save)
    expect((await client.getOperation(op.id)).phase).toBe('waitingDevice')
    expect((await client.listThreads()).find((item) => item.id === 'thr-compat')!.status).toBe('waiting')
    client.controls.setDeviceConnection('dev-windows', 'online')
    expect((await client.getOperation(op.id)).phase).toBe('running')
  })

  it('queues behind a running task', async () => {
    const { client, scheduler } = setup()
    const op = await client.sendMessage({ threadId: 'thr-gateway', body: 'Next', clientId: 'c1' })
    scheduler.advance(browserLatency.save)
    expect((await client.getOperation(op.id)).phase).toBe('queued')
    scheduler.advance(browserLatency.run)
    expect((await client.getOperation(op.id)).phase).toBe('running')
  })

  it('stops only after the device confirms and withdraws queued messages', async () => {
    const { client, scheduler } = setup()
    const queued = await client.sendMessage({ threadId: 'thr-gateway', body: 'Next', clientId: 'c1' })
    scheduler.advance(browserLatency.save)
    const stop = await client.stopThread('thr-gateway')
    scheduler.advance(browserLatency.save)
    expect((await client.getOperation(stop.id)).phase).toBe('stopping')
    expect((await client.listThreads()).find((item) => item.id === 'thr-gateway')!.status).toBe('running')
    scheduler.advance(browserLatency.device)
    expect((await client.getOperation(stop.id)).phase).toBe('stopped')
    expect((await client.listThreads()).find((item) => item.id === 'thr-gateway')).toMatchObject({
      status: 'stopped',
      stop: { kind: 'byYou' },
      stopCanceled: 1,
    })
    const messages = await client.listMessages('thr-gateway')
    expect(messages.find((item) => item.body === 'Next')!.delivery).toBe('withdrawn')
    expect((await client.getOperation(queued.id)).phase).toBe('stopped')
  })

  it('waits for an offline device to confirm a stop', async () => {
    const { client, scheduler } = setup()
    client.controls.setDeviceConnection('dev-ubuntu', 'offline')
    const stop = await client.stopThread('thr-gateway')
    scheduler.advance(browserLatency.save)
    expect((await client.getOperation(stop.id)).phase).toBe('waitingDevice')
    const waiting = (await client.listThreads()).find((item) => item.id === 'thr-gateway')!
    expect(waiting).toMatchObject({ status: 'running', pending: 'stop' })
    client.controls.setDeviceConnection('dev-ubuntu', 'online')
    expect((await client.getOperation(stop.id)).phase).toBe('stopping')
    scheduler.advance(browserLatency.device)
    expect((await client.getOperation(stop.id)).phase).toBe('stopped')
  })

  it('force quits when the agent does not stop within a minute', async () => {
    const { client, scheduler } = setup('waiting')
    const thread = () => client.listThreads().then((items) => items.find((item) => item.id === 'thr-patrol')!)
    expect(await thread()).toMatchObject({ status: 'running', pending: 'stop' })
    scheduler.advance(browserLatency.device)
    expect((await thread()).pending).toBe('stop')
    scheduler.advance(60_000)
    expect(await thread()).toMatchObject({ status: 'stopped', pending: null, stop: { kind: 'forced' } })
  })

  it('creates a standalone thread, talks, and archives it', async () => {
    const { client, scheduler } = setup()
    const op = await client.createThread({
      deviceId: 'dev-mac',
      folder: '~/src/elyx',
      agent: 'codex',
      model: 'gpt-6.1-sol',
      body: 'List the open TODOs\nand group them by file',
      clientId: 'n1',
    })
    const created = (await client.listThreads()).find((item) => item.id === op.targetId)!
    expect(created).toMatchObject({ projectId: null, title: 'List the open TODOs', folder: '~/src/elyx' })
    scheduler.advance(browserLatency.save)
    expect((await client.getOperation(op.id)).phase).toBe('running')
    scheduler.advance(browserLatency.run)
    expect((await client.listThreads()).find((item) => item.id === op.targetId)!.status).toBe('idle')

    await client.sendMessage({ threadId: op.targetId, body: 'Thanks', clientId: 'n2' })
    scheduler.advance(browserLatency.save + browserLatency.run)
    const messages = await client.listMessages(op.targetId)
    expect(messages.map((item) => item.role)).toEqual(['user', 'agent', 'user', 'agent'])

    const archive = await client.archiveThread(op.targetId)
    scheduler.advance(browserLatency.save)
    expect((await client.getOperation(archive.id)).phase).toBe('done')
    expect((await client.listThreads()).find((item) => item.id === op.targetId)!.status).toBe('archived')
    await expect(client.sendMessage({ threadId: op.targetId, body: 'More', clientId: 'n3' })).rejects.toMatchObject({
      code: 'invalid',
    })
  })

  it('rejects folders outside the allowed folders', async () => {
    const { client } = setup()
    await expect(
      client.createThread({
        deviceId: 'dev-mac',
        folder: '/etc',
        agent: 'codex',
        model: 'gpt-6.1-sol',
        body: 'Hi',
        clientId: 'n1',
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('stops a running thread before archiving it', async () => {
    const { client, scheduler } = setup()
    const queued = await client.sendMessage({ threadId: 'thr-gateway', body: 'Later', clientId: 'c1' })
    const archive = await client.archiveThread('thr-gateway')
    scheduler.advance(browserLatency.save)
    expect((await client.getOperation(archive.id)).phase).toBe('stopping')
    expect((await client.listThreads()).find((item) => item.id === 'thr-gateway')!.pending).toBe('archive')
    scheduler.advance(browserLatency.device)
    expect((await client.getOperation(archive.id)).phase).toBe('done')
    expect((await client.listThreads()).find((item) => item.id === 'thr-gateway')!.status).toBe('archived')
    expect((await client.getOperation(queued.id)).phase).toBe('stopped')
  })

  it('cancels a queued message but not a delivered one', async () => {
    const { client, scheduler } = setup()
    await client.sendMessage({ threadId: 'thr-gateway', body: 'Later', clientId: 'c1' })
    scheduler.advance(browserLatency.save)
    const queued = (await client.listMessages('thr-gateway')).find((item) => item.body === 'Later')!
    expect(queued.delivery).toBe('queued')
    expect((await client.cancelMessage(queued.id)).delivery).toBe('withdrawn')
    const delivered = (await client.listMessages('thr-gateway')).find((item) => item.delivery === 'delivered')!
    await expect(client.cancelMessage(delivered.id)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('sends now only when the agent can steer', async () => {
    const { client, scheduler } = setup()
    const now = await client.sendMessage({ threadId: 'thr-gateway', body: 'Use v2', clientId: 'c1', mode: 'now' })
    scheduler.advance(browserLatency.save)
    expect((await client.getOperation(now.id)).phase).toBe('running')
    await expect(
      client.sendMessage({ threadId: 'thr-patrol', body: 'Hurry', clientId: 'c2', mode: 'now' }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('stops with folder missing instead of resending', async () => {
    const { client, scheduler } = setup('error')
    const compat = (await client.listThreads()).find((item) => item.id === 'thr-compat')!
    expect(compat.stop?.kind).toBe('folderMissing')
    await expect(client.sendMessage({ threadId: 'thr-compat', body: 'Again', clientId: 'c1' })).rejects.toBeTruthy()
    scheduler.advance(browserLatency.run)
    expect((await client.listMessages('thr-upgrade')).filter((item) => item.delivery === 'unknown')).toHaveLength(1)
  })

  it('resumes an interrupted thread or reports lost history', async () => {
    const { client, scheduler } = setup('error')
    const resume = await client.resumeThread('thr-guide')
    scheduler.advance(browserLatency.save + browserLatency.device)
    expect(await client.getOperation(resume.id)).toMatchObject({ phase: 'failed', detail: 'Chat history not found' })
    expect((await client.listThreads()).find((item) => item.id === 'thr-guide')!.stop?.kind).toBe('historyLost')
    await expect(client.resumeThread('thr-patrol')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('lists allowed folders and their children', async () => {
    const { client } = setup()
    const roots = await client.listFolders('dev-mac', null)
    expect(roots).toMatchObject({ state: 'ready', folders: ['~/src'] })
    const children = await client.listFolders('dev-mac', '~/src')
    expect(children.state === 'ready' && children.folders).toContain('~/src/baton')
    expect(await client.listFolders('dev-mac', '/etc')).toMatchObject({ reason: 'outsideFolders' })
    client.controls.setDeviceConnection('dev-mac', 'offline')
    expect(await client.listFolders('dev-mac', null)).toMatchObject({ reason: 'offline' })
  })

  it('reports a conflict when the item was answered elsewhere', async () => {
    const { client, scheduler } = setup('conflict')
    const op = await client.answerItem({
      itemId: 'itm-compat-paths',
      answer: 'Skip them and open a follow-up',
      revision: 1,
    })
    scheduler.advance(browserLatency.save)
    expect(await client.getOperation(op.id)).toMatchObject({
      phase: 'conflict',
      detail: 'Already answered: Fix them before merging',
    })
    expect((await client.listInbox()).find((item) => item.id === 'itm-compat-paths')!.status).toBe('answered')
  })

  it('rejects reads after sign out and accepts mock credentials', async () => {
    const { client } = setup('signedOut')
    await expect(client.listThreads()).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(client.signIn('kaken', 'wrong')).rejects.toMatchObject({ code: 'unauthorized' })
    await client.signIn('kaken', 'example-password')
    expect(await client.listThreads()).not.toHaveLength(0)
  })
})
