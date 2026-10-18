import type { DefaultDevice, NodeList, NodeStatus, RevokeResult, SavedDefault } from './types.ts'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isNodeID(value: string): boolean {
  return uuidPattern.test(value)
}

export function formatReportTime(value: string | null): string {
  if (!value) return '尚未报告'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间无效'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(date)
}

export function revocationLabel(status: string): string {
  if (status === 'pending') return '处理中'
  if (status === 'effective') return '已生效'
  return '未吊销'
}

export function eligibleDefaultNodes(nodes: NodeStatus[]): NodeStatus[] {
  return nodes.filter((node) => node.revocation_status === 'none')
}

export function currentDefaultText(list: NodeList): string {
  const id = list.default_device.node_id
  if (!id) return '尚未设置'
  const node = list.nodes.find((item) => item.id === id)
  if (!node) return id
  return `${node.display_name}（${node.system}，序号 ${node.registration_seq}，${id}）`
}

export function savedDefaultSummary(saved: SavedDefault): string {
  return `${saved.display_name}（${saved.system}，序号 ${saved.registration_seq}，${saved.default_device_node_id}）`
}

export function registerUsage(origin: string): string {
  const base = commandOrigin(origin)
  return [
    '把凭据放在环境变量 BATON_ENROLLMENT_TOKEN 中，或写入仅当前用户可读的文件并用 --enrollment-file 指定。',
    '不要把凭据写进命令行参数、URL、localStorage 或日志。',
    `batond register --coordinator ${base} --display-name "名称" --system linux --capability start`,
  ].join('\n')
}

export function commandOrigin(origin: string): string {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return 'https://主机'
    }
    if (url.pathname !== '/' && url.pathname !== '') return 'https://主机'
    return url.origin
  } catch {
    return 'https://主机'
  }
}

export function applySavedDefault(list: NodeList, saved: SavedDefault): NodeList {
  const defaultDevice: DefaultDevice = {
    node_id: saved.default_device_node_id,
    invalid: false,
    needs_reselection: false,
  }
  return { ...list, default_device: defaultDevice }
}

export function applyRevoke(list: NodeList, result: RevokeResult): NodeList {
  return {
    ...list,
    default_device: result.default_device,
    local_process_notice: result.local_process_notice,
    nodes: list.nodes.map((node) => {
      if (node.id !== result.node_id) return node
      return {
        ...node,
        revocation_status: result.status,
        executable: false,
        revocation: {
          status: result.status,
          operator_id: result.operator_id,
          credential_ids: result.credential_ids,
          requested_at: result.requested_at,
          applied_at: result.applied_at,
          message: result.message,
          local_process_notice: result.local_process_notice,
        },
      }
    }),
  }
}
