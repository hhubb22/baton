import { spawn, type ChildProcess } from 'node:child_process'

/** NSIS 接管安装与重新启动；旧客户端仍负责先停止自己的 daemon。 */
export async function launchNSIS(
  file: string,
  start: (file: string, args: string[]) => ChildProcess = (file, args) =>
    spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }),
): Promise<void> {
  const child = start(file, ['--updated', '/S', '--force-run'])
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', resolve)
  })
  child.unref()
}
