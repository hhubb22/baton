import { userInfo } from 'node:os'
import { join } from 'node:path'
import { RuntimeExec } from '@baton/protocol'
import { Schema } from 'effect'
import { hasCode } from '../platform/errors.ts'
import { readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { withConfigurationLock } from './config-lock.ts'
import { DeviceError } from './errors.ts'

const PositiveSafeInteger = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
const ProjectRuntimeConfig = Schema.Struct({
  maxOutputTokens: Schema.optionalKey(PositiveSafeInteger),
  maxModelCalls: Schema.optionalKey(PositiveSafeInteger),
  maxConcurrentProjects: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 }))),
  probeTimeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300000 }))),
  probeMaxOutputBytes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 192 * 1024 }))),
})
export async function readProjectRuntimeConfig(dataDirectory: string) {
  let config: typeof ProjectRuntimeConfig.Type = {}
  try {
    const raw = await readPrivateFile(join(dataDirectory, 'project-runtime.json'))
    if (raw.length > 8192) throw new Error()
    config = Schema.decodeUnknownSync(ProjectRuntimeConfig)(JSON.parse(raw.toString('utf8')), {
      onExcessProperty: 'error',
    })
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw new DeviceError('config_unavailable', 'Project Runtime 配置无效')
  }
  return {
    maxOutputTokens: config.maxOutputTokens ?? 32000,
    maxModelCalls: config.maxModelCalls ?? 64,
    maxConcurrentProjects: config.maxConcurrentProjects ?? 4,
    probeTimeoutMs: config.probeTimeoutMs ?? 5000,
    probeMaxOutputBytes: config.probeMaxOutputBytes ?? 64 * 1024,
  }
}

export function defaultProjectShell(): string {
  return process.platform === 'win32' ? 'pwsh' : process.env.SHELL?.trim() || '/bin/sh'
}
const Config = Schema.Struct({ enabled: Schema.Boolean, shell: RuntimeExec.fields.shell })
export async function readProjectExec(dataDirectory: string): Promise<RuntimeExec> {
  let config: typeof Config.Type
  try {
    const raw = await readPrivateFile(join(dataDirectory, 'project-exec.json'))
    if (raw.length > 8192) throw new Error()
    config = Schema.decodeUnknownSync(Config)(JSON.parse(raw.toString('utf8')), { onExcessProperty: 'error' })
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw new DeviceError('config_unavailable', 'Project Agent 命令配置无效')
    config = Schema.decodeUnknownSync(Config)({ enabled: false, shell: defaultProjectShell() })
  }
  try {
    return { ...config, user: userInfo().username }
  } catch {
    return config
  }
}
async function saveExec(dataDirectory: string, config: RuntimeExec): Promise<RuntimeExec> {
  const value = Schema.decodeUnknownSync(Config)({ enabled: config.enabled, shell: config.shell })
  await writePrivateFileAtomic(join(dataDirectory, 'project-exec.json'), JSON.stringify(value))
  return readProjectExec(dataDirectory)
}
export async function writeProjectExec(dataDirectory: string, config: RuntimeExec): Promise<RuntimeExec> {
  return withConfigurationLock(dataDirectory, 'project-exec', () => saveExec(dataDirectory, config))
}
export async function setProjectExec(dataDirectory: string, enabled: boolean): Promise<RuntimeExec> {
  Schema.decodeUnknownSync(Schema.Boolean)(enabled)
  return withConfigurationLock(dataDirectory, 'project-exec', async () =>
    saveExec(dataDirectory, { ...(await readProjectExec(dataDirectory)), enabled }),
  )
}
