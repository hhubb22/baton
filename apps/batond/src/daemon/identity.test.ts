import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vite-plus/test'
import type { NodeIdentity } from '@baton/protocol'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { clearIdentity, coordinatorURL, loadCoordinatorCA, loadIdentity, saveDeviceIdentity } from './identity.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function identity(): NodeIdentity {
  return {
    node_id: randomUUID(),
    employee_id: randomUUID(),
    coordinator_url: 'https://coordinator.invalid',
    display_name: 'Offline node',
    system: 'linux',
    role: '',
    capabilities: [],
    registration_seq: 1,
    registered_at: '2026-01-01T00:00:00Z',
    credential: {
      id: randomUUID(),
      token: 'offline-token',
      version: 1,
      expires_at: '2099-01-01T00:00:00Z',
    },
  }
}

it('accepts only a bare HTTPS coordinator origin', () => {
  expect(coordinatorURL('https://center.test')).toBe('https://center.test')
  expect(coordinatorURL('https://center.test:8443')).toBe('https://center.test:8443')
  for (const value of [
    'http://center.test',
    'https://center.test/path',
    'https://center.test?query',
    'https://user:pass@center.test',
    'wss://center.test',
  ])
    expect(() => coordinatorURL(value)).toThrow()
})

it('saves a device identity under the lock and refuses silent replacement', async () => {
  const directory = await makePrivateTempDirectory('baton-identity-')
  temporary.push(directory)
  await writeFile(join(directory, 'coordinator-ca.pem'), 'stale-ca')
  const saved = await saveDeviceIdentity(directory, identity(), 'https://center.test')
  expect(saved.coordinator_url).toBe('https://center.test')
  expect(await loadIdentity(directory)).toEqual(saved)
  expect(await loadCoordinatorCA(directory)).toBeUndefined()
  await expect(saveDeviceIdentity(directory, identity(), 'https://center.test')).rejects.toThrow('logout_required')
  expect(await loadIdentity(directory)).toEqual(saved)
})

it('rejects a malformed identity and clears only the identity file', async () => {
  const directory = await makePrivateTempDirectory('baton-identity-')
  temporary.push(directory)
  await writeFile(join(directory, 'identity.json'), '{"node_id":"offline"}')
  await expect(loadIdentity(directory)).rejects.toThrow('节点身份无效')
  await clearIdentity(directory)
  const valid = identity()
  await saveDeviceIdentity(directory, valid, 'https://center.test')
  await clearIdentity(directory)
  await expect(loadIdentity(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(directory, 'identity.json')).catch(() => undefined)).toBeUndefined()
})

it('reads an explicit update CA before the saved coordinator CA', async () => {
  const directory = await makePrivateTempDirectory('baton-identity-')
  temporary.push(directory)
  await writeFile(join(directory, 'coordinator-ca.pem'), 'saved-ca')
  expect(await loadCoordinatorCA(directory)).toBe('saved-ca')
  const explicit = join(directory, 'explicit.pem')
  await writeFile(explicit, 'explicit-ca')
  expect(await loadCoordinatorCA(directory, explicit)).toBe('explicit-ca')
})
