import type { OrchestrationV2RuntimeRequest, ProviderApprovalDecision } from '@t3tools/contracts'

/** Kinds that grant one execution. Session-wide and permanent decisions are never used. */
const permissionKinds = new Set(['command', 'file-read', 'file-change', 'permission'])

/** Permission prompts are allowed once; questions wait for an explicit answer until stopped. */
export function runtimeRequestDecision(
  request: Pick<OrchestrationV2RuntimeRequest, 'kind' | 'status'>,
  stopped: boolean,
): ProviderApprovalDecision | undefined {
  if (request.status !== 'pending') return undefined
  if (stopped) return 'cancel'
  if (request.kind === 'user_input' || request.kind === 'mcp-elicitation') return undefined
  return permissionKinds.has(request.kind) ? 'accept' : 'cancel'
}
