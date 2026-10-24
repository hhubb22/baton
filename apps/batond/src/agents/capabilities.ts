import type { RuntimeAgent } from '@baton/protocol'

/** Baton exposes steering only for providers whose upstream adapter supports it. */
export const agentCapabilities = {
  cursor: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
  pi: { create: true, queue: true, steer: true, stop: true, resume: true, switch_model: false },
  codex: { create: true, queue: true, steer: true, stop: true, resume: true, switch_model: false },
  shell: { create: true, queue: true, steer: false, stop: true, resume: false, switch_model: false },
} satisfies Record<string, RuntimeAgent['capabilities']>

const registered = new Map<string, RuntimeAgent['capabilities']>(Object.entries(agentCapabilities))

export const capabilitiesFor = (agentType: string) => registered.get(agentType)
