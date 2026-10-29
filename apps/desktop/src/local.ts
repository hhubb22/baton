import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Schema } from 'effect'
import { UUID } from '@baton/protocol'
import type { DesktopDiagnostics } from './diagnostics.ts'
import type { PublicIdentity } from './status.ts'

export const LocalDeviceInput = Schema.Struct({ nodeId: UUID })
export const OpenLocalInput = Schema.Struct({ threadId: UUID, action: Schema.Literals(['reveal', 'editor']) })
export const ModelConnectionKeyInput = Schema.Struct({
  nodeId: UUID,
  connectionId: UUID,
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16 * 1024)),
})
export interface LocalIdentity {
  node_id: string
  employee_id: string
  coordinator_url: string
}
export function localAccount(saved: PublicIdentity, origin: string | undefined, employeeId: string): LocalIdentity {
  if (!origin || !saved.registered || !saved.employee_id) throw new Error('请先连接此电脑。')
  if (saved.coordinator_url !== origin || saved.employee_id !== employeeId)
    throw new Error('Sign in to this computer’s account to use local actions.')
  return { node_id: saved.node_id, employee_id: saved.employee_id, coordinator_url: saved.coordinator_url }
}

export const ThreadDirectory = Schema.Struct({
  node_id: UUID,
  employee_id: UUID,
  coordinator_url: Schema.String,
  working_directory: Schema.String,
})
export type ThreadDirectory = typeof ThreadDirectory.Type

export interface LocalDependencies {
  identity: () => Promise<LocalIdentity>
  threadNode: (threadId: string) => Promise<string>
  directory: (threadId: string) => Promise<ThreadDirectory>
  openDirectory: (path: string, editor: boolean) => Promise<void>
  pickDirectory: () => Promise<string | null>
  diagnostics: () => Promise<DesktopDiagnostics>
  restart: () => Promise<void>
  openLogs: () => Promise<void>
  copyDiagnostics: () => Promise<void>
  setModelConnectionKey?: (connectionId: string, key: string) => Promise<void>
}

function parse<A>(schema: Schema.ConstraintDecoder<A, never>, input: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
  } catch {
    throw new Error('本机操作无效。')
  }
}

export class LocalActions {
  constructor(private readonly dependencies: LocalDependencies) {}

  private async device(input: unknown) {
    const { nodeId } = parse(LocalDeviceInput, input)
    const identity = await this.dependencies.identity()
    if (nodeId !== identity.node_id) throw new Error('此设备不是当前电脑。')
    return identity
  }

  async openLocal(input: unknown) {
    const { threadId, action } = parse(OpenLocalInput, input)
    const identity = await this.dependencies.identity()
    if ((await this.dependencies.threadNode(threadId)) !== identity.node_id) throw new Error('此对话不在当前电脑上。')
    const saved = await this.dependencies.directory(threadId)
    if (
      saved.node_id !== identity.node_id ||
      saved.employee_id !== identity.employee_id ||
      saved.coordinator_url !== identity.coordinator_url ||
      !isAbsolute(saved.working_directory)
    )
      throw new Error('此对话不在当前电脑上。')
    let path: string
    try {
      path = await realpath(saved.working_directory)
      if (!(await stat(path)).isDirectory()) throw new Error('不是文件夹')
    } catch {
      throw new Error('此文件夹已不存在。')
    }
    // batond 返回已按登记范围解析的目录；打开前再核查路径未被替换成符号链接。
    if (path !== saved.working_directory) throw new Error('文件夹已更改，请重试。')
    const current = await this.dependencies.identity()
    if (
      current.node_id !== identity.node_id ||
      current.employee_id !== identity.employee_id ||
      current.coordinator_url !== identity.coordinator_url
    )
      throw new Error('本机账号已更改，请重试。')
    await this.dependencies.openDirectory(path, action === 'editor')
  }

  async pickDirectory(input: unknown) {
    await this.device(input)
    const path = await this.dependencies.pickDirectory()
    // 原生对话框可能跨越一次账号切换。
    await this.device(input)
    return path
  }

  async diagnostics(input: unknown) {
    await this.device(input)
    return this.dependencies.diagnostics()
  }

  async restartDaemon(input: unknown) {
    await this.device(input)
    if (!(await this.dependencies.diagnostics()).canRestart)
      throw new Error('更新期间或由其他服务管理器管理时，无法重启设备服务。')
    await this.dependencies.restart()
  }

  async openLogs(input: unknown) {
    await this.device(input)
    await this.dependencies.openLogs()
  }

  async copyDiagnostics(input: unknown) {
    await this.device(input)
    await this.dependencies.copyDiagnostics()
  }

  async setModelConnectionKey(input: unknown) {
    const value = parse(ModelConnectionKeyInput, input)
    await this.device({ nodeId: value.nodeId })
    if (!this.dependencies.setModelConnectionKey) throw new Error('本机模型配置不可用。')
    await this.dependencies.setModelConnectionKey(value.connectionId, value.key)
  }
}

// 每个入口都在解析参数和执行本机动作之前核查窗口、中心源和主 frame。
export function registerLocalBridge<E>(
  handle: (channel: string, callback: (event: E, input: unknown) => Promise<unknown>) => void,
  authorize: (event: E) => void,
  actions: LocalActions,
) {
  const methods = {
    'open-local': (input: unknown) => actions.openLocal(input),
    'pick-directory': (input: unknown) => actions.pickDirectory(input),
    diagnostics: (input: unknown) => actions.diagnostics(input),
    'restart-daemon': (input: unknown) => actions.restartDaemon(input),
    'open-logs': (input: unknown) => actions.openLogs(input),
    'copy-diagnostics': (input: unknown) => actions.copyDiagnostics(input),
    'model-connection-key': (input: unknown) => actions.setModelConnectionKey(input),
  }
  for (const [name, operation] of Object.entries(methods))
    handle(`baton:${name}`, async (event, input) => {
      authorize(event)
      return operation(input)
    })
}
