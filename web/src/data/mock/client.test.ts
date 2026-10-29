import { describe, expect, it } from 'vite-plus/test'
import type { ChangeEvent } from '../client'
import { assistantWait, previewProblem, projectAgentStatus, threadView } from '../derive'
import { previewLimit, type ItemDecision } from '../types'
import { createMockClient } from './client'
import { scenarioIds } from './scenarios'
import { manualScheduler } from './scheduler'
import { browserLatency } from './store'

function setup(scenario: Parameters<typeof createMockClient>[0] = 'normal') {
  const scheduler = manualScheduler()
  const client = createMockClient(scenario, { scheduler, latency: { ...browserLatency, read: 0, save: 0 } })
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

describe('mock downloads', () => {
  it.each(['downloads', 'noDownloads'] as const)(
    'serves the %s manifest without a signed-in account',
    async (scenario) => {
      const { client } = setup(scenario)
      await client.signOut()
      const downloads = await client.getDownloads()
      expect(downloads.enabled).toBe(scenario === 'downloads')
      if (scenario === 'downloads') {
        expect(downloads.connect_url).toMatch(/^baton:\/\/connect\?url=/)
        expect(downloads.items.filter((item) => item.kind === 'cli').map((item) => item.platform)).toEqual([
          'darwin',
          'linux',
          'linux',
        ])
        expect(downloads.items.filter((item) => item.kind === 'desktop').map((item) => item.platform)).toEqual([
          'darwin',
          'win32',
        ])
        expect(downloads.items.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true)
        Object.assign(downloads, { items: [] })
        expect((await client.getDownloads()).items).toHaveLength(5)
      } else {
        expect(downloads).toMatchObject({ items: [], connect_url: null, ca_sha256: null })
      }
    },
  )
})

describe('mock scenarios', () => {
  it('replays project preview, saved reply and tool result after reset', async () => {
    const { client, scheduler } = setup('streamingProject')
    expect((await client.listProjectEntries('prj-compat')).map((entry) => entry.id)).toEqual(['ent-compat-1'])
    scheduler.advance(1600)
    expect(await client.listProjectEntries('prj-compat')).toContainEqual(
      expect.objectContaining({ process: [expect.objectContaining({ status: 'pending' })] }),
    )
    scheduler.advance(2400)
    expect(await client.listProjectEntries('prj-compat')).toContainEqual(
      expect.objectContaining({ process: expect.arrayContaining([expect.objectContaining({ kind: 'note' })]) }),
    )
    scheduler.advance(3000)
    const partial = (await client.listProjects()).find((project) => project.id === 'prj-compat')!
    expect(partial.agent.preview?.text).toContain('Opened')
    scheduler.advance(60000)
    const entries = await client.listProjectEntries('prj-compat')
    expect(entries).toContainEqual(expect.objectContaining({ body: expect.stringContaining('2 failures') }))
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.agent.state).toBe('idle')
    client.controls.reset()
    expect((await client.listProjectEntries('prj-compat')).map((entry) => entry.id)).toEqual(['ent-compat-1'])
  })

  it('streams Markdown and restarts it on reset', async () => {
    const { client, scheduler } = setup('streamingMarkdown')
    expect((await client.listMessages('thr-webui'))[0]).toMatchObject({ body: '', streaming: true })
    scheduler.advance(1600)
    const partial = (await client.listMessages('thr-webui'))[0]
    expect(partial.body).toContain('检查结果')
    expect(partial.streaming).toBe(true)
    scheduler.advance(60000)
    const complete = (await client.listMessages('thr-webui'))[0]
    expect(complete.body).toContain('```sh')
    expect(complete.streaming).toBe(false)
    client.controls.reset()
    expect((await client.listMessages('thr-webui'))[0]).toMatchObject({ body: '', streaming: true })
  })

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

describe('device settings', () => {
  it('supports Windows folders and preserves directory contents across removal and re-adding', async () => {
    const { client, events } = setup()
    client.controls.setDeviceConnection('dev-windows', 'online')
    const path = 'D:' + String.fromCharCode(92) + 'projects'
    await client.addDeviceFolder({ deviceId: 'dev-windows', path: '  ' + path + '  ' })
    await client.addDeviceFolder({ deviceId: 'dev-windows', path })
    const device = (await client.listDevices()).find((item) => item.id === 'dev-windows')!
    expect(device.folders.filter((folder) => folder === path)).toHaveLength(1)
    expect(await client.listFolders(device.id, path)).toMatchObject({ state: 'ready', folders: [] })
    await client.removeDeviceFolder({ deviceId: device.id, path })
    expect(await client.listFolders(device.id, path)).toMatchObject({ state: 'unavailable', reason: 'outsideFolders' })
    await client.addDeviceFolder({ deviceId: device.id, path })
    expect(await client.listFolders(device.id, path)).toMatchObject({ state: 'ready' })
    expect(events.at(-1)?.topics).toEqual(['devices', 'files'])
    await expect(client.addDeviceFolder({ deviceId: device.id, path: 'relative' })).rejects.toMatchObject({
      code: 'invalid',
    })
    client.controls.setDeviceConnection(device.id, 'offline')
    await expect(client.removeDeviceFolder({ deviceId: device.id, path })).rejects.toMatchObject({
      code: 'unavailable',
    })
  })

  it('only completes an xAI subscription after the device reports sign-in', async () => {
    const { client, events } = setup()
    const challenge = await client.startSubscriptionLogin({ deviceId: 'dev-ubuntu', provider: 'xai' })
    expect(challenge).toEqual({
      provider: 'xAI',
      verificationUri: 'https://auth.x.ai/activate',
      userCode: 'BATON-1234',
      expiresInSeconds: 900,
    })
    expect(
      (await client.listDevices())
        .find((item) => item.id === 'dev-ubuntu')!
        .subscriptions.some((sub) => sub.provider === 'xAI' && sub.signedIn),
    ).toBe(false)
    client.controls.completeSubscriptionLogin('dev-ubuntu', 'xai')
    expect((await client.listDevices()).find((item) => item.id === 'dev-ubuntu')!.subscriptions).toContainEqual({
      provider: 'xAI',
      signedIn: true,
      status: 'available',
    })
    expect(events.at(-1)?.topics).toEqual(['devices', 'projects'])
  })
})

describe('file preview chunks', () => {
  it('reads the complete mock file in UTF-8 fragments and requires the same version', async () => {
    const { client } = setup()
    const path = '/home/kaken/work/baton/logs/gateway-soak.log'
    let chunk = await client.readFile('dev-ubuntu', path)
    if (chunk.state !== 'ready') throw new Error('Expected a text preview')
    const version = chunk.version
    const size = chunk.size
    let content = chunk.content
    expect(chunk.nextOffset).toBeGreaterThan(0)
    while (chunk.nextOffset != null) {
      const offset = chunk.nextOffset
      expect(new TextEncoder().encode(chunk.content).length).toBeLessThanOrEqual(previewLimit)
      expect(chunk.content).not.toContain('�')
      chunk = await client.readFile('dev-ubuntu', path, { offset, version })
      if (chunk.state !== 'ready') throw new Error('Expected the next text fragment')
      expect(chunk.offset).toBe(offset)
      content += chunk.content
    }
    expect(new TextEncoder().encode(content).length).toBe(size)
    expect(content).not.toContain('�')
    expect(content).toContain('soak 01600')
    await expect(client.readFile('dev-ubuntu', path, { offset: 1, version: 'different' })).rejects.toMatchObject({
      code: 'conflict',
    })
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
    expect(threadView(gateway, ubuntu).notice?.title).toBe('Ubuntu Dev 已离线')

    const baton = projects.find((item) => item.id === 'prj-baton')!
    expect(baton.agent.state).toBe('waitingDevice')
    expect(projectAgentStatus(baton, devices).label).toBe('等待设备')

    const preview = await client.readFile('dev-ubuntu', '/home/kaken/work/baton/apps/server/src/gateway.ts')
    expect(preview.state).toBe('unavailable')
    expect(previewProblem(preview, ubuntu)?.title).toBe('Ubuntu Dev 已离线')

    expect(events.at(-1)?.topics).toEqual(expect.arrayContaining(['devices', 'threads', 'projects', 'files']))

    client.controls.setDeviceConnection('dev-ubuntu', 'online')
    const after = await state(client)
    expect(after.projects.find((item) => item.id === 'prj-baton')!.agent).toMatchObject({
      state: 'running',
      deviceId: 'dev-ubuntu',
    })
    expect((await client.readFile('dev-ubuntu', '/home/kaken/work/baton/apps/server/src/gateway.ts')).state).toBe(
      'ready',
    )
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
    expect(await client.getOperation(resume.id)).toMatchObject({ phase: 'failed', detail: 'Thread history not found' })
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

  it('rejects reads after sign out and accepts mock credentials', async () => {
    const { client } = setup('signedOut')
    await expect(client.listThreads()).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(client.signIn('kaken', 'wrong')).rejects.toMatchObject({ code: 'unauthorized' })
    await client.signIn('kaken', 'example-password')
    expect(await client.listThreads()).not.toHaveLength(0)
  })
})

describe('inbox decisions', () => {
  async function item(client: ReturnType<typeof createMockClient>, id = 'itm-compat-paths') {
    return (await client.listInbox()).find((entry) => entry.id === id)!
  }

  async function inputs(client: ReturnType<typeof createMockClient>, projectId = 'prj-compat') {
    return (await client.listProjectEntries(projectId)).filter((entry) => entry.kind === 'user')
  }

  it.each([
    { itemId: 'itm-compat-paths', option: 'Fix them before merging', note: '  Include Windows support.  ' },
    { itemId: 'itm-compat-notes', option: null, note: '  Mention the drive-letter fix.\nKeep the nightly runner.  ' },
  ])('saves the answer and one linked project input for $itemId', async ({ itemId, option, note }) => {
    const { client, scheduler, events } = setup('inbox')
    const before = await item(client, itemId)
    const previousInputs = await inputs(client)
    const account = (await client.getSession()).account!
    const op = await client.handleItem({
      itemId,
      decision: { kind: 'answer', option, note },
      revision: before.revision,
    })

    expect(op).toMatchObject({ targetId: itemId, phase: 'done' })
    expect(await client.getOperation(op.id)).toEqual(op)
    const answered = await item(client, itemId)
    expect(answered).toMatchObject({
      status: 'answered',
      revision: before.revision + 1,
      result: { option, note: note.trim(), actor: account.name, at: scheduler.now(), reason: null },
    })
    expect(answered.result!.inputId).toEqual(expect.any(String))
    const after = await inputs(client)
    expect(after).toHaveLength(previousInputs.length + 1)
    expect(after.at(-1)).toMatchObject({
      id: answered.result!.inputId,
      projectId: before.projectId,
      body: `Question ${itemId}: ${before.title}\n${[option, note.trim()].filter(Boolean).join('\n')}`,
      delivery: 'delivered',
    })
    expect((await client.listProjects()).find((entry) => entry.id === before.projectId)!.agent.state).toBe('running')
    expect(events.at(-1)?.topics).toEqual(expect.arrayContaining(['inbox', 'projects', 'operations']))
  })

  it.each(['a'.repeat(4096), '界'.repeat(1365) + 'a', '🙂'.repeat(1024)])(
    'accepts a reply at the 4 KiB UTF-8 boundary (case %#)',
    async (note) => {
      const { client } = setup('inbox')
      expect(new TextEncoder().encode(note)).toHaveLength(4096)
      const op = await client.handleItem({
        itemId: 'itm-compat-notes',
        decision: { kind: 'answer', option: null, note },
        revision: 1,
      })
      expect(op.phase).toBe('done')
      expect((await item(client, 'itm-compat-notes')).result!.note).toBe(note)
      expect((await inputs(client)).at(-1)!.body).toContain(note)
    },
  )

  it.each([
    { option: null, note: 'a'.repeat(4097) },
    { option: null, note: '界'.repeat(1365) + 'ab' },
    { option: 'Fix them before merging', note: '🙂'.repeat(1024) + 'a' },
    { option: null, note: ' \n\t ' },
    { option: 'Undeclared option', note: '' },
  ])('rejects invalid answers without changing the item or inputs (case %#)', async (decision) => {
    const { client } = setup()
    const before = await item(client)
    const previousInputs = await inputs(client)
    await expect(
      client.handleItem({
        itemId: before.id,
        decision: { kind: 'answer', ...decision },
        revision: before.revision,
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(await item(client)).toEqual(before)
    expect(await inputs(client)).toEqual(previousInputs)
  })

  it('requires an option when allowText is false and still accepts an attached note', async () => {
    const { client } = setup()
    const before = await item(client, 'itm-compat-runner')
    const previousInputs = await inputs(client)
    expect(before.allowText).toBe(false)
    await expect(
      client.handleItem({
        itemId: before.id,
        decision: { kind: 'answer', option: null, note: 'Use Ubuntu Dev.' },
        revision: before.revision,
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(await item(client, before.id)).toEqual(before)
    expect(await inputs(client)).toEqual(previousInputs)

    expect(
      (
        await client.handleItem({
          itemId: before.id,
          decision: { kind: 'answer', option: 'Ubuntu Dev', note: 'Keep it running overnight.' },
          revision: before.revision,
        })
      ).phase,
    ).toBe('done')
    const answered = await item(client, before.id)
    expect(answered).toMatchObject({
      status: 'answered',
      revision: before.revision + 1,
      result: { option: 'Ubuntu Dev', note: 'Keep it running overnight.' },
    })
    expect(await inputs(client)).toHaveLength(previousInputs.length + 1)
    expect((await inputs(client)).at(-1)).toMatchObject({
      id: answered.result!.inputId,
      body: `Question ${before.id}: ${before.title}\nUbuntu Dev\nKeep it running overnight.`,
    })
  })

  it('closes an ordinary question and creates one linked project input', async () => {
    const { client, scheduler } = setup()
    const before = await item(client)
    const previousInputs = await inputs(client)
    const op = await client.handleItem({ itemId: before.id, decision: { kind: 'close' }, revision: before.revision })
    expect(op.phase).toBe('done')
    const closed = await item(client)
    expect(closed).toMatchObject({
      status: 'closed',
      revision: before.revision + 1,
      result: {
        option: null,
        note: '',
        actor: (await client.getSession()).account!.name,
        at: scheduler.now(),
        reason: null,
      },
    })
    expect(closed.result!.inputId).toEqual(expect.any(String))
    expect(await inputs(client)).toHaveLength(previousInputs.length + 1)
    expect((await inputs(client)).at(-1)).toMatchObject({
      id: closed.result!.inputId,
      body: `Question ${before.id}: ${before.title}\nClosed question`,
    })
  })

  it.each([
    ['answer', 'answer'],
    ['close', 'close'],
    ['answer', 'close'],
    ['close', 'answer'],
  ] as const)('saves only the first concurrent %s / %s decision', async (first, second) => {
    const { client, scheduler } = setup()
    const before = await item(client)
    const previousInputs = await inputs(client)
    const decision = (kind: 'answer' | 'close', option: string): ItemDecision =>
      kind === 'close' ? { kind } : { kind, option, note: '' }
    const [winner, loser] = await Promise.all([
      client.handleItem({ itemId: before.id, decision: decision(first, before.options[0]), revision: before.revision }),
      client.handleItem({
        itemId: before.id,
        decision: decision(second, before.options[1]),
        revision: before.revision,
      }),
    ])
    expect(winner.phase).toBe('done')
    expect(loser).toMatchObject({
      phase: 'conflict',
      detail: first === 'answer' ? `Already answered: ${before.options[0]}` : 'Already handled',
    })
    const handled = await item(client)
    expect(handled).toMatchObject({
      status: first === 'answer' ? 'answered' : 'closed',
      revision: before.revision + 1,
      result: { option: first === 'answer' ? before.options[0] : null, note: '' },
    })
    expect(await inputs(client)).toHaveLength(previousInputs.length + 1)
    expect((await inputs(client)).at(-1)!.id).toBe(handled.result!.inputId)
    scheduler.advance(browserLatency.run * 4)
    expect(await item(client)).toEqual(handled)
    expect(await inputs(client)).toHaveLength(previousInputs.length + 1)
  })

  it('rejects a stale revision while leaving a pending question untouched', async () => {
    const { client } = setup()
    const before = await item(client)
    const previousInputs = await inputs(client)
    expect((await client.handleItem({ itemId: before.id, decision: { kind: 'close' }, revision: 0 })).phase).toBe(
      'conflict',
    )
    expect(await item(client)).toEqual(before)
    expect(await inputs(client)).toEqual(previousInputs)
  })

  it('reports a conflict and applies only the answer saved elsewhere', async () => {
    const { client } = setup('conflict')
    const before = await item(client)
    const previousInputs = await inputs(client)
    const op = await client.handleItem({
      itemId: before.id,
      decision: { kind: 'answer', option: 'Skip them and open a follow-up', note: '' },
      revision: before.revision,
    })
    expect(op).toMatchObject({ phase: 'conflict', detail: 'Already answered: Fix them before merging' })
    expect(await client.getOperation(op.id)).toEqual(op)
    const answered = await item(client)
    expect(answered).toMatchObject({
      status: 'answered',
      revision: before.revision + 1,
      result: { option: 'Fix them before merging', note: '' },
    })
    expect(await inputs(client)).toHaveLength(previousInputs.length + 1)
    expect((await inputs(client)).at(-1)).toMatchObject({
      id: answered.result!.inputId,
      body: `Question ${before.id}: ${before.title}\nFix them before merging`,
      delivery: 'delivered',
    })
    expect((await client.handleItem({ itemId: before.id, decision: { kind: 'close' }, revision: 1 })).phase).toBe(
      'conflict',
    )
    expect(await item(client)).toEqual(answered)
    expect(await inputs(client)).toHaveLength(previousInputs.length + 1)
  })

  it.each(['answer', 'close'] as const)('keeps a concurrent withdrawal when trying to %s', async (kind) => {
    const { client, scheduler } = setup('inboxWithdrawn')
    const before = await item(client)
    const previousInputs = await inputs(client)
    const decision: ItemDecision = kind === 'close' ? { kind } : { kind, option: before.options[0], note: '' }
    expect((await client.handleItem({ itemId: before.id, decision, revision: before.revision })).phase).toBe('conflict')
    const withdrawn = await item(client)
    expect(withdrawn).toMatchObject({
      status: 'withdrawn',
      revision: before.revision + 1,
      result: {
        option: null,
        note: '',
        actor: 'Project assistant',
        at: scheduler.now(),
        reason: 'A newer test run replaced this question.',
        inputId: null,
      },
    })
    scheduler.advance(browserLatency.run * 4)
    expect(await item(client)).toEqual(withdrawn)
    expect(await inputs(client)).toEqual(previousInputs)
  })

  it.each([
    ['offline', 'answer'],
    ['offline', 'close'],
    ['inboxPaused', 'answer'],
    ['inboxPaused', 'close'],
  ] as const)('keeps the input saved in %s after %s', async (scenario, kind) => {
    const { client, scheduler } = setup(scenario)
    if (scenario === 'offline') {
      for (const device of await client.listDevices()) client.controls.setDeviceConnection(device.id, 'offline')
      expect((await client.listDevices()).every((device) => device.connection === 'offline')).toBe(true)
    }
    const before = await item(client)
    const previousInputs = await inputs(client)
    const decision: ItemDecision =
      kind === 'close' ? { kind } : { kind, option: before.options[0], note: 'Keep this decision.' }
    expect((await client.handleItem({ itemId: before.id, decision, revision: before.revision })).phase).toBe('done')
    const handled = await item(client)
    expect(handled).toMatchObject({ status: kind === 'answer' ? 'answered' : 'closed', revision: before.revision + 1 })
    expect(handled.result!.inputId).toEqual(expect.any(String))
    scheduler.advance(browserLatency.run * 4)
    expect(await inputs(client)).toHaveLength(previousInputs.length + 1)
    expect((await inputs(client)).at(-1)).toMatchObject({
      id: handled.result!.inputId,
      delivery: scenario === 'offline' ? 'waitingDevice' : 'saved',
    })
    const project = (await client.listProjects()).find((entry) => entry.id === before.projectId)!
    expect(project).toMatchObject(
      scenario === 'offline'
        ? { status: 'active', agent: { state: 'waitingDevice' } }
        : { status: 'paused', agent: { state: 'idle' } },
    )

    if (scenario === 'offline') {
      client.controls.setDeviceConnection('dev-mac', 'online')
      expect((await inputs(client)).at(-1)).toMatchObject({ id: handled.result!.inputId, delivery: 'delivered' })
      expect((await client.listProjects()).find((entry) => entry.id === before.projectId)!.agent.state).toBe('running')
      scheduler.advance(browserLatency.run * 4)
      expect(await inputs(client)).toHaveLength(previousInputs.length + 1)
    }
    expect(await item(client)).toEqual(handled)
  })

  it('leaves a failed save untouched and creates one input on retry', async () => {
    const { client } = setup('error')
    const before = await item(client)
    const previousInputs = await inputs(client)
    const request = {
      itemId: before.id,
      decision: { kind: 'answer', option: before.options[0], note: 'Keep my note.' } as const,
      revision: before.revision,
    }
    await expect(client.handleItem(request)).rejects.toMatchObject({ code: 'unavailable' })
    expect(await item(client)).toEqual(before)
    expect(await inputs(client)).toEqual(previousInputs)
    expect((await client.handleItem(request)).phase).toBe('done')
    expect(await item(client)).toMatchObject({
      status: 'answered',
      revision: before.revision + 1,
      result: { option: before.options[0], note: 'Keep my note.' },
    })
    expect(await inputs(client)).toHaveLength(previousInputs.length + 1)
  })

  it.each([null, 'Retry now'])('rejects answering a system item with option %s', async (option) => {
    const { client } = setup('error')
    const before = await item(client, 'itm-baton-signin')
    const entries = await client.listProjectEntries(before.projectId)
    const project = (await client.listProjects()).find((entry) => entry.id === before.projectId)!
    await expect(
      client.handleItem({
        itemId: before.id,
        decision: { kind: 'answer', option, note: 'Retry now.' },
        revision: before.revision,
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(await item(client, before.id)).toEqual(before)
    expect(await client.listProjectEntries(before.projectId)).toEqual(entries)
    expect((await client.listProjects()).find((entry) => entry.id === before.projectId)).toEqual(project)
  })

  it('closes a system item without input and keeps messages behind the project block', async () => {
    const { client, scheduler } = setup('error')
    const before = await item(client, 'itm-baton-signin')
    const entries = await client.listProjectEntries(before.projectId)
    const blocked = (await client.listProjects()).find((entry) => entry.id === before.projectId)!.agent
    const request = { itemId: before.id, decision: { kind: 'close' } as const, revision: before.revision }
    await expect(client.handleItem(request)).rejects.toMatchObject({ code: 'unavailable' })
    expect(await item(client, before.id)).toEqual(before)
    expect(await client.listProjectEntries(before.projectId)).toEqual(entries)
    expect((await client.handleItem(request)).phase).toBe('done')
    const closed = await item(client, before.id)
    expect(closed).toMatchObject({
      status: 'closed',
      revision: before.revision + 1,
      result: {
        option: null,
        note: '',
        actor: (await client.getSession()).account!.name,
        at: scheduler.now(),
        inputId: null,
      },
    })
    expect(await client.listProjectEntries(before.projectId)).toEqual(entries)
    expect((await client.listProjects()).find((entry) => entry.id === before.projectId)!.agent).toEqual(blocked)

    const message = await client.sendProjectMessage({
      projectId: before.projectId,
      body: 'Continue when ready.',
      clientId: 'blocked-message',
    })
    scheduler.advance(browserLatency.run * 4)
    expect((await client.listProjects()).find((entry) => entry.id === before.projectId)!.agent).toEqual(blocked)
    expect(await client.listProjectEntries(before.projectId)).toEqual([
      ...entries,
      expect.objectContaining({ id: message.id, kind: 'user', delivery: 'saved' }),
    ])
    expect(await item(client, before.id)).toEqual(closed)
    expect(
      (await client.listInbox()).filter((entry) => entry.projectId === before.projectId && entry.kind === 'system'),
    ).toEqual([closed])

    expect((await client.retryProject(before.projectId)).agent.state).toBe('running')
    expect(await item(client, before.id)).toEqual(closed)
    expect(await inputs(client, before.projectId)).toHaveLength(
      entries.filter((entry) => entry.kind === 'user').length + 1,
    )
    expect((await inputs(client, before.projectId)).at(-1)).toMatchObject({ id: message.id, delivery: 'delivered' })
  })

  it('keeps a failed retry blocked, then resolves the system item when a device is ready without input', async () => {
    const { client, scheduler } = setup('error')
    client.controls.setDeviceConnection('dev-mac', 'offline')
    const before = await item(client, 'itm-baton-signin')
    const entries = await client.listProjectEntries(before.projectId)
    const blocked = (await client.listProjects()).find((entry) => entry.id === before.projectId)!.agent
    await expect(client.retryProject(before.projectId)).rejects.toMatchObject({ code: 'invalid' })
    expect(await item(client, before.id)).toEqual(before)
    expect((await client.listProjects()).find((entry) => entry.id === before.projectId)!.agent).toEqual(blocked)
    expect(await client.listProjectEntries(before.projectId)).toEqual(entries)

    client.controls.setDeviceConnection('dev-mac', 'online')
    expect((await client.listProjects()).find((entry) => entry.id === before.projectId)!.agent).toEqual(blocked)
    expect((await client.retryProject(before.projectId)).agent).toMatchObject({
      state: 'running',
      deviceId: 'dev-mac',
      reason: null,
    })
    const resolved = await item(client, before.id)
    expect(resolved).toMatchObject({
      status: 'resolved',
      revision: before.revision + 1,
      result: {
        option: null,
        note: '',
        actor: (await client.getSession()).account!.name,
        at: scheduler.now(),
        reason: null,
        inputId: null,
      },
    })
    scheduler.advance(browserLatency.run * 4)
    expect(await inputs(client, before.projectId)).toEqual(entries.filter((entry) => entry.kind === 'user'))
    expect(await item(client, before.id)).toEqual(resolved)
    await client.retryProject(before.projectId)
    expect(await item(client, before.id)).toEqual(resolved)
    expect(await inputs(client, before.projectId)).toEqual(entries.filter((entry) => entry.kind === 'user'))
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
    ).rejects.toMatchObject({ code: 'invalid', message: '请输入项目名称。' })
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
      activity: '正在读取你的消息…',
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
      body: "Opened 2 threads on MacBook Pro and Ubuntu Dev. I'll report back once both finish.",
    })
    expect(entries.at(-1)).toMatchObject({ process: [{ kind: 'command', deviceId: 'dev-mac' }, {}, {}] })
    expect(await client.listProjectMemory(project.id)).toHaveLength(2)

    scheduler.advance(browserLatency.run / 2)
    expect((await client.listProjects()).find((item) => item.id === project.id)!.agent.state).toBe('idle')
    scheduler.advance(browserLatency.run / 2)
    expect((await client.listProjects()).find((item) => item.id === project.id)!.agent.activity).toBe(
      '正在读取 Codex 的回复…',
    )
    scheduler.advance(browserLatency.run / 2)
    entries = await client.listProjectEntries(project.id)
    expect(entries.at(-1)).toMatchObject({
      kind: 'assistant',
      threads: { action: 'replies', threadIds: threads.map((item) => item.id) },
    })
    expect(entries.at(-1)!.kind === 'assistant' && entries.at(-1)!.body).toMatch(/^Both threads finished\./)
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
    expect(docs.agent).toMatchObject({ state: 'waitingDevice', reason: '等待已登录 Claude 的在线设备' })
    const devices = await client.listDevices()
    expect(assistantWait(docs, devices).detail).toBe(
      '请在 MacBook Pro 上登录 Claude。 请在 Ubuntu Dev 上登录 Claude。 Windows Desktop 未安装项目助手。',
    )
    await client.sendProjectMessage({ projectId: 'prj-docs', body: 'Check the install guide.', clientId: 'm1' })
    scheduler.advance(browserLatency.run * 4)
    expect((await client.listProjectEntries('prj-docs')).map((item) => item.kind === 'user' && item.delivery)).toEqual([
      'waitingDevice',
      'waitingDevice',
    ])
  })

  it('wakes waiting work when the project switches to an available API connection', async () => {
    const { client, scheduler } = setup('modelSources')
    const project = await client.createProject({
      name: 'API',
      emoji: '🚀',
      goal: '',
      subscription: 'api-11111111-1111-4111-8111-111111111111',
      sourceNodeId: 'dev-ubuntu',
      model: 'local-model',
      clientId: 'api-project',
    })
    await client.sendProjectMessage({ projectId: project.id, body: 'Start', clientId: 'api-message' })
    scheduler.advance(0)
    expect((await client.listProjects()).find((item) => item.id === project.id)?.agent.state).toBe('waitingDevice')
    await client.updateProject({
      projectId: project.id,
      patch: {
        emoji: '🛠️',
        subscription: 'api-22222222-2222-4222-8222-222222222222',
        sourceNodeId: 'dev-ubuntu',
        model: 'claude-model',
      },
    })
    expect((await client.listProjects()).find((item) => item.id === project.id)?.emoji).toBe('🛠️')
    expect((await client.listProjects()).find((item) => item.id === project.id)?.agent).toMatchObject({
      state: 'running',
      deviceId: 'dev-ubuntu',
    })
    await client.updateProject({ projectId: project.id, patch: { model: 'another-model' } })
    expect((await client.listProjects()).find((item) => item.id === project.id)?.agent).toMatchObject({
      state: 'running',
      deviceId: 'dev-ubuntu',
    })
  })

  it('switches device with a note and resumes after reconnect', async () => {
    const { client, scheduler } = setup()
    client.controls.setDeviceConnection('dev-ubuntu', 'offline')
    expect((await client.listProjectEntries('prj-baton')).at(-1)).toMatchObject({
      kind: 'note',
      body: '已切换到 MacBook Pro · Ubuntu Dev 已离线',
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
