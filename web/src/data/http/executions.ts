import { ClientError, type BatonClient } from '../client'
import type { Execution, FullOutputReference } from '../types'
import { apiPath, timestamp, type HttpContext } from './context'

type ExecutionDTO = {
  id: string
  project_id: string
  node_id: string
  origin_conversation_id: string
  origin_tool_call_id: string
  command: string
  working_directory: string
  timeout_seconds: number
  status: Execution['status']
  exit_code?: number | null
  reason?: string | null
  output?: string | null
  encoding?: string | null
  total_bytes?: number | null
  truncated?: boolean
  full_output?: FullOutputReference | null
  stop_requested_at?: string | null
  created_at: string
}

function mapExecution(item: ExecutionDTO): Execution {
  return {
    id: item.id,
    projectId: item.project_id,
    deviceId: item.node_id,
    originConversationId: item.origin_conversation_id,
    originToolCallId: item.origin_tool_call_id,
    command: item.command,
    workingDirectory: item.working_directory,
    timeoutSeconds: item.timeout_seconds,
    status: item.status,
    exitCode: item.exit_code,
    reason: item.reason,
    output: item.output,
    encoding: item.encoding,
    totalBytes: item.total_bytes,
    truncated: item.truncated,
    fullOutput: item.full_output,
    stopRequestedAt: item.stop_requested_at ? timestamp(item.stop_requested_at) : null,
    createdAt: timestamp(item.created_at),
  }
}

export function createExecutionAPI(
  ctx: HttpContext,
): Pick<BatonClient, 'listProjectExecutions' | 'getExecution' | 'stopExecution'> {
  return {
    async listProjectExecutions(projectId) {
      const query = new URLSearchParams({ project_id: projectId })
      const items: ExecutionDTO[] = []
      const seen = new Set<string>()
      let cursor = ''
      do {
        if (cursor) query.set('cursor', cursor)
        const result = await ctx.request<{ executions: ExecutionDTO[]; next_cursor?: string }>(`/executions?${query}`)
        items.push(...result.executions)
        cursor = result.next_cursor ?? ''
        if (cursor && seen.has(cursor)) throw new ClientError('unavailable', '执行列表分页未推进。')
        seen.add(cursor)
      } while (cursor)
      return items.map(mapExecution)
    },
    async getExecution(id) {
      return mapExecution(await ctx.request<ExecutionDTO>(`/executions/${apiPath(id)}`))
    },
    async stopExecution(id) {
      const result = await ctx.request<ExecutionDTO>(`/executions/${apiPath(id)}/stop`, { method: 'POST' })
      ctx.emit('projects')
      return mapExecution(result)
    },
  }
}
