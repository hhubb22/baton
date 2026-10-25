import type { RuntimeAgent } from '@baton/protocol'

/** Steering and model changes follow the fixed upstream adapters. */
export const agentCapabilities = {
  cursor: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: true },
  pi: { create: true, queue: true, steer: true, stop: true, resume: true, switch_model: true },
  codex: { create: true, queue: true, steer: true, stop: true, resume: true, switch_model: true },
  kiro: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
  shell: { create: true, queue: true, steer: false, stop: true, resume: false, switch_model: false },
} satisfies Record<string, RuntimeAgent['capabilities']>

export const capabilityLimitations = {
  cursor: '上游 adapter 不支持 steer',
  pi: '',
  codex: '',
  kiro: '上游 adapter 不支持 steer 和 Thread 内换模型',
}

const registered = new Map<string, RuntimeAgent['capabilities']>(Object.entries(agentCapabilities))

export const capabilitiesFor = (agentType: string) => registered.get(agentType)
