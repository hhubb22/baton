import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * 默认安装的所有文件都在 ~/.baton 下：data/ 放设备数据，program/ 放程序，backups/ 放升级备份。
 * 显式指定的数据目录自带程序目录 installation/，备份放在同级的 <目录>.upgrade-backups。
 */
export const batonHome = () => join(homedir(), '.baton')
export const defaultDataDirectory = () => join(batonHome(), 'data')
export const defaultCredentialsDirectory = () => join(defaultDataDirectory(), 'credentials')

export function isDefaultDataDirectory(directory: string): boolean {
  const target = resolve(directory)
  if (target === defaultDataDirectory()) return true
  // 服务和更新流程传入的是真实路径，主目录本身可能是链接。
  try {
    return target === join(realpathSync(homedir()), '.baton', 'data')
  } catch {
    return false
  }
}

export const programRoot = (dataDirectory: string) =>
  isDefaultDataDirectory(dataDirectory)
    ? join(dirname(resolve(dataDirectory)), 'program')
    : join(dataDirectory, 'installation')

export const backupRoot = (dataDirectory: string) =>
  isDefaultDataDirectory(dataDirectory)
    ? join(dirname(resolve(dataDirectory)), 'backups')
    : join(dirname(dataDirectory), `${basename(dataDirectory)}.upgrade-backups`)
