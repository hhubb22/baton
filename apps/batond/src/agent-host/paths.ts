export interface AgentHostPaths {
  /** Thread 工作目录。 */
  readonly workingDirectory: string
  /** 保存原生映射和 SDK 状态的 Thread 私有目录。 */
  readonly privateDirectory: string
}
