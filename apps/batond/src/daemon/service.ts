import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isSea } from 'node:sea'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { Schema } from 'effect'
import { PositiveInteger, Timestamp } from '@baton/protocol'
import { currentBatondCommand, type BatondCommand } from './host.ts'
import { isMissing, loadIdentity } from './identity.ts'
import { ensurePrivateDirectory, readPrivateFile } from '../platform/private.ts'
import { readProcessLock } from '../platform/lock.ts'
import { identityMatches } from '../platform/identity.ts'

const label = 'dev.baton.batond'
const unit = 'baton-batond.service'

export class ServiceError extends Error {
  constructor(
    readonly code: 'service_unavailable' | 'service_unsupported' | 'service_not_registered',
    message: string,
  ) {
    super(message)
  }
}

export type ServiceRunner = (
  executable: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>

const exec = promisify(execFile)
const runCommand: ServiceRunner = async (executable, args) => {
  try {
    const result = await exec(executable, [...args], { timeout: 15000, maxBuffer: 1024 * 1024 })
    return { code: 0, ...result }
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'number') {
      return {
        code: error.code,
        stdout: 'stdout' in error ? String(error.stdout) : '',
        stderr: 'stderr' in error ? String(error.stderr) : error.message,
      }
    }
    throw error
  }
}

interface ServiceDefinition {
  command: BatondCommand
  dataDirectory: string
}

function checkedPath(value: string): string {
  if (value.split('').some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new ServiceError('service_unavailable', '服务路径不能包含控制字符')
  return value
}

const logPath = (directory: string) => join(directory, 'logs', 'batond.log')
const argumentsFor = ({ command, dataDirectory }: ServiceDefinition) =>
  [command.executable, ...command.args, 'run', '--data-dir', dataDirectory].map(checkedPath)
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

export function renderLaunchAgent(definition: ServiceDefinition): string {
  const args = argumentsFor(definition)
    .map((arg) => `      <string>${xml(arg)}</string>`)
    .join('\n')
  const log = xml(logPath(definition.dataDirectory))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>StandardOutPath</key><string>${log}</string>
    <key>StandardErrorPath</key><string>${log}</string>
  </dict>
</plist>
`
}

// systemd 的 ExecStart 会展开 % 和 $，参数不经过 shell。
const systemdArgument = (value: string) => JSON.stringify(value.replaceAll('%', '%%').replaceAll('$', () => '$$'))

export function renderSystemdUnit(definition: ServiceDefinition): string {
  const args = argumentsFor(definition).map(systemdArgument).join(' ')
  const log = checkedPath(logPath(definition.dataDirectory)).replaceAll('%', '%%')
  return `[Unit]
Description=Baton node

[Service]
ExecStart=${args}
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`
}

const DaemonStatus = Schema.Struct({
  pid: PositiveInteger,
  state: Schema.Literals(['connecting', 'online', 'rejected', 'stopping']),
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  updated_at: Timestamp,
})

async function readDaemonStatus(directory: string): Promise<ServiceStatus['daemon']> {
  try {
    const status = Schema.decodeUnknownSync(DaemonStatus)(
      JSON.parse((await readPrivateFile(join(directory, 'daemon-status.json'))).toString('utf8')),
    )
    const stale = await readProcessLock(join(directory, 'daemon.lock'))
      .then(async (lock) => !lock || lock.pid !== status.pid || !(await identityMatches(lock)))
      .catch(() => true)
    return { ...status, stale }
  } catch {
    return null
  }
}

export interface ServiceStatus {
  installed: boolean
  running: boolean
  program_path: string | null
  log_path: string | null
  daemon: (typeof DaemonStatus.Type & { stale: boolean }) | null
  linger?: boolean | null
  message?: string
}

interface ServiceOptions {
  platform?: NodeJS.Platform
  homeDirectory?: string
  uid?: number
  user?: string
  env?: NodeJS.ProcessEnv
  command?: BatondCommand
  runner?: ServiceRunner
}

async function readDefinition(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (!isMissing(error)) throw error
    return undefined
  }
}

async function removeDefinition(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!isMissing(error)) throw error
  })
}

async function writeDefinition(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.batond-${randomUUID()}`)
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await removeDefinition(temporary)
  }
}

const LaunchAgent = Schema.Struct({ ProgramArguments: Schema.Array(Schema.String), StandardOutPath: Schema.String })

