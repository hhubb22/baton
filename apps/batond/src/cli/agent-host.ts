import { releaseMetadata, type ReleaseMetadata } from '@baton/protocol/release'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isSea } from 'node:sea'
import { Effect } from 'effect'
import { runAgentHost, type AgentHostModule } from '../agent-host/host.ts'
import type { AgentHostPaths } from '../agent-host/paths.ts'
import type { HostedAgentType } from '../agents/catalog.ts'

const modules = {
  cursor: () => import('../agents/cursor/host-module.ts').then((module) => module.cursorAgentHostModule),
  pi: () => import('../agents/pi/host-module.ts').then((module) => module.piAgentHostModule),
  codex: () => import('../agents/codex/host-module.ts').then((module) => module.codexAgentHostModule),
  kiro: () => import('../agents/kiro/host-module.ts').then((module) => module.kiroAgentHostModule),
  antigravity: () => import('../agents/antigravity/host-module.ts').then((module) => module.antigravityAgentHostModule),
} satisfies Record<HostedAgentType, () => Promise<AgentHostModule>>

export const runAgentHostCommand = Effect.fn('AgentHost.runAgentHostCommand')(function* (
  agentType: string,
  paths: AgentHostPaths,
) {
  if (!Object.hasOwn(modules, agentType)) return yield* Effect.fail(new Error(`Unknown Agent host type: ${agentType}`))
  const module = yield* Effect.tryPromise(() => modules[agentType as HostedAgentType]())
  return yield* runAgentHost(module, { agentType, paths })
})

interface HostInstallation {
  readonly release: ReleaseMetadata
  readonly agents: HostedAgentType[]
  readonly nativeModules: string[]
}

export async function inspectAgentHostModules(): Promise<HostInstallation> {
  const agents = Object.keys(modules) as HostedAgentType[]
  await Promise.all(agents.map((agentType) => modules[agentType]()))
  const nativeModules: string[] = []
  if (isSea()) {
    const load = createRequire(join(dirname(process.execPath), 'package.json'))
    const keyring = load('@napi-rs/keyring') as { AsyncEntry?: unknown }
    if (typeof keyring.AsyncEntry !== 'function') throw new Error('keyring native module is incomplete')
    nativeModules.push('@napi-rs/keyring')
    const { inspectCursorSdk } = await import('../agents/cursor/sdk-inspection.ts')
    const sdk = inspectCursorSdk()
    if (sdk.missingAssets.length) throw new Error('Cursor platform assets are incomplete')
    const Parser = load(sdk.treeSitter)
    const parser = new Parser()
    parser.setLanguage(load(sdk.treeSitterBash))
    if (parser.parse('echo baton').rootNode.type !== 'program') throw new Error('Cursor parser failed')
    nativeModules.push('cursor/tree-sitter', 'cursor/tree-sitter-bash')
  }
  return { release: releaseMetadata(), agents, nativeModules }
}
