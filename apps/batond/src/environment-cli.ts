import { spawnSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Effect, Schema } from 'effect'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { resolveCommandPath } from '@t3tools/shared/shell'
import {
  importEnvironment,
  initializeEnvironment,
  loadEnvironment,
  resolveEnvironment,
  updateEnvironment,
} from './environment.ts'
import { readPrivateFile } from './platform/private.ts'
import { readProcessLock } from './platform/lock.ts'
import { identityMatches } from './platform/identity.ts'

export async function runEnvironmentCLI(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'data-dir': { type: 'string', default: join(homedir(), '.baton-ts') },
      scope: { type: 'string', default: 'device' },
      shell: { type: 'boolean' },
    },
  })
  const [action, name] = positionals
  const directory = values['data-dir']!
  if ((action === 'import' || action === 'init') && !name) {
    const existing = await loadEnvironment(directory)
    if (action === 'init' && existing.revision) {
      console.log(JSON.stringify({ revision: existing.revision }))
      return
    }
    let source = process.env
    let diagnostic: string | undefined
    if (values.shell) {
      const result = spawnSync(process.env.SHELL || '/bin/sh', ['-ilc', 'env -0'], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      })
      if (result.error || result.status !== 0) {
        if (action === 'import') throw new Error('无法读取登录 shell 环境')
        diagnostic = '无法读取登录 shell 环境，使用当前进程环境'
      } else {
        try {
          source = Object.fromEntries(
            result.stdout
              .split('\0')
              .filter(Boolean)
              .map((entry) => {
                const index = entry.indexOf('=')
                if (index <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0, index)))
                  throw new Error('登录 shell 环境输出无效')
                return [entry.slice(0, index), entry.slice(index + 1)]
              }),
          )
        } catch (error) {
          if (action === 'import') throw error
          diagnostic = '登录 shell 环境输出无效，使用当前进程环境'
        }
      }
    }
    const config =
      action === 'init'
        ? await initializeEnvironment(directory, source, diagnostic)
        : await importEnvironment(directory, source)
    console.log(JSON.stringify({ revision: config.revision }))
    return
  }
  if ((action === 'list' || action === 'doctor') && !name) {
    const config = await loadEnvironment(directory)
    const scope = values.scope!
    const match = /^project:(.+?)(?::agent:(cursor|pi|codex|kiro))?$/.exec(scope)
    const agent = match?.[2] ?? /^agent:(cursor|pi|codex|kiro)$/.exec(scope)?.[1]
    if (scope !== 'device' && !match && !agent) throw new Error('环境作用范围无效')
    const options = { ...(match?.[1] ? { project: match[1] } : {}), ...(agent ? { agent } : {}) }
    const result = resolveEnvironment(config, process.env, options)
    const origins: Record<string, string> = Object.fromEntries(Object.keys(result.env).map((key) => [key, 'system']))
    const layers: Array<[string, Readonly<Record<string, string | null>>]> = [
      ['imported', config.imported],
      ['device', config.scopes.device ?? {}],
    ]
    if (options.project) layers.push([`project:${options.project}`, config.scopes[`project:${options.project}`] ?? {}])
    if (options.agent) layers.push([`agent:${options.agent}`, config.scopes[`agent:${options.agent}`] ?? {}])
    if (options.project && options.agent) layers.push([scope, config.scopes[scope] ?? {}])
    for (const [origin, layer] of layers)
      for (const [key, value] of Object.entries(layer)) {
        if (value === null) delete origins[key]
        else if (result.env[key] !== undefined) origins[key] = origin
      }
    const diagnostics = [...(config.diagnostic ? [config.diagnostic] : []), ...result.diagnostics]
    if (action === 'doctor' && config.revision)
      diagnostics.push('daemon 的代理和证书设置在重启后生效；新 Agent 进程使用当前配置')
    if (action === 'list') {
      console.log(
        JSON.stringify({ revision: result.revision, names: Object.keys(result.env).sort(), origins, diagnostics }),
      )
      return
    }
    const paths: Record<string, boolean> = { SSH_AUTH_SOCK: false }
    for (const name of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SSH_AUTH_SOCK']) {
      const path = result.env[name]
      if (path)
        paths[name] = await stat(path).then(
          (value) => (name === 'SSH_AUTH_SOCK' ? value.isSocket() : true),
          () => false,
        )
    }
    const executables: Record<string, boolean> = {}
    for (const executable of ['codex', 'pi', 'cursor', 'kiro-cli']) {
      executables[executable] =
        (await Effect.runPromise(
          resolveCommandPath(executable, { env: result.env }).pipe(Effect.provide(NodeServices.layer)),
        )) !== null
    }
    const ProcessStatus = Schema.Struct({ pid: Schema.Number, revision: Schema.String })
    const processes: Array<{ kind: string; pid: number; revision: string; stale: boolean }> = []
    const inspect = async (kind: string, statusPath: string, lockPath: string) => {
      try {
        const status = Schema.decodeUnknownSync(ProcessStatus)(
          JSON.parse((await readPrivateFile(statusPath)).toString()),
        )
        const lock = await readProcessLock(lockPath)
        if (lock && lock.pid === status.pid && (await identityMatches(lock)))
          processes.push({ kind, ...status, stale: status.revision !== config.revision })
      } catch {
        /* A missing or invalid status is not a live process. */
      }
    }
    await inspect('daemon', join(directory, 'environment-process.json'), join(directory, 'daemon.lock'))
    const threads = await readdir(join(directory, 'threads')).catch(() => [])
    for (const thread of threads)
      await inspect(
        'worker',
        join(directory, 'threads', thread, 'environment-process.json'),
        join(directory, 'threads', thread, 'worker.lock'),
      )
    console.log(
      JSON.stringify({
        revision: result.revision,
        names: Object.keys(result.env).sort(),
        origins,
        diagnostics,
        paths,
        executables,
        processes,
      }),
    )
    return
  }
  if ((action === 'set' || action === 'unset' || action === 'reset') && name && positionals.length === 2) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      /^(NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|LD_PRELOAD|DYLD_.*|BASH_ENV|BATON_.*|OTEL_.*)$/i.test(name)
    )
      throw new Error('环境变量名称无效或受禁止')
    if (!/^(device|agent:(cursor|pi|codex|kiro)|project:.+)$/.test(values.scope!)) throw new Error('环境作用范围无效')
    let input = ''
    if (action === 'set')
      for await (const chunk of process.stdin) {
        input += String(chunk)
        if (input.length > 65536) throw new Error('环境变量值过长')
      }
    const config = await updateEnvironment(directory, (current) => {
      const layer = { ...current.scopes[values.scope!] }
      if (action === 'reset') delete layer[name]
      else layer[name] = action === 'unset' ? null : input.replace(/\r?\n$/, '')
      return { ...current, scopes: { ...current.scopes, [values.scope!]: layer } }
    })
    console.log(JSON.stringify({ revision: config.revision }))
    return
  }
  throw new Error(
    '用法：env import [--shell] | list | doctor | set|unset|reset <名称> [--scope <范围>] [--data-dir <目录>]；set 从标准输入读取值',
  )
}
