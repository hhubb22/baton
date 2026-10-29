import { execFile, spawn } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Schema } from 'effect'

const Preferences = Schema.Struct({ editor: Schema.NullOr(Schema.String) })

export async function editorPreferences(userData: string) {
  const file = join(userData, 'editor.json')
  let editor: string | null = null
  try {
    editor = Schema.decodeUnknownSync(Preferences)(JSON.parse(await readFile(file, 'utf8'))).editor
    if (editor !== null && !isAbsolute(editor)) throw new Error('编辑器无效')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('无法读取编辑器设置。')
  }
  return {
    get: () => editor,
    async set(path: string | null) {
      if (path !== null && !isAbsolute(path)) throw new Error('请选择编辑器应用。')
      await writeFile(file + '.tmp', JSON.stringify({ editor: path }), { mode: 0o600 })
      await rename(file + '.tmp', file)
      editor = path
    },
  }
}

// 编辑器路径只能由客户端原生设置选择，网页不能指定程序或参数。
export function launchEditor(editor: string, directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error('无法打开编辑器，请在桌面设置中重新选择。'))
    if (process.platform === 'darwin') {
      execFile('/usr/bin/open', ['-a', editor, '--', directory], (error) => {
        if (error) failed()
        else resolve()
      })
      return
    }
    const child = spawn(editor, [directory], { windowsHide: true, detached: true, stdio: 'ignore' })
    child.once('error', failed)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
