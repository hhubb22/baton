import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSea } from 'node:sea'
import { Schema } from 'effect'
import { DeploymentConfig } from '@baton/protocol/deployment'
import { isMissing } from './identity.ts'

export class DeploymentInvalid extends Error {
  readonly code = 'deployment_invalid'
  constructor() {
    super('安装目录中的 deployment.json 无效，请重新下载安装包或核对部署配置')
  }
}

export async function loadDeployment(
  installationDirectory = isSea() ? dirname(process.execPath) : undefined,
): Promise<DeploymentConfig | undefined> {
  if (!installationDirectory) return undefined
  let raw: string
  try {
    raw = await readFile(join(installationDirectory, 'deployment.json'), 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  try {
    return Schema.decodeUnknownSync(DeploymentConfig)(JSON.parse(raw))
  } catch {
    throw new DeploymentInvalid()
  }
}
