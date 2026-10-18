import type { Employee, NodeList, NodeStatus, SavedDefault } from '../types.ts'

export const alice: Employee = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  username: 'alice',
  display_name: 'Alice',
  auth_source: 'local',
  must_change_password: false,
}

export const deskId = '11111111-1111-4111-8111-111111111111'
export const laptopId = '22222222-2222-4222-8222-222222222222'

export function node(partial: Partial<NodeStatus> & Pick<NodeStatus, 'id' | 'display_name'>): NodeStatus {
  return {
    system: 'linux',
    capabilities: [],
    registration_seq: 1,
    online: false,
    last_contact_at: null,
    status_updated_at: null,
    synced: false,
    executable: false,
    revocation_status: 'none',
    ...partial,
  }
}

export function listOf(nodes: NodeStatus[], nodeId = '', invalid = false): NodeList {
  return {
    nodes,
    default_device: {
      node_id: nodeId,
      invalid,
      needs_reselection: invalid,
      message: invalid ? '默认设备仍指向该节点，需要重新选择。系统不会自动改选其他节点。' : undefined,
    },
    local_process_notice: '吊销连接凭据不会停止离线节点上的本地进程。重新接入需要新的连接凭据。',
  }
}

export function saved(id: string, displayName: string, seq: number): SavedDefault {
  return {
    default_device_node_id: id,
    display_name: displayName,
    system: 'linux',
    registration_seq: seq,
  }
}
