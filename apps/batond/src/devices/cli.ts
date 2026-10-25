import { parseArgs } from 'node:util'
import { hasCode } from '../platform/errors.ts'
import { loadBrowseRoots, updateBrowseRoots } from './roots.ts'
import { defaultProjectShell, writeProjectExec } from './config.ts'

const projectExecNotice =
  '开启后，Project Agent 可以执行任意命令，以本设备用户身份运行。Baton 不提供沙箱；登记目录只限制启动位置，命令仍可访问目录之外的文件。任务结果或仓库内容中的恶意指令可能诱导执行任意命令。每条命令和输出都会保存到对话。只在信任 Project Agent 的设备上开启。'

/** 本机管理命令在未注册、未连接中心时也可使用。 */
export async function runDeviceCLI(
  command: 'files' | 'project-exec',
  args: string[],
  dataDirectory: string,
  output: (text: string) => void = console.log,
): Promise<void> {
  if (command === 'files') {
    const [action, ...flags] = args
    const { values, positionals } = parseArgs({
      args: flags,
      allowPositionals: true,
      options: {
        'data-dir': { type: 'string', default: dataDirectory },
        id: { type: 'string' },
        path: { type: 'string' },
      },
    })
    if (positionals.length || !action)
      throw new Error('用法：files add --id <标识> --path <目录> | remove --id <标识> | list')
    const directory = values['data-dir']!
    if (action === 'list' && !values.id && !values.path) {
      const roots = await loadBrowseRoots(directory).catch((error) => {
        if (hasCode(error, 'ENOENT')) return []
        throw error
      })
      if (!roots.length) output('还没有浏览目录')
      for (const root of roots) output(`${root.id}\t${root.path}`)
      return
    }
    if (action === 'add' && values.id && values.path) {
      await updateBrowseRoots(directory, { action: 'add', path: values.path, id: values.id })
      output(`已登记浏览目录 ${values.id}`)
      return
    }
    if (action === 'remove' && values.id && !values.path) {
      await updateBrowseRoots(directory, { action: 'remove', path: values.id })
      output(`已移除浏览目录 ${values.id}`)
      return
    }
    throw new Error('用法：files add --id <标识> --path <目录> | remove --id <标识> | list')
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'data-dir': { type: 'string', default: dataDirectory },
      shell: { type: 'string', default: defaultProjectShell() },
      enabled: { type: 'string' },
    },
  })
  if (positionals.length || (values.enabled !== 'true' && values.enabled !== 'false'))
    throw new Error('必须显式指定 --enabled=true 或 --enabled=false')
  const enabled = values.enabled === 'true'
  if (enabled) output(projectExecNotice)
  const config = await writeProjectExec(values['data-dir']!, { enabled, shell: values.shell! })
  output(`Project Agent 命令执行：${enabled}，shell：${config.shell}`)
}
