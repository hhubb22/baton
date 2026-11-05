import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * 默认安装的所有文件都在 ~/.baton 下：data/ 放设备数据，program/ 放程序。
 * 显式指定的数据目录自带程序目录 installation/。
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
