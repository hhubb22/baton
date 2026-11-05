import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BUILD } from '@baton/protocol/release'
import { processLockIsHeld } from '../platform/lock.ts'
import { batonHome, defaultDataDirectory, isDefaultDataDirectory, programRoot } from '../platform/layout.ts'
import { isMissing } from './identity.ts'

const shimMarker = '# Baton 固定入口，由 batond install 生成'
const binaryName = process.platform === 'win32' ? 'batond.exe' : 'batond'
export const shimPath = () => join(homedir(), '.local', 'bin', 'batond')
export const installedBatond = (dataDirectory: string) => join(programRoot(dataDirectory), binaryName)
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

async function stopDaemon(dataDirectory: string) {
  const lock = join(dataDirectory, 'daemon.lock')
  if (!(await processLockIsHeld(lock))) return
  const { ControlClient } = await import('./control-client.ts')
  await new ControlClient(dataDirectory).shutdown().catch(() => undefined)
  for (let attempt = 0; attempt < 100 && (await processLockIsHeld(lock)); attempt++) await delay(100)
  if (await processLockIsHeld(lock)) throw new Error('本机守护进程未停止，请先退出桌面客户端或停止前台进程后重试')
}

async function replaceProgram(source: string, target: string) {
  const from = await realpath(source)
  const to = (await exists(target)) ? await realpath(target) : target
  if (from === to) return false
  const staging = join(dirname(target), `.installation-${randomUUID()}`)
  const previous = join(dirname(target), `.installation-previous-${randomUUID()}`)
  let moved = false
  try {
    await cp(from, staging, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
    if (await exists(target)) {
      await rename(target, previous)
      moved = true
    }
    await rename(staging, target)
  } catch (error) {
    if (moved) await rename(previous, target).catch(() => undefined)
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(previous, { recursive: true, force: true })
  }
  return true
}

/** 把当前 SEA 安装包替换到程序目录并建立命令入口。 */
export async function installBatond(
  dataDirectory = defaultDataDirectory(),
  sourceDirectory = dirname(process.execPath),
) {
  if (process.platform === 'win32') throw new Error('Windows 请使用 Baton 桌面客户端')
  const target = resolve(dataDirectory)
  await mkdir(target, { recursive: true, mode: 0o700 })
  const { isUserServiceInstalled, manageService } = await import('./service.ts')
  const serviceInstalled = await isUserServiceInstalled(target)
  await stopDaemon(target)
  const program = programRoot(target)
  await mkdir(dirname(program), { recursive: true, mode: 0o700 })
  const replaced = await replaceProgram(sourceDirectory, program)
  const entry = shimPath()
  await writeShim(entry, installedBatond(target))
  if (serviceInstalled) await manageService('install', target)
  const onPath = (process.env.PATH ?? '').split(delimiter).includes(dirname(entry))
  return {
    installed: true,
    replaced,
    entry,
    on_path: onPath,
    data_directory: target,
    program_directory: program,
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

/** 只读汇总安装位置、入口、服务和占用空间。 */
export async function diagnoseInstallation(dataDirectory: string) {
  const program = programRoot(dataDirectory)
  const service = await serviceStatus(dataDirectory)
  const entry = shimPath()
  const warnings: string[] = []
  if (service?.data_directory && !sameDirectory(service.data_directory, dataDirectory))
    warnings.push(`服务使用的数据目录是 ${service.data_directory}，当前查看的是 ${dataDirectory}，请加上 --data-dir`)
  for (const legacy of [join(homedir(), '.baton-ts'), join(batonHome(), 'project-runtime')])
    if (await exists(legacy)) warnings.push(`发现旧目录 ${legacy}，确认不再需要后可以删除`)
  return {
    version: BUILD.version,
    commit: BUILD.commit,
    data_directory: dataDirectory,
    program_directory: program,
    installed: await exists(installedBatond(dataDirectory)),
    entry: { path: entry, installed: await ownsShim(entry) },
    service: service
      ? {
          installed: service.installed,
          running: service.running,
          program_path: service.program_path,
          data_directory: service.data_directory,
        }
      : null,
    bytes: {
      data: await diskBytes(dataDirectory),
      program: await diskBytes(program),
    },
    warnings,
  }
}

async function assertStopped(dataDirectory: string) {
  for (let n = 0; n < 100 && (await processLockIsHeld(join(dataDirectory, 'daemon.lock'))); n++) await delay(100)
  if (await processLockIsHeld(join(dataDirectory, 'daemon.lock')))
    throw new Error('batond 仍在运行，请先退出桌面客户端或停止前台进程')
}

/** 移除服务和程序；只有 purge 才删除身份、Thread 数据和凭据。 */
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
  await stopDaemon(target)
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
    await remove(target)
    if (isDefault) await rmdir(dirname(target)).catch(() => undefined)
  }
  return { uninstalled: true, removed, ...(options.purge ? {} : { kept: [target] }) }
}
