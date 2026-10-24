import type { OrchestrationV2RuntimeRequest, ProviderApprovalDecision } from '@t3tools/contracts'

/** Kinds that grant one execution. Session-wide and permanent decisions are never used. */
const permissionKinds = new Set(['command', 'file-read', 'file-change', 'mcp-elicitation', 'permission'])

/**
 * Permission prompts are allowed once for the current turn. Questions and any
 * request that arrives after stop or interrupt are cancelled, so a turn cannot
 * wait for a person.
 */
export function runtimeRequestDecision(
  request: Pick<OrchestrationV2RuntimeRequest, 'kind' | 'status'>,
  stopped: boolean,
): ProviderApprovalDecision | undefined {
  if (request.status !== 'pending') return undefined
  if (stopped || !permissionKinds.has(request.kind)) return 'cancel'
  return 'accept'
}
