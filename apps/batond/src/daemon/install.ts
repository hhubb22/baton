import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BUILD } from '@baton/protocol/release'
import { processLockIsHeld } from '../platform/lock.ts'
import { backupRoot, batonHome, defaultDataDirectory, isDefaultDataDirectory, programRoot } from '../platform/layout.ts'
import { isMissing } from './identity.ts'

const shimMarker = '# Baton 固定入口，由 batond install 生成'
export const shimPath = () => join(homedir(), '.local', 'bin', 'batond')
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const renderShim = (launcher: string) => `#!/bin/sh\n${shimMarker}\nexec ${shellQuote(launcher)} "$@"\n`

async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function ownsShim(path: string) {
  try {
    if ((await lstat(path)).isSymbolicLink()) return false
    return (await readFile(path, 'utf8')).includes(shimMarker)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** 写入 PATH 上的入口；同名的其他程序不覆盖，由用户决定如何处理。 */
export async function writeShim(path: string, launcher: string) {
  if ((await exists(path)) && !(await ownsShim(path)))
    throw new Error(`${path} 已是其他程序，请移走后重新运行 batond install`)
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.batond-${randomUUID()}`)
  try {
    await writeFile(temporary, renderShim(launcher), { flag: 'wx', mode: 0o755 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** 把当前安装包放进默认目录并建立命令入口，之后在任意目录都能运行 batond。 */
export async function installBatond() {
  if (process.platform === 'win32') throw new Error('Windows 请使用 Baton 桌面客户端')
  const dataDirectory = defaultDataDirectory()
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const { bootstrapInstallation } = await import('./update-install.ts')
  const command = await bootstrapInstallation(dataDirectory)
  const entry = shimPath()
  await writeShim(entry, command.executable)
  const onPath = (process.env.PATH ?? '').split(delimiter).includes(dirname(entry))
  return {
    installed: true,
    entry,
    on_path: onPath,
    data_directory: dataDirectory,
    program_directory: programRoot(dataDirectory),
    ...(onPath ? {} : { message: `请把 ${dirname(entry)} 加入 PATH` }),
  }
}

async function diskBytes(path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const name of await readdir(path)) total += await diskBytes(join(path, name))
  return total
}

async function serviceStatus(dataDirectory: string) {
  const { manageService } = await import('./service.ts')
  const status = await manageService('status', dataDirectory).catch(() => undefined)
  if (!status || !('program_path' in status)) return undefined
  return {
    ...status,
    data_directory: status.log_path ? dirname(dirname(status.log_path)) : null,
  }
}

const sameDirectory = (left: string, right: string) => {
  if (resolve(left) === resolve(right)) return true
  return isDefaultDataDirectory(left) && isDefaultDataDirectory(right)
}

/** 汇总这份安装的位置、服务状态和占用空间，并指出会造成误判的旧文件。 */
export async function diagnoseInstallation(dataDirectory: string) {
  const program = programRoot(dataDirectory)
  const backups = backupRoot(dataDirectory)
  const versions = join(program, 'versions')
  const installedVersions = await readdir(versions).then(
    (names) => names.filter((name) => /^[a-f0-9]{64}$/.test(name)),
    (error: unknown) => {
      if (isMissing(error)) return []
      throw error
    },
  )
  const service = await serviceStatus(dataDirectory)
  const entry = shimPath()
  const warnings: string[] = []
  if (service?.data_directory && !sameDirectory(service.data_directory, dataDirectory))
    warnings.push(`服务使用的数据目录是 ${service.data_directory}，当前查看的是 ${dataDirectory}，请加上 --data-dir`)
  if (installedVersions.length > 2) warnings.push(`保留了 ${installedVersions.length} 个版本，下次更新完成后只留两个`)
  for (const legacy of [join(homedir(), '.baton-ts'), join(batonHome(), 'project-runtime')])
    if (await exists(legacy)) warnings.push(`发现旧目录 ${legacy}，确认不再需要后可以删除`)
  return {
    version: BUILD.version,
    commit: BUILD.commit,
    data_directory: dataDirectory,
    program_directory: program,
    backup_directory: backups,
    entry: { path: entry, installed: await ownsShim(entry) },
    service: service
      ? {
          installed: service.installed,
          running: service.running,
          program_path: service.program_path,
          data_directory: service.data_directory,
        }
      : null,
    versions: installedVersions.length,
    bytes: {
      data: await diskBytes(dataDirectory),
      program: await diskBytes(program),
      backups: await diskBytes(backups),
    },
    warnings,
  }
}

async function assertStopped(dataDirectory: string) {
  for (let n = 0; n < 100 && (await processLockIsHeld(join(dataDirectory, 'daemon.lock'))); n++) await delay(100)
  if (await processLockIsHeld(join(dataDirectory, 'daemon.lock')))
    throw new Error('batond 仍在运行，请先退出桌面客户端或停止前台进程')
  const { upgradeBlockers } = await import('./upgrade.ts')
  const { blockers } = await upgradeBlockers(dataDirectory)
  if (blockers.some((blocker) => blocker.kind === 'process' || blocker.reason === 'worker_alive'))
    throw new Error('仍有 Thread 进程在运行，请等它们退出后重试')
}

/** 移除服务和程序；只有 purge 才删除身份、Thread 数据、凭据和备份。 */
export async function uninstallBatond(dataDirectory: string, options: { purge: boolean }) {
  if (process.platform === 'win32') throw new Error('Windows 请卸载 Baton 桌面客户端')
  const target = resolve(dataDirectory)
  const isDefault = isDefaultDataDirectory(target)
  if (
    options.purge &&
    !isDefault &&
    !(await exists(join(target, 'identity.json'))) &&
    !(await exists(join(target, 'node.db')))
  )
    throw new Error(`${target} 不像 Baton 数据目录，未删除`)
  const service = await serviceStatus(target)
  const ownsService = service?.installed && (!service.data_directory || sameDirectory(service.data_directory, target))
  if (ownsService) {
    const { manageService } = await import('./service.ts')
    await manageService('uninstall', target)
  }
  await assertStopped(target)
  const removed: string[] = []
  const remove = async (path: string) => {
    if (!(await exists(path))) return
    await rm(path, { recursive: true, force: true })
    removed.push(path)
  }
  await remove(programRoot(target))
  if (isDefault && (await ownsShim(shimPath()))) await remove(shimPath())
  if (options.purge) {
    await remove(backupRoot(target))
    await remove(target)
    if (isDefault) await rmdir(dirname(target)).catch(() => undefined)
  }
  return { uninstalled: true, removed, ...(options.purge ? {} : { kept: [target, backupRoot(target)] }) }
}
