import type { TaskState } from './sample.ts'

export const stateLabel: Record<TaskState, string> = {
  running: '执行中',
  queued: '等待设备',
  succeeded: '已完成',
  failed: '失败',
  unverified: '待核实',
}
