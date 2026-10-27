import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export function fakeProcess(pid = 1234) {
  const events = new EventEmitter()
  const process = Object.assign(events, {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      events.emit('close', null)
      return true
    },
  }) as unknown as ChildProcessWithoutNullStreams
  return process
}
