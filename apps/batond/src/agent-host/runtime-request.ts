import type { OrchestrationV2RuntimeRequest, ProviderApprovalDecision } from '@t3tools/contracts'

/** Pending requests wait for an explicit answer until stopped. */
export function runtimeRequestDecision(
  request: Pick<OrchestrationV2RuntimeRequest, 'kind' | 'status'>,
  stopped: boolean,
): ProviderApprovalDecision | undefined {
  if (request.status !== 'pending') return undefined
  if (stopped) return 'cancel'
  if (['command', 'file-read', 'file-change', 'permission', 'user_input', 'mcp-elicitation'].includes(request.kind))
    return undefined
  return 'cancel'
}
