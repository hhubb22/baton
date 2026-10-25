import { randomUUID } from 'node:crypto'
import { rename, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { SubscriptionLoginResponse } from '@baton/protocol'
import { ensurePrivateDirectory, readPrivateFile } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { acquireProcessLock } from '../platform/lock.ts'
import { loadBrowseRoots } from '../daemon/roots.ts'
import {
  browseFiles,
  makeDeviceService,
  readProjectExec,
  scanRuntimeRoots,
  setProjectExec,
  updateBrowseRoots,
  writeProjectExec,
  sanitizeOrigin,
} from './index.ts'
import { RuntimeRunner, defaultWatchdogCommand } from '../project/runner.ts'
import { startProcessWatchdog } from '../platform/process.ts'

const temporary: string[] = []
const services: Array<{ close(): Promise<void> }> = []
async function directory(): Promise<string> {
  const path = await realpath(await makePrivateTempDirectory('baton-devices-'))
  temporary.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const request = (root_id?: string, path?: string) => ({
  type: 'files.browse' as const,
  operation_id: randomUUID(),
  ...(root_id ? { root_id } : {}),
  ...(path ? { path } : {}),
})

it('serializes canonical-root add/remove and preserves an explicitly empty configuration', async () => {
  const data = await directory(),
    root = await directory(),
    second = await directory()
  const alias = join(await directory(), 'alias')
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await Promise.all([
    updateBrowseRoots(data, 'add', root),
    updateBrowseRoots(data, 'add', alias),
    updateBrowseRoots(data, 'add', second),
  ])
  const roots = await loadBrowseRoots(data)
  expect(roots).toHaveLength(2)
  expect(new Set(roots.map((root) => root.path))).toEqual(new Set([root, second]))
  await Promise.all([updateBrowseRoots(data, 'remove', alias), updateBrowseRoots(data, 'remove', alias)])
  expect(await loadBrowseRoots(data)).toHaveLength(1)
  await updateBrowseRoots(data, 'remove', roots.find((entry) => entry.path === second)!.id)
  expect(await loadBrowseRoots(data)).toEqual([])
  // Windows 的私有文件由父目录 ACL 保护，mode 不表示 DACL。
  if (process.platform !== 'win32') expect((await stat(join(data, 'browse-roots.json'))).mode & 0o777).toBe(0o600)
})

it('keeps shell configuration under concurrent toggles and fails closed on invalid files or held locks', async () => {
  const data = await directory()
  expect(await readProjectExec(data)).toMatchObject({ enabled: false })
  await writeProjectExec(data, { enabled: false, shell: '/bin/local-shell' })
  await Promise.all([setProjectExec(data, true), setProjectExec(data, false), setProjectExec(data, true)])
  expect(await readProjectExec(data)).toMatchObject({ enabled: true, shell: '/bin/local-shell' })
  const release = await acquireProcessLock(join(data, 'project-exec.lock'))
  try {
    await expect(setProjectExec(data, false)).rejects.toThrow('lock')
  } finally {
    await release()
  }
  await writeFile(join(data, 'project-exec.json'), '{"enabled":true,"shell":"/bin/sh","secret":"bad"}')
  await expect(readProjectExec(data)).rejects.toMatchObject({ code: 'config_unavailable' })
})

describe('bounded authorized file previews', () => {
  it('uses the same realpath boundary for directories, attachments, symlinks and replaced roots', async () => {
    const data = await directory(),
      root = await directory(),
      outside = await directory()
    await writeFile(join(root, 'log.txt'), 'permitted log')
    await writeFile(join(outside, 'secret.txt'), 'outside secret')
    await ensurePrivateDirectory(join(root, 'nested'))
    await writeFile(join(root, 'nested/log.txt'), 'permitted log')
    await symlink(join(root, 'nested'), join(root, 'inside-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const [registered] = await updateBrowseRoots(data, 'add', root)
    expect(await browseFiles(data, request(registered!.id, 'inside-link/log.txt'))).toMatchObject({
      ok: true,
      kind: 'file',
      content: 'permitted log',
    })
    // Windows 的文件符号链接需要额外权限；目录 junction 在上面覆盖链接内读取。
    if (process.platform !== 'win32') {
      await symlink(join(root, 'log.txt'), join(root, 'inside-file-link'))
      expect(await browseFiles(data, request(registered!.id, 'inside-file-link'))).toMatchObject({
        ok: true,
        kind: 'file',
        content: 'permitted log',
      })
    }
    expect(await browseFiles(data, request(registered!.id, 'escape/secret.txt'))).toMatchObject({
      ok: false,
      code: 'path_escaped',
    })
    expect(await browseFiles(data, request(registered!.id, '../secret.txt'))).toMatchObject({
      ok: false,
      code: 'invalid_path',
    })
    expect(await browseFiles(data, request('unregistered', 'log.txt'))).toMatchObject({
      ok: false,
      code: 'root_forbidden',
    })
    expect(await browseFiles(data, request(registered!.id, 'missing'))).toMatchObject({ ok: false, code: 'not_found' })
    await rename(root, `${root}-moved`)
    temporary.push(`${root}-moved`)
    await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await browseFiles(data, request(registered!.id, 'secret.txt'))).toMatchObject({
      ok: false,
      code: 'path_escaped',
    })
  })
  it('pages directory entries, preserves UTF-8 truncation and rejects images and special files', async () => {
    const data = await directory(),
      root = await directory()
    const [registered] = await updateBrowseRoots(data, 'add', root)
    await Promise.all(
      Array.from({ length: 205 }, (_, i) => writeFile(join(root, `item-${String(i).padStart(3, '0')}`), 'x')),
    )
    const page = await browseFiles(data, request(registered!.id))
    expect(page.entries).toHaveLength(200)
    expect(page.truncated).toBe(true)
    const next = await browseFiles(data, { ...request(registered!.id), cursor: page.next_cursor! })
    expect(next.entries).toHaveLength(5)
    await writeFile(join(root, 'large.txt'), 'a'.repeat(65535) + '中文')
    const preview = await browseFiles(data, request(registered!.id, 'large.txt'))
    expect(preview).toMatchObject({ ok: true, truncated: true, remainder: { offset: 65535 } })
    expect(Buffer.byteLength(preview.content!)).toBe(65535)
    await writeFile(join(root, 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]))
    expect(await browseFiles(data, request(registered!.id, 'image.png'))).toMatchObject({ ok: false, code: 'not_text' })
    await writeFile(join(root, 'multibyte.txt'), '中文')
    expect(await browseFiles(data, request(registered!.id, 'multibyte.txt'))).toMatchObject({
      content: '中文',
      truncated: false,
    })
    const canceled = new AbortController()
    canceled.abort()
    expect(await browseFiles(data, request(registered!.id), canceled.signal)).toMatchObject({
      ok: false,
      code: 'unavailable',
    })
  })
})

it('scans bounded local Git metadata and removes credentials from origins', async () => {
  const data = await directory(),
    root = await directory(),
    outside = await directory()
  await updateBrowseRoots(data, 'add', root)
  await ensurePrivateDirectory(join(root, '.git'))
  await writeFile(
    join(root, '.git/config'),
    '[remote "origin"]\n url = https://local-user:local-pass@git.example/team/repo.git?token=hidden#frag\n',
  )
  await symlink(outside, join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  const report = await scanRuntimeRoots(data)
  expect(report.repos).toEqual([{ path: root, origin: 'git.example/team/repo' }])
  expect(JSON.stringify(report)).not.toMatch(/local-pass|hidden/)
  expect(sanitizeOrigin('git@git.example:team/repo.git')).toBe('git.example/team/repo')
  expect(sanitizeOrigin('file:///private/repo')).toBeUndefined()
  await writeFile(join(outside, 'config'), '[remote "origin"]\nurl = https://secret.invalid/private\n')
  // Windows 用目录 junction 构造越界元数据，避免文件符号链接所需的额外权限。
  if (process.platform === 'win32') {
    await rm(join(root, '.git'), { recursive: true })
    await symlink(outside, join(root, '.git'), 'junction')
  } else {
    await rm(join(root, '.git/config'))
    await symlink(join(outside, 'config'), join(root, '.git/config'))
  }
  expect(await scanRuntimeRoots(data)).toMatchObject({ repos: [{ path: root }], truncated: true })
})

it('confirms persisted device settings and reports unavailable login without fabricated runtime', async () => {
  const data = await directory(),
    root = await directory()
  await updateBrowseRoots(data, 'add', root)
  let changes = 0
  const service = await makeDeviceService({
    dataDirectory: data,
    onChanged: () => {
      changes++
    },
  })
  services.push(service)
  const operation_id = randomUUID()
  expect(await service.handle({ type: 'node.project_exec_set', operation_id, enabled: true })).toMatchObject({
    type: 'node.project_exec_result',
    operation_id,
    ok: true,
    exec: { enabled: true },
  })
  expect(JSON.parse((await readPrivateFile(join(data, 'project-exec.json'))).toString())).toMatchObject({
    enabled: true,
  })
  expect(await service.collect()).not.toHaveProperty('project_runtime')
  expect(
    await service.handle({ type: 'node.subscription_login', operation_id: randomUUID(), provider: 'xai' }),
  ).toMatchObject({ ok: false, code: 'login_unavailable' })
  expect(changes).toBeGreaterThan(0)
})

it('uses local Runtime processes for concurrent same-provider login, cancellation and report refresh', async () => {
  const data = await directory(),
    root = await directory()
  await updateBrowseRoots(data, 'add', root)
  const watchdog = process.platform === 'win32' ? undefined : await startProcessWatchdog(defaultWatchdogCommand())
  if (watchdog) services.push(watchdog)
  const runner = new RuntimeRunner(
    {
      dataDir: data,
      runtimeCommand: {
        file: process.execPath,
        args: [
          '-e',
          `
    const action=process.argv[1], provider=process.argv[2];
    if(action==='probe') { console.log(JSON.stringify({version:'0.1.0',providers:[{provider:'xai',status:'login_required'}]})); }
    else if(provider==='openai-codex') { setInterval(()=>{},1000); }
    else { console.log(JSON.stringify({type:'device_code',provider,verification_uri:'https://auth.invalid/device',user_code:String(process.pid),expires_in_seconds:600})); setInterval(()=>{},1000); }
  `,
        ],
      },
    },
    watchdog,
    { add: async () => {}, remove: async () => {} },
  )
  services.push(runner)
  let completed = 0
  const runtime = {
    probe: (signal?: AbortSignal) => runner.probe(signal),
    startDeviceLogin: (
      provider: string,
      signal?: AbortSignal,
      onDone?: () => void,
    ): Promise<SubscriptionLoginResponse> =>
      runner.startDeviceLogin(provider, signal, () => {
        completed++
        onDone?.()
      }),
  }
  const service = await makeDeviceService({ dataDirectory: data, runtime })
  services.push(service)
  const logins = await Promise.all(
    [1, 2].map(() => service.handle({ type: 'node.subscription_login', operation_id: randomUUID(), provider: 'xai' })),
  )
  expect(logins).toMatchObject([{ ok: true }, { ok: true }])
  expect(completed).toBe(1)
  expect(await service.collect()).toMatchObject({
    project_runtime: { providers: [{ provider: 'xai', status: 'login_required' }] },
  })
  const abort = new AbortController()
  abort.abort()
  expect(
    await service.handle(
      { type: 'node.subscription_login', operation_id: randomUUID(), provider: 'xai' },
      abort.signal,
    ),
  ).toMatchObject({ ok: false, code: 'login_unavailable' })
  const waitingAbort = new AbortController()
  const waiting = service.handle(
    { type: 'node.subscription_login', operation_id: randomUUID(), provider: 'openai-codex' },
    waitingAbort.signal,
  )
  const cancelTimer = setTimeout(() => waitingAbort.abort(), 150)
  try {
    expect(await waiting).toMatchObject({ ok: false, code: 'login_unavailable' })
  } finally {
    clearTimeout(cancelTimer)
  }
  await runner.close()
  expect(completed).toBeGreaterThanOrEqual(2)
}, 15000)
