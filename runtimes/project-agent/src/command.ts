import { releaseMetadata } from '@baton/protocol/release.mjs'
import type { Models } from '@earendil-works/pi-ai'
import { createLogger, describeError } from '@baton/logging'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { StdioClient, frames, writeFrame } from './stdio.js'
import { probe, runtimeModels, registeredProvider, credentials } from './auth.js'
import { checkedRPC, type Request } from './protocol.js'
import { createDeviceCodeLoginInteraction, createLoginInteraction } from './login.js'
import { Connections } from './connections.js'
import { openProjectTranscript } from './transcript.js'

const log = createLogger('baton-project-runtime')

async function ipc(request: Request): Promise<unknown> {
  const endpoint = process.env.BATON_PROJECT_RUNTIME_ENDPOINT,
    token = process.env.BATON_PROJECT_RUNTIME_TOKEN
  if (!endpoint || !token) throw new Error('runtime_endpoint_missing')
  const socket = createConnection(endpoint)
  socket.setTimeout(32_000, () => socket.destroy(new Error('runtime_timeout')))
  try {
    await writeFrame(socket, { token, request })
    for await (const value of frames(socket)) return value
    throw new Error('runtime_closed')
  } finally {
    socket.destroy()
  }
}
export async function runProjectRuntimeCLI(args: string[], options?: { models?: Models }): Promise<void> {
  const [command, provider] = args
  if (command === '--version') {
    console.log(JSON.stringify(releaseMetadata()))
    return
  }
  if (command === 'probe') {
    console.log(JSON.stringify(await probe()))
    return
  }
  if (command === 'embedding-key' || command === 'connection-key' || command === 'connection-save') {
    if (process.stdin.isTTY) throw new Error('api_key_stdin_required')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += data.length
      if (bytes > (command === 'connection-save' ? 64 * 1024 : 16 * 1024)) throw new Error('api_key_invalid')
      chunks.push(data)
    }
    const key = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    if (command === 'connection-key') await new Connections(credentials()).setKey(provider, key)
    else if (command === 'connection-save') await new Connections(credentials()).save(JSON.parse(key))
    else if (command === 'embedding-key') {
      const { saveEmbeddingKey } = await import('./embeddings.js')
      await saveEmbeddingKey(provider, key)
    }
    console.error(command === 'connection-save' ? '连接配置已保存。' : 'API key 已保存。')
    return
  }
  if (command === 'connection-delete') {
    await new Connections(credentials()).delete(provider)
    return
  }
  if (command === 'connection-get') {
    const connection = (await new Connections(credentials()).list()).find((item) => item.id === provider)
    if (!connection) throw new Error('connection_not_found')
    const { key_needed: _keyNeeded, ...metadata } = connection
    console.log(JSON.stringify(metadata))
    return
  }
  if (command === 'logout') {
    registeredProvider(provider)
    await credentials().delete(provider)
    return
  }
  if (command === 'login-device') {
    if (!registeredProvider(provider).deviceCode) throw new Error('device_code_unsupported')
    const cancel = new AbortController()
    const abort = () => cancel.abort()
    process.on('SIGINT', abort)
    process.on('SIGTERM', abort)
    process.stdin.on('close', abort)
    process.stdin.resume()
    try {
      const models = await runtimeModels()
      await models.login(
        provider,
        'oauth',
        createDeviceCodeLoginInteraction((info) => {
          process.stdout.write(
            JSON.stringify({
              type: 'device_code',
              provider,
              verification_uri: info.verificationUri,
              user_code: info.userCode,
              expires_in_seconds: info.expiresInSeconds ?? 900,
            }) + '\n',
          )
        }, cancel.signal),
        { agentName: 'Baton Project Runtime' },
      )
    } finally {
      process.off('SIGINT', abort)
      process.off('SIGTERM', abort)
      process.stdin.off('close', abort)
      process.stdin.destroy()
    }
    return
  }
  if (command === 'login') {
    if (!registeredProvider(provider).provider.auth.oauth) throw new Error('oauth_unsupported')
    const models = await runtimeModels()
    const input = createInterface({
      input: process.stdin,
      output: process.stderr,
    })
    const cancel = new AbortController()
    input.on('SIGINT', () => cancel.abort())
    input.on('close', () => cancel.abort())
    try {
      await models.login(
        provider,
        'oauth',
        createLoginInteraction(
          (message, signal) => input.question(message, { signal }),
          (text) => {
            process.stderr.write(text)
          },
          cancel.signal,
        ),
        { agentName: 'Baton Project Runtime' },
      )
    } finally {
      input.close()
    }
    console.error('登录完成。')
    return
  }
  if (command !== 'run' && command !== 'memory')
    throw new Error(
      'usage: baton-project-runtime run|memory|probe|login <provider>|login-device <provider>|connection-key <id> < key-file|embedding-key <profile> < key-file|--version',
    )
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      'max-output-tokens': { type: 'string' },
      'max-model-calls': { type: 'string' },
    },
  })
  const budget = {
    ...(values['max-output-tokens'] === undefined ? {} : { maxOutputTokens: Number(values['max-output-tokens']) }),
    ...(values['max-model-calls'] === undefined ? {} : { maxModelCalls: Number(values['max-model-calls']) }),
  }
  if (command === 'memory') {
    const { runMemory } = await import('./memory.js')
    const client = new StdioClient(process.stdin, process.stdout)
    const cancel = new AbortController()
    const abort = () => cancel.abort()
    process.on('SIGTERM', abort)
    process.on('SIGINT', abort)
    process.stdin.on('close', abort)
    try {
      const bootstrap = await client.call({ operation: 'memory_bootstrap' })
      const boot = await checkedRPC(async () => bootstrap).call({ operation: 'memory_bootstrap' })
      const transcript =
        boot.project_id && process.env.BATON_PROJECT_RUN_ID
          ? await openProjectTranscript(boot.project_id, process.env.BATON_PROJECT_RUN_ID)
          : undefined
      transcript?.write('run.started', {
        project_id: boot.project_id,
        run_id: process.env.BATON_PROJECT_RUN_ID,
        lease_epoch: Number(process.env.BATON_PROJECT_LEASE_EPOCH ?? 0),
        run_kind: 'memory',
        memory_job_id: boot.job_id,
        memory_kind: boot.kind,
        provider: boot.provider,
        model: boot.model,
      })
      try {
        let initial = true
        const rpc = checkedRPC((request) => {
          if (initial && request.operation === 'memory_bootstrap') {
            initial = false
            return Promise.resolve(bootstrap)
          }
          return client.call(request)
        })
        log.info('project_runtime.run_started', {
          run_id: process.env.BATON_PROJECT_RUN_ID ?? '',
          ...(boot.project_id ? { project_id: boot.project_id } : {}),
          run_kind: 'memory',
        })
        try {
          await runMemory(rpc, budget.maxOutputTokens, cancel.signal, undefined, transcript)
          log.info('project_runtime.run_finished', {
            run_id: process.env.BATON_PROJECT_RUN_ID ?? '',
            run_kind: 'memory',
          })
        } catch (error) {
          log.error('project_runtime.run_failed', {
            run_id: process.env.BATON_PROJECT_RUN_ID ?? '',
            run_kind: 'memory',
            ...describeError(error),
          })
          throw error
        }
      } finally {
        await transcript?.close()
      }
    } finally {
      process.off('SIGTERM', abort)
      process.off('SIGINT', abort)
      process.stdin.off('close', abort)
      process.stdin.destroy()
    }
    return
  }
  const models = options?.models ?? (await runtimeModels())
  const { ProjectRuntime } = await import('./runtime.js')
  if (process.env.BATON_PROJECT_RUNTIME_TRANSPORT === 'stdio') {
    const client = new StdioClient(process.stdin, process.stdout)
    try {
      const bootstrap = await client.call({ operation: 'bootstrap' })
      const boot = await checkedRPC(async () => bootstrap).call({ operation: 'bootstrap' })
      const transcript =
        boot.project_id && process.env.BATON_PROJECT_RUN_ID
          ? await openProjectTranscript(boot.project_id, process.env.BATON_PROJECT_RUN_ID)
          : undefined
      transcript?.write('run.started', {
        project_id: boot.project_id,
        run_id: process.env.BATON_PROJECT_RUN_ID,
        lease_epoch: Number(process.env.BATON_PROJECT_LEASE_EPOCH ?? 0),
        run_kind: 'foreground',
        memory_job_id: null,
        provider: boot.project.agent.provider,
        model: boot.project.agent.model,
        conversation_id: boot.project.conversation.id,
      })
      try {
        let initial = true
        const rpc = checkedRPC((request) => {
          if (initial && request.operation === 'bootstrap') {
            initial = false
            return Promise.resolve(bootstrap)
          }
          return client.call(request)
        })
        log.info('project_runtime.run_started', {
          run_id: process.env.BATON_PROJECT_RUN_ID ?? '',
          ...(boot.project_id ? { project_id: boot.project_id } : {}),
          run_kind: 'foreground',
        })
        try {
          await new ProjectRuntime(rpc, models, undefined, undefined, budget, transcript).start()
          log.info('project_runtime.run_finished', {
            run_id: process.env.BATON_PROJECT_RUN_ID ?? '',
            run_kind: 'foreground',
          })
        } catch (error) {
          log.error('project_runtime.run_failed', {
            run_id: process.env.BATON_PROJECT_RUN_ID ?? '',
            run_kind: 'foreground',
            ...describeError(error),
          })
          throw error
        }
      } finally {
        await transcript?.close()
      }
    } finally {
      process.stdin.destroy()
    }
  } else await new ProjectRuntime(checkedRPC(ipc), models, undefined, undefined, budget).start()
}

export function reportProjectRuntimeError(error: unknown): void {
  const messages: Record<string, string> = {
    unsupported_provider: '该 provider 未注册，请运行 probe 查看已实现的 provider。',
    api_key_unsupported: '该 provider 不支持 API key，请使用订阅登录。',
    api_key_stdin_required: '从标准输入读取 API key：connection-key <id> < 私有密钥文件。',
    api_key_invalid: 'API key 不能为空，须为单行文本且不超过 16 KiB。',
    device_code_unsupported: '该 provider 支持终端登录，请使用 login <provider>。',
  }
  console.error(
    (error instanceof Error ? messages[error.message] : undefined) ??
      'Project Runtime 执行失败，请检查版本、登录状态和节点连接。',
  )
  process.exitCode = 1
  process.stdin.destroy()
}
