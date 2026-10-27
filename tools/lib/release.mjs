import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { SCHEMA_VERSION } from '../../packages/protocol/src/release.mjs'

export function releaseVersion(version) {
  if (
    typeof version !== 'string' ||
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version) ||
    version !== version.trim() ||
    version.length > 128
  )
    throw new Error('发布版本必须是带 v 前缀的版本号，例如 v0.1.0-alpha.1')
  return version
}

export function buildInfo({ version, commit } = {}) {
  const migrations = readdirSync(new URL('../../migrations/', import.meta.url))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
  if (migrations.at(-1) !== SCHEMA_VERSION) throw new Error('发布元数据与中心迁移版本不匹配')
  if ((version === undefined && commit === undefined) || (version === 'development' && commit === 'development'))
    return { version: 'development', commit: 'development' }
  releaseVersion(version)
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
    throw new Error('发布构建需要 --commit 指定完整的小写 Git 提交哈希')
  return { version, commit }
}

export function validateReleaseMetadata(metadata, runtime, expectedVersion) {
  buildInfo({ version: runtime.version, commit: runtime.commit })
  if (expectedVersion !== undefined && runtime.version !== expectedVersion)
    throw new Error('归档版本与程序实际版本不匹配，不能为旧程序重新贴标')
  for (const field of [
    'version',
    'commit',
    'platform',
    'arch',
    'protocol_version',
    'schema_version',
    'ledger_versions',
    'supported_daemon_versions',
  ]) {
    assert.notEqual(runtime[field], undefined, `程序缺少发布元数据：${field}`)
    assert.deepEqual(metadata[field], runtime[field], `安装包元数据与程序的 ${field} 不匹配`)
  }
  return metadata
}
