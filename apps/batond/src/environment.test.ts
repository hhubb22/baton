import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'
import {
  applyEnvironment,
  importEnvironment,
  initializeEnvironment,
  loadEnvironment,
  resolveEnvironment,
  updateEnvironment,
} from './environment.ts'
import { runEnvironmentCLI } from './environment-cli.ts'

it('keeps imports across installation and separates proxy credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-env-'))
  try {
    const first = await initializeEnvironment(directory, {
      PATH: '/first',
      HTTPS_PROXY: 'http://user:pass@localhost:8080',
      NODE_OPTIONS: '--inspect',
    })
    const second = await initializeEnvironment(directory, { PATH: '/second' })
    expect(second.revision).toBe(first.revision)
    expect((await loadEnvironment(directory)).imported.PATH).toBe('/first')
    const publicText = await readFile(join(directory, 'environment', 'environment.json'), 'utf8')
    expect(publicText).not.toContain('user:pass')
    expect(publicText).not.toContain('NODE_OPTIONS')
    await importEnvironment(directory, { PATH: '/third' })
    expect((await loadEnvironment(directory)).imported.PATH).toBe('/third')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('merges scoped values and respects proxy tombstones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-env-'))
  try {
    await importEnvironment(directory, { PATH: '/a:/b', HTTPS_PROXY: 'http://localhost:8080' })
    await updateEnvironment(directory, (config) => ({
      ...config,
      scopes: {
        device: { HTTPS_PROXY: null, CUSTOM: 'device' },
        'project:/work': { CUSTOM: 'project' },
        'agent:codex': { CODEX_HOME: '/codex' },
        'project:/work:agent:codex': { CUSTOM: 'agent' },
      },
    }))
    const result = resolveEnvironment(await loadEnvironment(directory), {}, { project: '/work', agent: 'codex' })
    expect(result.env).toMatchObject({ PATH: '/a:/b', CUSTOM: 'agent', CODEX_HOME: '/codex' })
    expect(result.env.HTTPS_PROXY).toBeUndefined()
    expect(result.env.https_proxy).toBeUndefined()
    expect(resolveEnvironment(await loadEnvironment(directory), {}, { agent: 'pi' }).env.CODEX_HOME).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('folds Windows keys and reports conflicting proxy variants', () => {
  const config = {
    version: 1 as const,
    revision: '',
    imported: { PATH: 'first' },
    scopes: { device: { Path: 'second' } },
  }
  expect(resolveEnvironment(config, { Path: 'base' }, { platform: 'win32' }).env).toEqual({ Path: 'second' })
  expect(
    resolveEnvironment(
      { ...config, imported: { HTTP_PROXY: 'http://a', http_proxy: 'http://b' }, scopes: {} },
      {},
      { platform: 'linux' },
    ).diagnostics,
  ).toHaveLength(1)
  const windows = resolveEnvironment(
    { ...config, imported: { HTTP_PROXY: 'http://a', http_proxy: 'http://b' }, scopes: {} },
    {},
    { platform: 'win32' },
  )
  expect(windows.diagnostics).toEqual([])
  expect(windows.env.http_proxy).toBe('http://b')
  expect(windows.env.HTTP_PROXY).toBeUndefined()
})

it('does not inherit a removed explicit value from an older process', () => {
  const first = {
    version: 1 as const,
    revision: 'one',
    imported: { PATH: '/bin' },
    scopes: { device: { CUSTOM: 'old' } },
  }
  const previous = applyEnvironment(first, {})
  const current = applyEnvironment({ ...first, revision: 'two', scopes: {} }, previous)
  expect(current.CUSTOM).toBeUndefined()
  expect(current.PATH).toBe('/bin')
})

it('reports scope sources and diagnostics without exposing values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-env-'))
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await importEnvironment(directory, { PATH: '/bin', HTTP_PROXY: 'http://user:password@localhost:8080' })
    await updateEnvironment(directory, (config) => ({
      ...config,
      scopes: { 'agent:codex': { CODEX_HOME: '/private/codex' } },
    }))
    await runEnvironmentCLI(['doctor', '--data-dir', directory, '--scope', 'agent:codex'])
    const output = String(log.mock.calls.at(-1)?.[0])
    expect(output).not.toContain('password')
    expect(output).not.toContain('/private/codex')
    const result = JSON.parse(output)
    expect(result.origins.CODEX_HOME).toBe('agent:codex')
    expect(typeof result.paths.SSH_AUTH_SOCK).toBe('boolean')
  } finally {
    log.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
