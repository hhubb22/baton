import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileCredentials, protect } from '../src/credentials.js'

void describe('FileCredentials', () => {
  let directory: string
  let store: FileCredentials
  const value = { type: 'api_key', key: 'local-contract-key' }
  const file = () => join(directory, 'xai.json')
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'baton-credential-contract-'))
    await protect(directory, true)
    store = new FileCredentials(directory)
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test('缺失目录和文件读为空，保存后列出并删除凭据', async () => {
    const missing = new FileCredentials(join(directory, 'missing'))
    assert.equal(await missing.read('xai'), undefined)
    assert.deepEqual(await missing.list(), [])
    assert.deepEqual(await readdir(directory), [])
    assert.equal(await store.read('xai'), undefined)
    await store.modify('xai', async () => value)
    assert.deepEqual(await store.read('xai'), value)
    assert.deepEqual(await store.list(), [{ providerId: 'xai', type: 'api_key' }])
    await store.delete('xai')
    assert.equal(await store.read('xai'), undefined)
  })

  test('刷新事务串行化，原子替换保留旧句柄内容且不遗留临时文件', async () => {
    await store.modify('xai', async () => ({ ...value, generation: 0 }))
    const handle = await open(file(), 'r')
    try {
      await Promise.all(
        Array.from({ length: 3 }, () =>
          store.modify('xai', async (current) => ({
            ...current,
            generation: current.generation + 1,
          })),
        ),
      )
      assert.equal((await store.read('xai')).generation, 3)
      assert.equal(JSON.parse(await handle.readFile('utf8')).generation, 0)
      assert.deepEqual(await readdir(directory), ['xai.json'])
      if (process.platform !== 'win32') {
        assert.equal((await stat(directory)).mode & 0o7777, 0o700)
        assert.equal((await stat(file())).mode & 0o7777, 0o600)
      }
    } finally {
      await handle.close()
    }
  })

  test('64 KiB 按 UTF-8 字节计算，超限读写失败且保留原文件', async () => {
    const exact = { key: '猫'.repeat(21842) }
    // JSON 外壳为 10 字节，21842 个三字节字符恰好填满 64 KiB。
    assert.equal(Buffer.byteLength(JSON.stringify(exact)), 65536)
    await store.modify('xai', async () => exact)
    assert.deepEqual(await store.read('xai'), exact)
    await assert.rejects(store.modify('xai', async () => ({ key: exact.key + 'x' })))
    assert.deepEqual(await store.read('xai'), exact)
    await writeFile(file(), JSON.stringify({ key: exact.key + 'x' }))
    await assert.rejects(store.read('xai'))
    assert.deepEqual(await readdir(directory), ['xai.json'])
  })

  test('拒绝目录作为凭据文件及普通文件作为目录', async () => {
    await mkdir(file(), { mode: 0o700 })
    await assert.rejects(store.read('xai'))
    await assert.rejects(store.modify('xai', async () => value))
    const invalid = new FileCredentials(file())
    await rm(file(), { recursive: true })
    await writeFile(file(), '{}', { mode: 0o600 })
    await assert.rejects(invalid.read('xai'))
  })

  test('拒绝符号链接，外部目标保持原内容', { skip: process.platform === 'win32' }, async () => {
    const target = join(directory, 'target')
    await writeFile(target, JSON.stringify(value), { mode: 0o600 })
    await symlink(target, file())
    await assert.rejects(store.read('xai'))
    await assert.rejects(store.modify('xai', async () => ({ ...value, key: 'changed' })))
    assert.equal(await readFile(target, 'utf8'), JSON.stringify(value))
    await rm(file())
    const alias = join(directory, 'alias')
    await symlink(directory, alias, 'dir')
    await assert.rejects(new FileCredentials(alias).read('xai'))
    await assert.rejects(new FileCredentials(alias).modify('xai', async () => value))
  })

  test('读取时把文件改回 0600、目录改回 0700', { skip: process.platform === 'win32' }, async () => {
    await store.modify('xai', async () => value)
    for (const mode of [0o400, 0o644, 0o1600]) {
      await chmod(file(), mode)
      assert.deepEqual(await store.read('xai'), value)
      assert.equal((await stat(file())).mode & 0o7777, 0o600)
    }
    for (const mode of [0o750, 0o1700]) {
      await chmod(directory, mode)
      assert.deepEqual(await store.read('xai'), value)
      assert.equal((await stat(directory)).mode & 0o7777, 0o700)
    }
  })

  test('拒绝不同属主，读取不会更改凭据或权限', { skip: process.platform === 'win32' }, async () => {
    await store.modify('xai', async () => value)
    const original = process.getuid!
    const differentUid = original() + 1
    for (const ownerCheck of [1, 2]) {
      let checks = 0
      process.getuid = () => (++checks === ownerCheck ? differentUid : original())
      try {
        await assert.rejects(store.read('xai'))
      } finally {
        process.getuid = original
      }
    }
    assert.equal(await readFile(file(), 'utf8'), JSON.stringify(value))
    assert.equal((await stat(file())).mode & 0o7777, 0o600)
  })
})
