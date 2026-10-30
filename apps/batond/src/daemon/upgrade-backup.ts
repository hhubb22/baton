import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readdir, realpath, rm, statfs } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { Schema } from 'effect'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { IPCError } from './ipc.ts'

/** 仅排除 IPC 和进程锁；WAL、身份、业务数据及完整输出都保留。 */
export async function dataEntries(directory: string) {
  const entries: Array<{ path: string; directory: boolean; bytes: number }> = []
  async function walk(relative: string) {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const parts = relative ? relative.split(sep) : []
      const root = parts.length === 0
      const thread = parts.length === 2 && (parts[0] === 'threads' || parts[0] === 'executions')
      const probe = parts.length === 2 && parts[0] === 'agent-probes'
      if (
        (root &&
          (name === 'ipc' ||
            ['daemon.lock', 'identity.lock', 'browse-roots.lock', 'project-exec.lock'].includes(name))) ||
        (thread && ['worker.lock', 'launch.lock'].includes(name)) ||
        (probe && name === 'probe.lock') ||
        ((root || thread || probe) && /^\.lock-[a-f0-9-]{36}$/.test(name))
      )
        continue
      const path = join(relative, name)
      const info = await lstat(join(directory, path))
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new IPCError('upgrade_backup_required', `备份不支持链接或特殊文件：${path}`)
      entries.push({ path, directory: info.isDirectory(), bytes: info.isFile() ? info.size : 0 })
      if (info.isDirectory()) await walk(path)
    }
  }
  await walk('')
  return entries
}

export async function backupSpace(directory: string) {
  directory = await realpath(directory)
  const parent = dirname(directory)
  await access(parent, constants.W_OK)
  const disk = await statfs(parent)
  const block = disk.frsize || disk.bsize
  const bytes = (await dataEntries(directory)).reduce(
    (total, entry) => total + Math.ceil(entry.bytes / block) * block + block,
    0,
  )
  // 按备份所在文件系统估算分配块，并为清单与升级状态保留 1 MiB。
  const required_bytes = bytes + 1024 * 1024
  const available_bytes = disk.bavail * block
  if (
    !Number.isSafeInteger(required_bytes) ||
    !Number.isSafeInteger(available_bytes) ||
    available_bytes < required_bytes
  )
    throw new IPCError(
      'upgrade_insufficient_space',
      `备份空间不足：需要 ${required_bytes} 字节，可用 ${available_bytes} 字节`,
    )
  return { required_bytes, available_bytes }
}

async function dataChecksum(directory: string) {
  const hash = createHash('sha256')
  for (const entry of await dataEntries(directory)) {
    hash.update(JSON.stringify([entry.path, entry.directory, entry.bytes]) + '\n')
    if (!entry.directory)
      for await (const chunk of createReadStream(join(directory, entry.path))) hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

const BackupRecord = Schema.Struct({
  operation_id: Schema.String,
  source_directory: Schema.String,
  checksum: Schema.String,
})

export async function createUpgradeBackup(directory: string, operationId: string) {
  await backupSpace(directory)
  const parent = join(dirname(directory), `${basename(directory)}.upgrade-backups`)
  await ensurePrivateDirectory(parent)
  const backup_path = join(parent, `${operationId}-${randomUUID()}`)
  await ensurePrivateDirectory(backup_path)
  const data = join(backup_path, 'data')
  await ensurePrivateDirectory(data)
  try {
    for (const entry of await dataEntries(directory)) {
      const target = join(data, entry.path)
      if (entry.directory) await mkdir(target, { recursive: true, mode: 0o700 })
      else await copyFile(join(directory, entry.path), target, constants.COPYFILE_EXCL)
    }
    const backup_checksum = await dataChecksum(data)
    if (backup_checksum !== (await dataChecksum(directory)))
      throw new IPCError('upgrade_backup_required', '复制期间数据发生变化，未取得一致备份')
    await writePrivateFileAtomic(
      join(backup_path, 'backup.json'),
      JSON.stringify({ operation_id: operationId, source_directory: directory, checksum: backup_checksum }),
    )
    return { backup_path, backup_checksum }
  } catch (error) {
    // 仅删除本次未完成的副本，原数据和已有备份保持不变。
    await rm(backup_path, { recursive: true, force: true })
    throw error
  }
}

export async function verifyUpgradeBackup(path: string, checksum: string, operationId: string, directory: string) {
  const record = Schema.decodeUnknownSync(BackupRecord)(
    JSON.parse((await readPrivateFile(join(path, 'backup.json'))).toString('utf8')),
  )
  if (
    record.operation_id !== operationId ||
    record.source_directory !== directory ||
    record.checksum !== checksum ||
    (await dataChecksum(join(path, 'data'))) !== checksum
  )
    throw new IPCError('upgrade_backup_required', '升级备份与记录不符，保留现场并核对备份')
}
