import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'
import { mergeStatus, readDaemonStatus, type PublicIdentity } from './status.ts'
import { assertIdentityOrigin, authorizeBridge } from './bridge.ts'

const identity: PublicIdentity = {
  registered: true,
  coordinator_url: 'https://center.test',
  node_id: 'node',
  display_name: 'Local',
  system: 'macos',
}
const online = { pid: 42, state: 'online' as const, updated_at: '2026-10-27T00:00:00Z' }
it('合并当前进程的连接状态，拒绝状态不会被旧文件覆盖', () => {
  expect(mergeStatus({ registered: false }, { state: 'stopped' }).state).toBe('unregistered')
  expect(mergeStatus(identity, { state: 'connecting', pid: 42 }, online).state).toBe('online')
  expect(mergeStatus(identity, { state: 'connecting', pid: 43 }, online).state).toBe('connecting')
  expect(mergeStatus(identity, { state: 'rejected', code: 'needs_reauth' }, online)).toMatchObject({
    state: 'rejected',
    code: 'needs_reauth',
  })
  expect(mergeStatus(identity, { state: 'external' }, online)).toMatchObject({
    state: 'external',
    connection_state: 'online',
  })
})

it('状态文件必须与活跃 daemon.lock 中的 PID 一致', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-status-'))
  try {
    expect(await readDaemonStatus(directory)).toBeUndefined()
    await writeFile(join(directory, 'daemon-status.json'), JSON.stringify(online))
    expect(await readDaemonStatus(directory, () => true)).toBeUndefined()
    await mkdir(join(directory, 'daemon.lock'))
    const token = '12345678-1234-1234-1234-123456789012'
    const file = join(directory, 'daemon.lock', `${token}.json`)
    await writeFile(file, JSON.stringify({ pid: 42, token }))
    expect(await readDaemonStatus(directory, () => true)).toEqual(online)
    expect(await readDaemonStatus(directory, () => false)).toBeUndefined()
    await writeFile(file, JSON.stringify({ pid: 43, token }))
    expect(await readDaemonStatus(directory, () => true)).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('只有中心主页面可调用桥接，已有其他中心身份会拒绝替换', () => {
  expect(() => authorizeBridge('https://center.test/devices', 'https://center.test', true)).not.toThrow()
  for (const url of [
    'https://other.test',
    'https://center.test.evil.test',
    'file:///tmp/setup.html',
    'data:text/html,hello',
  ])
    expect(() => authorizeBridge(url, 'https://center.test', true)).toThrow()
  expect(() => authorizeBridge('https://center.test', 'https://center.test', false)).toThrow()
  expect(() => assertIdentityOrigin(identity, 'https://other.test')).toThrow('本机已接入')
  expect(() => assertIdentityOrigin(identity, 'https://center.test')).not.toThrow()
  expect(() => assertIdentityOrigin({ registered: false }, 'https://other.test')).not.toThrow()
})
