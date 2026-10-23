import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execute = promisify(execFile)

export async function systemCommand(file: string, args: readonly string[]): Promise<string> {
  const result = await execute(file, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  })
  return result.stdout.trim()
}

export function windowsTool(name: string): string {
  const root = process.env.SystemRoot
  if (!root) throw new Error('SystemRoot is required on Windows')
  return join(root, 'System32', name)
}

export const powershell = (source: string): Promise<string> =>
  systemCommand(windowsTool('WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference = 'Stop'; ${source}`, 'utf16le').toString('base64'),
  ])

export interface ProcessIdentity {
  readonly pid: number
  /** Linux boot ID + start ticks; Darwin ps lstart (seconds); Windows CIM UTC ticks. */
  readonly creationTime: string
}

export function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid owned PID: ${pid}`)
}

/** null means absent, including a zombie; access or inspection failures are errors. */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  validatePid(pid)
  if (process.platform === 'win32') {
    const creationTime = await powershell(
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }`,
    )
    if (creationTime && !/^\d+$/.test(creationTime)) throw new Error('Invalid CIM creation time')
    return creationTime ? { pid, creationTime } : null
  }
  if (process.platform === 'linux') {
    const { readFile } = await import('node:fs/promises')
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)
      if (fields[0] === 'Z' || fields[0] === 'X') return null
      const ticks = fields[19]
      if (!ticks || !/^\d+$/.test(ticks)) throw new Error('Invalid /proc process start time')
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      return { pid, creationTime: `${boot}:${ticks}` }
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) return null
      throw error
    }
  }
  let output: string
  try {
    output = await systemCommand('/bin/ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='])
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 1 &&
      'stdout' in error &&
      String(error.stdout).trim() === ''
    )
      return null
    throw error
  }
  const match = /^(\S+)\s+(.+)$/.exec(output)
  if (!match) throw new Error('Invalid ps process identity')
  return match[1].startsWith('Z') ? null : { pid, creationTime: match[2].trim() }
}

export async function identityMatches(identity: ProcessIdentity): Promise<boolean> {
  return (await readProcessIdentity(identity.pid))?.creationTime === identity.creationTime
}
