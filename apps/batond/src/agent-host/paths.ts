import { Context } from 'effect'

export interface AgentHostPaths {
  /** Thread 工作目录。 */
  readonly workingDirectory: string
  /** 保存原生映射和 SDK 状态的 Thread 私有目录。 */
  readonly privateDirectory: string
  /** 设备私有数据目录；用于读取待脱敏的本地凭据。 */
  readonly dataDirectory?: string
}

export class AgentHostPathsService extends Context.Service<AgentHostPathsService, AgentHostPaths>()(
  'baton/agent-host/Paths',
) {}
