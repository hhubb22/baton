import { describe, expect, it } from 'vitest'
import type { ChangeEvent } from '../client'
import { assistantWait, previewProblem, projectAgentStatus, threadView } from '../derive'
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
    expect(projectAgentStatus(baton, devices).label).toBe('Waiting for device')

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

describe('projects', () => {
  async function create(client: ReturnType<typeof createMockClient>, scheduler: ReturnType<typeof manualScheduler>) {
    const project = await client.createProject({
      name: 'Release check',
      goal: 'Run the compat suite before each release.',
      subscription: 'ChatGPT',
      model: 'gpt-6.1-sol',
      clientId: 'p1',
    })
    scheduler.advance(0)
    return project
  }

  it('creates a project that waits for its first message', async () => {
    const { client, scheduler } = setup()
    await expect(
      client.createProject({ name: '  ', goal: '', subscription: 'ChatGPT', model: 'gpt-6.1-sol', clientId: 'p0' }),
    ).rejects.toMatchObject({ code: 'invalid', message: 'Enter a project name.' })
    const project = await create(client, scheduler)
    expect(project).toMatchObject({ status: 'active', agent: { state: 'notStarted' } })
    expect((await create(client, scheduler)).id).toBe(project.id)
    expect(await client.listProjectEntries(project.id)).toEqual([])
  })

  it('fails once in the error scenario and saves on retry', async () => {
    const { client } = setup('error')
    const input = { name: 'Retry', goal: '', subscription: 'ChatGPT', model: 'gpt-6.1-sol', clientId: 'p1' }
    await expect(client.createProject(input)).rejects.toMatchObject({ code: 'unavailable' })
    expect((await client.createProject(input)).name).toBe('Retry')
  })

  it('opens two threads, waits for both replies, then reports once', async () => {
    const { client, scheduler } = setup()
    const project = await create(client, scheduler)
    await client.sendProjectMessage({
      projectId: project.id,
      body: 'Run the compat suite on MacBook Pro and Ubuntu Dev.',
      clientId: 'm1',
    })
    scheduler.advance(browserLatency.save)
    expect((await client.listProjects()).find((item) => item.id === project.id)!.agent).toMatchObject({
      state: 'running',
      deviceId: 'dev-mac',
      activity: 'Reading your message…',
    })

    scheduler.advance(browserLatency.run / 2)
    const threads = (await client.listThreads()).filter((item) => item.projectId === project.id)
    expect(threads.map((item) => [item.deviceId, item.status, item.folder])).toEqual([
      ['dev-mac', 'running', '~/src/compat-suite'],
      ['dev-ubuntu', 'running', '/home/kaken/work/baton'],
    ])
    const messages = await client.listMessages(threads[0].id)
    expect(messages[0]).toMatchObject({ sender: 'projectAgent', delivery: 'delivered' })
    let entries = await client.listProjectEntries(project.id)
    expect(entries.at(-1)).toMatchObject({
      kind: 'assistant',
      threads: { action: 'opened', threadIds: threads.map((item) => item.id) },
      body: "Opened 2 chats on MacBook Pro and Ubuntu Dev. I'll report back once both finish.",
    })
    expect(entries.at(-1)).toMatchObject({ process: [{ kind: 'command', deviceId: 'dev-mac' }, {}, {}] })
    expect(await client.listProjectMemory(project.id)).toHaveLength(2)

    scheduler.advance(browserLatency.run / 2)
    expect((await client.listProjects()).find((item) => item.id === project.id)!.agent.state).toBe('idle')
    scheduler.advance(browserLatency.run / 2)
    expect((await client.listProjects()).find((item) => item.id === project.id)!.agent.activity).toBe(
      "Reading Codex's reply from MacBook Pro…",
    )
    scheduler.advance(browserLatency.run / 2)
    entries = await client.listProjectEntries(project.id)
    expect(entries.at(-1)).toMatchObject({
      kind: 'assistant',
      threads: { action: 'replies', threadIds: threads.map((item) => item.id) },
    })
    expect(entries.at(-1)!.kind === 'assistant' && entries.at(-1)!.body).toMatch(/^Both chats finished\./)
    scheduler.advance(browserLatency.run)
    expect(await client.listProjectEntries(project.id)).toHaveLength(entries.length)
  })

  it('wakes the assistant only for turns it started', async () => {
    const { client, scheduler } = setup()
    const project = await create(client, scheduler)
    await client.sendProjectMessage({ projectId: project.id, body: 'Fix the flaky test.', clientId: 'm1' })
    scheduler.advance(browserLatency.save + browserLatency.run * 2)
    const [thread] = (await client.listThreads()).filter((item) => item.projectId === project.id)
    let entries = await client.listProjectEntries(project.id)
    const reported = entries.length
    expect(entries.at(-1)).toMatchObject({ threads: { action: 'replies' } })

    // 你在助手开的 Thread 里发的消息，回复不交给助手。
    await client.sendMessage({ threadId: thread.id, body: 'Also update the changelog.', clientId: 't1' })
    scheduler.advance(browserLatency.save + browserLatency.run * 2)
    entries = await client.listProjectEntries(project.id)
    expect(entries).toHaveLength(reported)
    expect((await client.listProjects()).find((item) => item.id === project.id)!.agent.state).toBe('idle')
  })

  it('reports a stopped thread back to the assistant', async () => {
    const { client, scheduler } = setup()
    const project = await create(client, scheduler)
    await client.sendProjectMessage({ projectId: project.id, body: 'Fix the flaky test.', clientId: 'm1' })
    scheduler.advance(browserLatency.save + browserLatency.run / 2)
    const [thread] = (await client.listThreads()).filter((item) => item.projectId === project.id)
    await client.stopThread(thread.id)
    scheduler.advance(browserLatency.save + browserLatency.device + browserLatency.run / 2)
    expect((await client.listProjectEntries(project.id)).at(-1)).toMatchObject({
      body: 'Codex on MacBook Pro stopped before replying.',
    })
  })

  it('keeps messages waiting while no device can run the assistant', async () => {
    const { client, scheduler } = setup('waiting')
    const docs = (await client.listProjects()).find((item) => item.id === 'prj-docs')!
    expect(docs.agent).toMatchObject({ state: 'waitingDevice', reason: 'An online device with Claude signed in' })
    const devices = await client.listDevices()
    expect(assistantWait(docs, devices).detail).toBe(
      'Sign in to Claude on MacBook Pro. Sign in to Claude on Ubuntu Dev. The project assistant is not installed on Windows Desktop. Your message stays saved.',
    )
    await client.sendProjectMessage({ projectId: 'prj-docs', body: 'Check the install guide.', clientId: 'm1' })
    scheduler.advance(browserLatency.run * 4)
    expect((await client.listProjectEntries('prj-docs')).map((item) => item.kind === 'user' && item.delivery)).toEqual([
      'waitingDevice',
      'waitingDevice',
    ])
  })

  it('switches device with a note and resumes after reconnect', async () => {
    const { client, scheduler } = setup()
    client.controls.setDeviceConnection('dev-ubuntu', 'offline')
    expect((await client.listProjectEntries('prj-baton')).at(-1)).toMatchObject({
      kind: 'note',
      body: 'Switched to MacBook Pro because Ubuntu Dev is offline.',
    })
    client.controls.setDeviceConnection('dev-mac', 'offline')
    expect((await client.listProjects()).find((item) => item.id === 'prj-baton')!.agent.state).toBe('waitingDevice')
    client.controls.setDeviceConnection('dev-ubuntu', 'online')
    expect((await client.listProjects()).find((item) => item.id === 'prj-baton')!.agent).toMatchObject({
      state: 'running',
      deviceId: 'dev-ubuntu',
    })
    // 恢复后接着运行，Ubuntu Dev 上的 Thread 回复后再汇报一次。
    scheduler.advance(browserLatency.run * 2)
    expect((await client.listProjects()).find((item) => item.id === 'prj-baton')!.agent.state).toBe('idle')
    expect((await client.listProjectEntries('prj-baton')).at(-1)).toMatchObject({
      threads: { action: 'replies', threadIds: ['thr-gateway'] },
    })
  })

  it('stops the assistant run without stopping its threads', async () => {
    const { client, scheduler } = setup()
    await expect(client.stopProjectRun('prj-compat')).rejects.toMatchObject({ code: 'invalid' })
    const stopping = await client.stopProjectRun('prj-baton')
    expect(stopping.agent.state).toBe('stopping')
    scheduler.advance(browserLatency.device)
    const baton = (await client.listProjects()).find((item) => item.id === 'prj-baton')!
    expect(baton.agent).toMatchObject({ state: 'stopped', reason: null })
    expect((await client.listThreads()).find((item) => item.id === 'thr-gateway')!.status).toBe('running')
    expect((await client.listProjectEntries('prj-baton')).at(-1)).toMatchObject({ kind: 'note' })

    // 停止后 Thread 的结果等下一条消息一起读。
    scheduler.advance(browserLatency.run)
    expect((await client.listProjects()).find((item) => item.id === 'prj-baton')!.agent.state).toBe('stopped')
    await client.sendProjectMessage({ projectId: 'prj-baton', body: 'What changed?', clientId: 'm1' })
    scheduler.advance(browserLatency.save)
    expect((await client.listProjects()).find((item) => item.id === 'prj-baton')!.agent.state).toBe('running')
  })
})
