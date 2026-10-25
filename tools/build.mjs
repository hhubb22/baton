import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败：${result.signal ?? result.status}`)
  }
}

export function build(run = runCommand) {
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'])
  run('pnpm', ['--dir', 'web', 'typecheck'])
  // 中心构建同时生成 bundle 旁的 web/ 和 migrations/。
  run('pnpm', ['--filter', '@baton/server', 'build'])
  run('pnpm', ['--filter', '@baton/batond', 'build'])
  run(process.execPath, ['tools/package-batond.mjs', '--out', 'bin'])
}

if (import.meta.main) {
  try {
    build()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
