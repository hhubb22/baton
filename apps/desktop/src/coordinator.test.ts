import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'
import { linkDecision, loadCoordinator, parseConnectLink, saveCoordinator } from './coordinator.ts'

it('accepts only a bare HTTPS origin from a connect link', () => {
  expect(parseConnectLink('baton://connect?url=https%3A%2F%2Fcenter.test')).toBe('https://center.test')
  expect(parseConnectLink('baton://connect?url=https%3A%2F%2Fcenter.test%3A8443')).toBe('https://center.test:8443')
  expect(parseConnectLink('baton://connect/?url=https://center.test')).toBe('https://center.test')
  for (const link of [
    'baton://connect?url=http%3A%2F%2Fcenter.test',
    'baton://connect?url=https%3A%2F%2Fcenter.test%2Fpath',
    'baton://connect?url=https%3A%2F%2Fcenter.test%3Fquery',
    'baton://connect?url=https%3A%2F%2Fuser%3Apass%40center.test',
    'baton://connect?url=https%3A%2F%2Fcenter.test&ca=value',
    'baton://connect?url=https%3A%2F%2Fcenter.test&url=https%3A%2F%2Fcenter.test',
    'baton://connect?url=',
    'baton://connect',
    'baton://connect?url=https%3A%2F%2Fcenter.test#fragment',
    'https://center.test',
  ])
    expect(() => parseConnectLink(link)).toThrow()
})

it('stores the coordinator with private permissions and reloads it', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'desktop-coordinator-'))
  try {
    await saveCoordinator(userData, 'https://center.test')
    expect(await loadCoordinator(userData)).toEqual({ format: 1, coordinator_url: 'https://center.test' })
    expect((await stat(join(userData, 'coordinator.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(userData, 'coordinator.json'), 'utf8'))).toEqual({
      format: 1,
      coordinator_url: 'https://center.test',
    })
    await saveCoordinator(userData, 'https://other.test:8443')
    expect(await loadCoordinator(userData)).toEqual({ format: 1, coordinator_url: 'https://other.test:8443' })
    expect((await stat(join(userData, 'coordinator.json'))).mode & 0o777).toBe(0o600)
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

it('rejects a malformed saved coordinator or an invalid replacement', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'desktop-coordinator-'))
  try {
    expect(await loadCoordinator(userData)).toBeUndefined()
    await expect(saveCoordinator(userData, 'http://center.test')).rejects.toThrow()
    await writeFile(join(userData, 'coordinator.json'), '{"format":1,"coordinator_url":"http://center.test"}')
    await expect(loadCoordinator(userData)).rejects.toThrow()
    await chmod(join(userData, 'coordinator.json'), 0o600)
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

it('refuses to replace a bound center but replaces an unbound saved address', () => {
  expect(linkDecision('https://center.test', 'https://center.test', 'https://center.test')).toBe('use')
  expect(linkDecision('https://old.test', undefined, 'https://center.test')).toBe('replace')
  expect(linkDecision('https://old.test', 'https://other.test', 'https://center.test')).toBe('conflict')
  expect(linkDecision(undefined, 'https://other.test', 'https://center.test')).toBe('conflict')
  expect(linkDecision(undefined, undefined, 'https://center.test')).toBe('use')
})
