import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import type { RuntimeAgent } from '@baton/protocol'
import { baseEnvironment, makeEnvironmentReader, resolveEnvironment } from '../environment.ts'
import { fileVersion } from '../platform/file-version.ts'
import { hasCode } from '../platform/errors.ts'
import { agentCatalog, type HostedAgentType } from './catalog.ts'
import { probeAgents } from './probe.ts'

export function makeAgentProbe(options: {
  readonly dataDirectory: string
  readonly now?: () => number
  readonly fingerprint?: (type: HostedAgentType) => Promise<string | undefined>
  readonly probe?: (type: HostedAgentType, signal: AbortSignal) => Promise<RuntimeAgent>
}): (signal: AbortSignal) => Promise<readonly RuntimeAgent[]> {
  const now = options.now ?? Date.now
  const environment = makeEnvironmentReader(options.dataDirectory)
  const fingerprint =
    options.fingerprint ??
    (async (type: HostedAgentType) => {
      try {
        const config = await environment()
        const { env } = resolveEnvironment(config, baseEnvironment(process.env), { agent: type })
        const home = env.HOME ?? env.USERPROFILE ?? homedir()
        const codex = env.CODEX_HOME ?? join(home, '.codex')
        const pi = env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent')
        const files =
          type === 'codex'
            ? [join(codex, 'auth.json'), join(codex, 'config.toml')]
            : type === 'pi'
              ? ['auth.json', 'models.json', 'settings.json'].map((name) => join(pi, name))
              : type === 'kiro'
                ? [
                    join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'kiro-cli', 'data.sqlite3'),
                    join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'kiro-cli', 'data.sqlite3-wal'),
                  ]
                : []
        const binary = type === 'kiro' ? 'kiro-cli' : type
        const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
        const paths = [
          ...files,
          ...[...new Set((env.PATH ?? '').split(delimiter).filter(Boolean))].flatMap((directory) =>
            extensions.map((extension) => resolve(directory, binary + extension)),
          ),
        ]
        const versions = await Promise.all(
          paths.map(async (path) => {
            const version = await fileVersion(path)
            try {
              const target = await realpath(path)
              return [version, await fileVersion(target)]
            } catch (error) {
              if (hasCode(error, 'ENOENT')) return [version, 'missing']
              throw error
            }
          }),
        )
        return createHash('sha256')
          .update(JSON.stringify([env, config.revision, versions]))
          .digest('hex')
      } catch {
        return undefined
      }
    })
  const probe =
    options.probe ??
    (async (type, signal) =>
      (await probeAgents({ dataDirectory: options.dataDirectory, agentTypes: [type], signal }))[0]!)
  const entries = new Map<
    HostedAgentType,
    {
      fingerprint: string
      result: { ok: true; report: RuntimeAgent } | { ok: false; error: unknown }
      failures: number
      retryAt: number
    }
  >()
  return async (signal) => {
    signal.throwIfAborted()
    return Promise.all(
      (Object.keys(agentCatalog) as HostedAgentType[]).map(async (type) => {
        const version = await fingerprint(type)
        signal.throwIfAborted()
        const previous = entries.get(type)
        if (version !== undefined && previous?.fingerprint === version && now() < previous.retryAt) {
          if (!previous.result.ok) throw previous.result.error
          return structuredClone(previous.result.report)
        }
        let result: { ok: true; report: RuntimeAgent } | { ok: false; error: unknown }
        try {
          result = { ok: true, report: await probe(type, signal) }
        } catch (error) {
          signal.throwIfAborted()
          result = { ok: false, error }
        }
        signal.throwIfAborted()
        if (version !== undefined) {
          const failures =
            result.ok && result.report.status === 'available'
              ? 0
              : (previous?.fingerprint === version ? previous.failures : 0) + 1
          const delay = failures ? Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)) : 300_000
          entries.set(type, {
            fingerprint: version,
            result: result.ok ? { ok: true, report: structuredClone(result.report) } : result,
            failures,
            retryAt: now() + delay,
          })
        }
        if (!result.ok) throw result.error
        return result.report
      }),
    )
  }
}