export async function manageService(
  action: 'install' | 'uninstall' | 'status',
  dataDirectory: string,
  options: ServiceOptions = {},
): Promise<ServiceStatus | { installed: boolean }> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') throw new ServiceError('service_unsupported', 'Windows 请使用 Baton 桌面客户端')
  if (platform !== 'darwin' && platform !== 'linux')
    throw new ServiceError('service_unavailable', '当前系统不支持 Baton 用户服务')
  const env = options.env ?? process.env
  if (platform === 'linux' && !env.XDG_RUNTIME_DIR)
    throw new ServiceError('service_unavailable', '缺少 XDG_RUNTIME_DIR，请在有效的用户登录会话中运行')
  const home = options.homeDirectory ?? homedir()
  const domain = `gui/${options.uid ?? process.getuid?.()}`
  const target = `${domain}/${label}`
  const path =
    platform === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', `${label}.plist`)
      : join(home, '.config', 'systemd', 'user', unit)
  const runner = options.runner ?? runCommand
  const run = async (file: string, args: readonly string[]) => {
    try {
      return await runner(file, args)
    } catch (error) {
      throw new ServiceError(
        'service_unavailable',
        `无法执行 ${file}：${error instanceof Error ? error.message : '命令不可用'}`,
      )
    }
  }
  const check = async (file: string, args: readonly string[]) => {
    const result = await run(file, args)
    if (result.code !== 0)
      throw new ServiceError(
        'service_unavailable',
        `${file} ${args.join(' ')} 失败：${result.stderr.trim() || `退出码 ${result.code}`}`,
      )
    return result.stdout
  }
  const systemctl = (...args: string[]) => check('systemctl', ['--user', ...args])
  const bootout = async () => {
    const result = await run('launchctl', ['bootout', target])
    // launchd 对未加载的服务返回 ESRCH 或找不到服务。
    if (![0, 3, 113].includes(result.code))
      throw new ServiceError('service_unavailable', `无法停止用户服务：${result.stderr.trim()}`)
  }
  if (platform === 'darwin') await check('launchctl', ['print', domain])
  else await systemctl('show-environment')

  const previous = await readDefinition(path)
  if (action === 'status') {
    const status: ServiceStatus = {
      installed: previous !== undefined,
      running: false,
      program_path: null,
      log_path: null,
      daemon: null,
    }
    if (platform === 'darwin') {
      const result = await run('launchctl', ['print', target])
      if (![0, 3, 113].includes(result.code))
        throw new ServiceError('service_unavailable', `无法查询用户服务：${result.stderr.trim()}`)
      status.running = result.code === 0 && /^\s*state = running\s*$/m.test(result.stdout)
      if (previous !== undefined) {
        const definition = Schema.decodeUnknownSync(LaunchAgent)(
          JSON.parse(await check('plutil', ['-convert', 'json', '-o', '-', path])),
        )
        status.program_path = definition.ProgramArguments[0] ?? null
        status.log_path = definition.StandardOutPath
      }
    } else {
      const state = await run('systemctl', ['--user', 'show', unit, '-p', 'ActiveState,MainPID,ExecStart'])
      if (state.code !== 0 && previous !== undefined)
        throw new ServiceError('service_unavailable', `无法查询用户服务：${state.stderr.trim()}`)
      status.running =
        state.code === 0 && /^ActiveState=active$/m.test(state.stdout) && /^MainPID=[1-9]\d*$/m.test(state.stdout)
      if (previous !== undefined) {
        const executable = /^ExecStart=("(?:\\.|[^"\\])*")/m.exec(previous)?.[1]
        status.program_path = executable
          ? String(JSON.parse(executable)).replaceAll('%%', '%').replaceAll('$$', '$')
          : null
        status.log_path = /^StandardOutput=append:(.*)$/m.exec(previous)?.[1]?.replaceAll('%%', '%') ?? null
      }
      const linger = await run('loginctl', ['show-user', options.user ?? userInfo().username, '-p', 'Linger']).catch(
        () => ({ code: 1, stdout: '', stderr: '' }),
      )
      status.linger =
        linger.code === 0 && /^Linger=(yes|no)$/m.test(linger.stdout) ? /^Linger=yes$/m.test(linger.stdout) : null
      if (status.linger === false)
        status.message = '退出登录后服务可能停止；需要持续运行时，请管理员为当前用户开启 linger'
      else if (status.linger === null) status.message = '无法查询 linger 状态，请管理员检查当前用户的登录服务'
    }
    status.daemon = await readDaemonStatus(status.log_path ? dirname(dirname(status.log_path)) : resolve(dataDirectory))
    return status
  }
  if (action === 'uninstall') {
    if (platform === 'darwin') await bootout()
    else if (previous !== undefined) await systemctl('disable', '--now', unit)
    await removeDefinition(path)
    if (platform === 'linux') await systemctl('daemon-reload')
    return { installed: false }
  }

  const directory = checkedPath(resolve(dataDirectory))
  try {
    await loadIdentity(directory)
  } catch (error) {
    if (isMissing(error)) throw new ServiceError('service_not_registered', '设备尚未注册，请先运行 batond register')
    throw error
  }
  const command: BatondCommand =
    options.command !== undefined
      ? options.command
      : isSea()
        ? await (await import('./update-install.ts')).bootstrapInstallation(directory)
        : currentBatondCommand()
  const definition = {
    command: { ...command, executable: await realpath(command.executable) },
    dataDirectory: directory,
  }
  const text = platform === 'darwin' ? renderLaunchAgent(definition) : renderSystemdUnit(definition)
  await ensurePrivateDirectory(directory)
  await ensurePrivateDirectory(join(directory, 'logs'))
  await writeDefinition(path, text)
  try {
    if (platform === 'darwin') {
      await bootout()
      await check('launchctl', ['bootstrap', domain, path])
    } else {
      await systemctl('daemon-reload')
      await systemctl('enable', '--now', unit)
      await systemctl('restart', unit)
    }
  } catch (error) {
    // 先恢复磁盘定义，即使命令管理器已不可用也保留原来的启动入口。
    if (previous === undefined) await removeDefinition(path)
    else await writeDefinition(path, previous)
    try {
      if (platform === 'darwin') {
        await bootout()
        if (previous !== undefined) await check('launchctl', ['bootstrap', domain, path])
      } else {
        if (previous === undefined) await systemctl('disable', '--now', unit)
        await systemctl('daemon-reload')
        if (previous !== undefined) {
          await systemctl('enable', '--now', unit)
          await systemctl('restart', unit)
        }
      }
    } catch (rollback) {
      throw new ServiceError(
        'service_unavailable',
        `${error instanceof Error ? error.message : '服务安装失败'}；定义文件已恢复，服务恢复失败：${rollback instanceof Error ? rollback.message : '请检查服务管理器'}`,
      )
    }
    throw error
  }
  return { installed: true }
}
