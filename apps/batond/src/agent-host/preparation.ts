import { createHash } from 'node:crypto'
import type { WorkerOpenConfig } from '@baton/protocol'
import type { AgentMessage } from '../worker/agent.ts'
import type { Preparation } from './protocol.ts'

/**
 * Input binding shared by the Worker-side ThreadAgent and the host driver.
 * Only Worker-known facts take part, so neither side reads native history to
 * rebuild it.
 */
function preparationId(config: WorkerOpenConfig, nativeSessionId: string, message: AgentMessage): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.thread_id,
        nativeSessionId,
        message.id,
        message.text,
        message.epoch,
        message.operationId,
        message.mode,
        message.model ?? null,
      ]),
    )
    .digest('hex')
}

export function preparationFor(
  config: WorkerOpenConfig,
  nativeSessionId: string,
  message: AgentMessage,
  confirmedSends: number,
): Preparation {
  return {
    nativeSessionId,
    preparationId: preparationId(config, nativeSessionId, message),
    confirmedSends,
  }
}

/** Preparations are compared by value; the Worker persists the exact document it produced. */
export const samePreparation = (left: Preparation, right: Preparation): boolean =>
  left.nativeSessionId === right.nativeSessionId &&
  left.preparationId === right.preparationId &&
  left.confirmedSends === right.confirmedSends
