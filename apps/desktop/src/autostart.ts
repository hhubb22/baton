import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function autostart(userData: string) {
  const file = join(userData, 'login-start.json')
  let enabled = true
  try {
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof saved === 'boolean') enabled = saved
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const set = async (value: boolean) => {
    app.setLoginItemSettings({ openAtLogin: value, args: ['--hidden'] })
    await writeFile(file, JSON.stringify(value), { mode: 0o600 })
    enabled = value
  }
  await set(enabled)
  return { enabled: () => enabled, set }
}
