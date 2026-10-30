import { Schema } from 'effect'
import type { ProjectRuntimeRequest, ProjectRuntimeResult, ProjectExecutionUpdate } from '@baton/protocol'
import { UUID } from '@baton/protocol'
import { failure, success } from './types.ts'

const Pending = Schema.Struct({
  pending: Schema.Literal(true),
  execution_id: UUID,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  wait_remaining_ms: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600000 })),
  wait_protocol: Schema.Literal(1),
})
const Poll = Schema.Struct({
  wait_ms: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25000 }))),
  execution_id: Schema.optionalKey(UUID),
  after_version: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
interface Binding {
  callId: string
  observed: number
  version: number
  deadline: number
}
interface Call {
  active: number
  final?: ProjectRuntimeResult
}
export class RuntimeWaits {
  private wake = false
  private readonly bindings = new Map<string, Binding>()
  private readonly calls = new Map<string, Call>()
  private readonly listeners = new Set<() => void>()
  notify(updates: readonly ProjectExecutionUpdate[] = []) {
    this.wake = true
    for (const update of updates) {
      const binding = this.bindings.get(update.execution_id)
      if (binding && update.version > binding.version) binding.version = update.version
    }
    this.signal()
  }
  signal() {
    for (const listener of this.listeners) listener()
  }
  begin(id: string | undefined) {
    if (!id || id.length > 128) return
    const call = this.calls.get(id) ?? { active: 0 }
    call.active++
    this.calls.set(id, call)
    return call
  }
  finish(
    call: Call | undefined,
    request: ProjectRuntimeRequest,
    result: ProjectRuntimeResult,
    started: number,
  ): ProjectRuntimeResult {
    if (!call) return result
    const id = request.tool_call_id!
    try {
      if (!result.ok) return result
      if (call.final) return call.final
      const pending = Schema.decodeUnknownOption(Pending)(result.data)
      if (pending._tag === 'Some') {
        const p = pending.value
        const binding = this.bindings.get(p.execution_id)
        if (
          (binding && binding.callId !== id) ||
          [...this.bindings].some(([execution, b]) => b.callId === id && execution !== p.execution_id)
        )
          return failure('unavailable')
        if (!binding && this.bindings.size >= 64) return failure('capacity_exceeded')
        this.bindings.set(p.execution_id, {
          callId: id,
          observed: Math.max(binding?.observed ?? 0, p.version),
          version: Math.max(binding?.version ?? 0, p.version),
          deadline: started + p.wait_remaining_ms,
        })
      } else {
        const data = Schema.decodeUnknownOption(
          Schema.Struct({
            pending: Schema.optionalKey(Schema.Boolean),
            wait_protocol: Schema.optionalKey(Schema.Number),
          }),
        )(result.data)
        if (data._tag === 'None' || (data.value.pending && data.value.wait_protocol === 1))
          return failure('unavailable')
        if (!data.value.pending) {
          call.final = result
          for (const [thread, binding] of this.bindings) if (binding.callId === id) this.bindings.delete(thread)
          this.signal()
        }
      }
      return result
    } finally {
      if (--call.active === 0) this.calls.delete(id)
    }
  }
  async poll(payload: unknown, signal: AbortSignal, now: () => number): Promise<ProjectRuntimeResult> {
    const decoded = Schema.decodeUnknownOption(Poll)(payload ?? {})
    if (decoded._tag === 'None') return failure('invalid_request')
    const { execution_id: execution, after_version: after, wait_ms: wait = 25000 } = decoded.value
    if ((execution === undefined) !== (after === undefined)) return failure('invalid_request')
    const deadline = now() + wait
    for (;;) {
      const time = now()
      if (signal.aborted) return failure('lease_lost')
      let remaining = deadline - time
      if (execution !== undefined && after !== undefined) {
        const binding = this.bindings.get(execution)
        if (!binding || after > binding.observed) return failure('invalid_request')
        if (binding.version > after) return success({ reason: 'execution_changed', version: binding.version })
        remaining = Math.min(remaining, binding.deadline - time)
        if (remaining <= 0) return success({ reason: 'timeout', version: binding.version })
      } else {
        if (this.wake) {
          this.wake = false
          return success({ wake: true })
        }
        if (remaining <= 0) return success({ wake: false })
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.listeners.delete(done)
          signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, Math.min(remaining, 1000))
        this.listeners.add(done)
        signal.addEventListener('abort', done, { once: true })
        if (signal.aborted) done()
      })
    }
  }
}
