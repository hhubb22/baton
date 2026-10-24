import { cp, mkdtemp, rm, readdir, realpath, lstat, mkdir, copyFile, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'baton-package-'))
try {
  const installed = join(root, 'installed')
  await cp(resolve(process.argv[2] ?? 'bin'), installed, {
    recursive: true,
    verbatimSymlinks: true,
  })
  const bundle = await realpath(join(installed, 'sidecars/project-agent'))
  async function checkLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if ((await lstat(path)).isSymbolicLink()) {
        const target = relative(bundle, await realpath(path))
        assert.ok(!target.startsWith('..') && !isAbsolute(target), 'bundle 链接指向包外')
      } else if (entry.isDirectory()) await checkLinks(path)
    }
  }
  await checkLinks(bundle)
  const host = join(installed, process.platform === 'win32' ? 'batond.exe' : 'batond')
  // PATH 只提供 Node，防止开发机独立安装的 Runtime 掩盖 bundle 缺失。
  const isolatedPath = join(root, 'path')
  await mkdir(isolatedPath)
  const node = join(isolatedPath, process.platform === 'win32' ? 'node.exe' : 'node')
  if (process.platform === 'win32') await copyFile(process.execPath, node)
  else await symlink(process.execPath, node)
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !['PATH', 'NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())),
    ),
    PATH: isolatedPath,
    BATON_PROJECT_RUNTIME_DATA_DIR: join(root, 'credentials'),
    BATON_SIDECAR_HOST: host,
  }
  function run(binary, args, input) {
    const result = spawnSync(binary, args, {
      input,
      env,
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    })
    assert.equal(result.status, 0, `分发包命令失败：${result.stderr}`)
    return result.stdout
  }
  assert.equal(run(node, ['--version']).trim(), process.version, '隔离 PATH 中的 Node 无法独立运行')
  console.log(`隔离 PATH 的 Node.js 已验证：${process.version}`)
  const cli = join(bundle, 'dist/project-agent/src/cli.js')
  assert.equal(run(process.execPath, [cli, '--version']).trim(), '0.1.0')
  const signedOut = run(host, ['subscriptions'])
  assert.match(signedOut, /batond login openai-codex/)
  assert.match(signedOut, /batond login xai/)
  const dir = env.BATON_PROJECT_RUNTIME_DATA_DIR,
    file = join(dir, 'openai-codex.json')
  run(host, ['sidecar-file', 'protect-dir', dir])
  const credential = JSON.stringify({
    type: 'oauth',
    access: 'fixture-access',
    refresh: 'fixture-refresh',
    expires: 0,
  })
  run(host, ['sidecar-file', 'write', dir, file], credential)
  assert.equal(run(host, ['sidecar-file', 'read', dir, file]), credential)
  const result = JSON.parse(run(process.execPath, [cli, 'probe']))
  assert.equal(result.version, '0.1.0')
  assert.equal(result.providers.find((p) => p.provider === 'openai-codex').status, 'available')
  const signedIn = run(host, ['subscriptions'])
  assert.match(signedIn, /openai-codex \(ChatGPT\): 已登录/)
  assert.ok(!signedIn.includes('fixture-access'))
  assert.ok(!signedIn.includes('fixture-refresh'))
  const hiddenBundle = join(root, 'hidden-project-agent')
  await rename(bundle, hiddenBundle)
  try {
    const missing = spawnSync(host, ['subscriptions'], {
      env,
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    })
    assert.ifError(missing.error)
    assert.equal(missing.status, 1, '缺少 bundle 时应失败，不能使用 PATH 中的 Runtime')
    assert.match(missing.stderr, /完整安装包/)
    assert.equal(missing.stdout, '')
  } finally {
    await rename(hiddenBundle, bundle)
  }
  console.log('分发包搬迁、隔离 PATH、版本、probe、subscriptions 和私有文件验证通过')
} finally {
  await rm(root, { recursive: true, force: true })
}
