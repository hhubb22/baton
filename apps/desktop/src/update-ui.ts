import type { DesktopUpdateSnapshot } from './update.ts'

const activities: Record<DesktopUpdateSnapshot<unknown>['activity'], string> = {
  idle: '检查更新',
  checking: '正在检查更新',
  preparing: '正在准备更新',
  waiting: '正在等待工作结束',
  downloading: '正在下载安装包',
  verifying: '正在校验安装包',
  installing: '请完成安装并打开新版',
  migrating: '正在迁移设备数据',
  syncing: '正在同步并补交结果',
  error: '更新已暂停',
}
const reasons: Record<string, string> = {
  'unsupported-platform': '当前平台没有桌面客户端',
  'downloads-disabled': '中心尚未配置安装包下载',
  'release-changed': '中心正在切换发布版本，请重试',
  'package-missing': '中心尚未提供当前平台的安装包',
  worker_alive: '等待当前工作退出',
  inspection_failed: '无法确认本机工作状态，请查看日志',
  runtime_or_cleanup_pending: '等待项目保存进度并退出',
  runtime_cleanup_unconfirmed: '等待确认项目进程退出',
  probe_alive: '等待本机检查结束',
  unknown: '执行状态未知，需先核对',
  stopping: '正在停止',
}
const phases: Record<string, string> = {
  draining: '等待任务结束',
  ready: '准备就绪',
  migrating: '正在升级',
  syncing: '正在同步',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
}
const lookup = (values: Record<string, string>, value: string) =>
  Object.hasOwn(values, value) ? values[value]! : value

export function updatePresentation(snapshot: DesktopUpdateSnapshot<unknown>) {
  const state = snapshot.status?.state
  const target = state && !['completed', 'cancelled'].includes(state.phase) ? state.target_version : undefined
  const available = snapshot.available?.version !== snapshot.version ? snapshot.available?.version : undefined
  const label =
    (snapshot.activity === 'idle' || snapshot.waiting?.code === 'desktop_update_required') && available
      ? `更新到 ${available}`
      : snapshot.active || snapshot.activity !== 'idle'
        ? `${activities[snapshot.activity]}${target ? ` · ${target}` : ''}`
        : '检查客户端更新'
  const status = snapshot.status
  const detail = [
    `当前客户端：${snapshot.version}`,
    ...(snapshot.available ? [`中心版本：${snapshot.available.version}`] : []),
    ...(status?.state ? [`升级阶段：${lookup(phases, status.state.phase)}`] : []),
    ...(snapshot.available?.reason ? [lookup(reasons, snapshot.available.reason)] : []),
    ...(snapshot.error ? [`${snapshot.error.code}：${snapshot.error.message}`] : []),
    ...(snapshot.waiting ? [snapshot.waiting.message] : []),
    ...(status?.blockers.map(
      (item) => `${item.id}${item.pid ? ` (PID ${item.pid})` : ''}：${lookup(reasons, item.reason)}`,
    ) ?? []),
    ...(status && status.pending_reports > 0 ? [`等待补交的结果：${status.pending_reports}`] : []),
  ].join('\n')
  return {
    label,
    detail,
    version: snapshot.version,
    target: target ?? available,
    phase: status?.state?.phase,
    active: snapshot.active,
  }
}
