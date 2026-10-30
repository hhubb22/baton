import { parseArgs } from 'node:util'
import { buildInfo } from './lib/release.mjs'
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

export function build(run = runCommand, release = {}) {
  const identity = buildInfo(release)
  const args = identity.version === 'development' ? [] : ['--version', identity.version, '--commit', identity.commit]
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'])
  run('pnpm', ['--dir', 'web', 'typecheck'])
  // 中心构建同时生成 bundle 旁的 web/ 和 migrations/。
  run('pnpm', ['--filter', '@baton/server', 'build', ...args])
  const keys = release['update-keys'] ? ['--update-keys', release['update-keys']] : []
  run('pnpm', ['--filter', '@baton/batond', 'build', ...args, ...keys])
  run(process.execPath, ['tools/package-batond.mjs', '--out', 'bin', ...args, ...keys])
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: { version: { type: 'string' }, commit: { type: 'string' }, 'update-keys': { type: 'string' } },
    })
    build(runCommand, values)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
