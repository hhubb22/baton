import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { FileCredentials, protect } from '../src/credentials.js'
import { probe, runtimeModels, loginApiKey } from '../src/auth.js'
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models'
import { OPENAI_CODEX_MODELS } from '@earendil-works/pi-ai/providers/openai-codex.models'
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models'

test('probe 只读本地凭据，不发网络请求、不刷新 OAuth、不输出凭据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-auth-'))
  try {
    const store = new FileCredentials(dir)
    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      refresh: 'test-refresh',
      access: 'test-access',
      expires: 0,
    }))
    const before = await readFile(join(dir, 'openai-codex.json'), 'utf8')
    const originalFetch = globalThis.fetch
    let networkCalls = 0
    globalThis.fetch = async () => {
      networkCalls++
      throw new Error('probe 不允许网络')
    }
    try {
      const result = await probe(store)
      assert.equal(result.providers[0].status, 'available')
      assert.equal(result.providers[1].status, 'login_required')
      for (const [index, catalog] of [OPENAI_CODEX_MODELS, XAI_MODELS, ANTHROPIC_MODELS].entries()) {
        assert.deepEqual(
          result.providers[index].models,
          Object.values(catalog)
            .slice(0, 64)
            .map(({ id, name }) => ({ id, name })),
        )
        assert.ok(result.providers[index].models.length > 0)
        assert.ok(result.providers[index].models.length <= 64)
      }
      assert.equal(networkCalls, 0)
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024)
      assert.ok(!JSON.stringify(result).includes('test-refresh'))
      assert.equal(await readFile(join(dir, 'openai-codex.json'), 'utf8'), before)
    } finally {
      globalThis.fetch = originalFetch
    }
    if (process.platform !== 'win32') {
      assert.equal((await stat(dir)).mode & 0o777, 0o700)
      assert.equal((await stat(join(dir, 'openai-codex.json'))).mode & 0o777, 0o600)
    }
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'probe'], {
      env: {
        ...process.env,
        BATON_PROJECT_RUNTIME_DATA_DIR: dir,
        NODE_OPTIONS: '',
      },
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(child.status, 0, child.stderr)
    const report = JSON.parse(child.stdout)
    assert.equal(report.providers[0].status, 'available')
    assert.ok(
      report.providers.every(
        (provider: { models: unknown[] }) => provider.models.length > 0 && provider.models.length <= 64,
      ),
    )
    assert.ok(Buffer.byteLength(child.stdout) < 16 * 1024)
    assert.ok(!child.stdout.includes('test-access'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('凭据不可读时仍返回内置模型目录，登录状态为 unknown', async () => {
  class UnreadableCredentials extends FileCredentials {
    async read(): Promise<never> {
      throw new Error('credential_permissions_invalid')
    }
  }
  const result = await probe(new UnreadableCredentials('unused'))
  assert.deepEqual(
    result.providers.map(({ status }) => status),
    ['unknown', 'unknown', 'unknown'],
  )
  assert.ok(result.providers.every(({ reason }) => reason === 'credential_permissions_invalid'))
  assert.ok(result.providers.every(({ models }) => models.length > 0))
})

test('未知凭据读取错误保留 unknown，报告只含安全诊断', async () => {
  class UnreadableCredentials extends FileCredentials {
    async read(): Promise<never> {
      throw new Error('opaque error with private credential content')
    }
  }
  const result = await probe(new UnreadableCredentials('unused'))
  assert.ok(result.providers.every(({ status, reason }) => status === 'unknown' && reason === 'credential_read_failed'))
  assert.ok(!JSON.stringify(result).includes('private credential content'))
})

test('API key 登录、探测与请求认证使用同一个 provider，环境凭据保持隔离', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-api-key-'))
  const previous = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'unrelated-ambient-key'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('认证检查不允许网络')
  }
  try {
    await protect(dir, true)
    const store = new FileCredentials(dir)
    const models = await runtimeModels(store)
    assert.equal(await models.getAuth('anthropic'), undefined)
    for (const provider of ['anthropic', 'xai']) {
      await loginApiKey(provider, ` offline-key-${provider}\n`, store)
      const report = await probe(store)
      const entry = report.providers.find((item) => item.provider === provider)
      assert.equal(entry?.status, 'available')
      assert.ok(entry?.login_methods.includes('api_key'))
      assert.ok(!JSON.stringify(report).includes('offline-key'))
      assert.equal((await models.getAuth(provider))?.auth.apiKey, `offline-key-${provider}`)
      assert.ok(models.getModels(provider).length > 0)
      if (process.platform !== 'win32') assert.equal((await stat(join(dir, `${provider}.json`))).mode & 0o777, 0o600)
    }
    assert.equal(
      (await probe(store)).providers.find((item) => item.provider === 'openai-codex')?.status,
      'login_required',
    )
    const before = await readFile(join(dir, 'anthropic.json'), 'utf8')
    await assert.rejects(loginApiKey('anthropic', ' \n', store), /api_key_invalid/)
    await assert.rejects(loginApiKey('anthropic', 'key\nsecond-line', store), /api_key_invalid/)
    await assert.rejects(loginApiKey('openai-codex', 'offline-key', store), /api_key_unsupported/)
    await assert.rejects(loginApiKey('unregistered', 'offline-key', store), /unsupported_provider/)
    assert.equal(await readFile(join(dir, 'anthropic.json'), 'utf8'), before)
    if (process.platform !== 'win32') {
      await chmod(join(dir, 'anthropic.json'), 0o644)
      assert.equal((await probe(store)).providers.find((item) => item.provider === 'anthropic')?.status, 'available')
      assert.equal((await stat(join(dir, 'anthropic.json'))).mode & 0o777, 0o600)
    }
    await store.modify('openai-codex', async () => ({ type: 'api_key', key: 'wrong-auth-type' }))
    assert.equal(
      (await probe(store)).providers.find((item) => item.provider === 'openai-codex')?.status,
      'login_required',
    )
    assert.equal(await models.getAuth('openai-codex'), undefined)
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('API key CLI 从标准输入保存密钥，输出和 probe 不包含密钥', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-api-key-cli-'))
  try {
    const env = { ...process.env, BATON_PROJECT_RUNTIME_DATA_DIR: dir, NODE_OPTIONS: '' }
    const cli = (args: string[], input?: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
        env,
        input,
        encoding: 'utf8',
        timeout: 5000,
      })
    const result = cli(['login-api-key', 'anthropic'], 'offline-stdin-key\n')
    assert.equal(result.status, 0, result.stderr)
    assert.ok(!(result.stdout + result.stderr).includes('offline-stdin-key'))
    const report = cli(['probe'])
    assert.equal(report.status, 0, report.stderr)
    assert.equal(
      JSON.parse(report.stdout).providers.find((item: { provider: string }) => item.provider === 'anthropic').status,
      'available',
    )
    assert.ok(!report.stdout.includes('offline-stdin-key'))
    assert.equal(cli(['login-api-key', 'anthropic'], '').status, 1)
    assert.equal(cli(['login-device', 'anthropic']).status, 1)
    assert.equal((await new FileCredentials(dir).read('anthropic')).key, 'offline-stdin-key')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
