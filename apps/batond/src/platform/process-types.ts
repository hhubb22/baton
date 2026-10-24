import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ProcessIdentity } from './identity.ts'

export interface ProcessCommand {
  readonly file: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

export interface ProcessRecord extends ProcessIdentity {
  readonly role: string
}

/** Persist before spawn returns; remove only after tree reaping is confirmed. */
export interface ProcessRecordCallbacks {
  readonly add: (record: ProcessRecord) => Promise<void>
  readonly remove: (record: ProcessRecord) => Promise<void>
}

export interface ProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}
export interface ReapResult {
  readonly reaped: boolean
  readonly reason?: 'timeout' | 'identity-mismatch'
}

export interface ProcessWatchdog {
  readonly pid: number
  readonly register: (identity: ProcessIdentity) => Promise<void>
  readonly unregister: (identity: ProcessIdentity) => Promise<void>
  /** Closes the private pipe; watchdog reaps remaining groups before exit. */
  readonly close: () => Promise<void>
}

export interface SpawnOwnedProcessOptions {
  /** Attach output consumers synchronously, before a fast child can exit and Node drains its pipes. */
  readonly onSpawn?: (child: ChildProcessWithoutNullStreams) => void
  /** Mandatory on POSIX. Start once per Worker; never attach a detached Worker here. */
  readonly watchdog?: ProcessWatchdog | undefined
  /** Mandatory on Windows so crash recovery has durable PID + creation time. */
  readonly records?: ProcessRecordCallbacks | undefined
  readonly role?: string
  /** Cancels startup, including pending registration/persistence; cleanup completes before rejection. */
  readonly signal?: AbortSignal
  readonly reapTimeoutMs?: number
}

export interface OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly pid: number
  readonly record: ProcessRecord
  readonly stdin: ChildProcessWithoutNullStreams['stdin']
  readonly stdout: ChildProcessWithoutNullStreams['stdout']
  readonly stderr: ChildProcessWithoutNullStreams['stderr']
  /** Root process exit only. Tree termination is established separately by reap(). */
  readonly exited: Promise<ProcessExit>
  readonly reap: () => Promise<ReapResult>
  readonly close: () => Promise<ReapResult>
}
