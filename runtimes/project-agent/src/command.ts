import { releaseMetadata } from '@baton/protocol/release.mjs'
import { Effect, Tracer } from 'effect'
import type { Models } from '@earendil-works/pi-ai'
import { captureTrace, telemetryLayer, withTraceSpan } from '@baton/telemetry'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { StdioClient, frames, writeFrame } from './stdio.js'
import { probe, runtimeModels, registeredProvider, credentials } from './auth.js'
import { checkedRPC, type Request } from './protocol.js'
import { createDeviceCodeLoginInteraction, createLoginInteraction } from './login.js'
import { Connections } from './connections.js'

class ReportedRunFailure extends Error {}

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
      const telemetryEnv = { ...process.env }
      for (const name of Object.keys(process.env)) if (name.startsWith('OTEL_')) delete process.env[name]
      const bootstrap = await client.call({ operation: 'memory_bootstrap' })
      const boot = await checkedRPC(async () => bootstrap).call({ operation: 'memory_bootstrap' })
      await Effect.runPromise(
        withTraceSpan(
          Effect.gen(function* () {
            const trace = yield* captureTrace
            const tracer = yield* Tracer.Tracer
            const root = yield* Effect.currentSpan
            let initial = true
            let result = 'unknown'
            const rpc = checkedRPC((request) => {
              if (initial && request.operation === 'memory_bootstrap') {
                initial = false
                return Promise.resolve(bootstrap)
              }
              return client.call({ ...request, ...(trace ? { trace } : {}) }).then((response) => {
                if (request.operation === 'finish' && response?.ok) result = 'completed'
                if (request.operation === 'report_failure' && response?.ok) {
                  result = 'failed'
                  if (request.reason) root.attribute('baton.error.code', request.reason)
                }
                return response
              })
            })
            yield* Effect.tryPromise(() =>
              runMemory(rpc, budget.maxOutputTokens, cancel.signal, undefined, {
                span: (name, attributes, task) =>
                  Effect.runPromise(
                    withTraceSpan(
                      Effect.gen(function* () {
                        const span = yield* Effect.currentSpan
                        return yield* Effect.tryPromise(() =>
                          task((updates) => {
                            for (const [key, value] of Object.entries(updates)) span.attribute(key, value)
                          }),
                        )
                      }),
                      name,
                      trace,
                      { attributes },
                    ).pipe(Effect.provideService(Tracer.Tracer, tracer)),
                  ),
              }),
            ).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  result = cancel.signal.aborted ? 'stopped' : 'failed'
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => root.attribute('baton.turn.result', cancel.signal.aborted ? 'stopped' : result)),
              ),
            )
            if (cancel.signal.aborted) result = 'stopped'
            root.attribute('baton.turn.result', result)
            if (result === 'failed') return yield* Effect.fail(new ReportedRunFailure())
          }),
          'baton.project.run',
          boot.trace,
          {
            attributes: {
              'baton.project.run.id': process.env.BATON_PROJECT_RUN_ID ?? '',
              ...(boot.project_id ? { 'baton.project.id': boot.project_id } : {}),
              'baton.memory.job.id': boot.job_id,
            },
          },
        ).pipe(
          Effect.catch((error) => (error instanceof ReportedRunFailure ? Effect.void : Effect.fail(error))),
          Effect.provide(telemetryLayer('baton-project-runtime', telemetryEnv)),
        ),
      )
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
      const telemetryEnv = { ...process.env }
      for (const name of Object.keys(process.env)) if (name.startsWith('OTEL_')) delete process.env[name]
      const bootstrap = await client.call({ operation: 'bootstrap' })
      const boot = await checkedRPC(async () => bootstrap).call({ operation: 'bootstrap' })
      await Effect.runPromise(
        withTraceSpan(
          Effect.gen(function* () {
            const trace = yield* captureTrace
            const tracer = yield* Tracer.Tracer
            const root = yield* Effect.currentSpan
            let initial = true
            let result = 'unknown'
            const rpc = checkedRPC((request) => {
              if (initial && request.operation === 'bootstrap') {
                initial = false
                return Promise.resolve(bootstrap)
              }
              return client.call({ ...request, ...(trace ? { trace } : {}) }).then((response) => {
                if (request.operation === 'finish' && response?.ok) result = 'completed'
                if (request.operation === 'report_failure' && response?.ok) {
                  result = 'failed'
                  if (request.reason) root.attribute('baton.error.code', request.reason)
                }
                return response
              })
            })
            yield* Effect.tryPromise(() =>
              new ProjectRuntime(rpc, models, undefined, undefined, budget, {
                span: (name, attributes, task) =>
                  Effect.runPromise(
                    withTraceSpan(
                      Effect.gen(function* () {
                        const span = yield* Effect.currentSpan
                        return yield* Effect.tryPromise(() =>
                          task((updates) => {
                            for (const [key, value] of Object.entries(updates)) span.attribute(key, value)
                          }),
                        )
                      }),
                      name,
                      trace,
                      { attributes },
                    ).pipe(Effect.provideService(Tracer.Tracer, tracer)),
                  ),
              }).start(),
            ).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  result = 'failed'
                }),
              ),
              Effect.ensuring(Effect.sync(() => root.attribute('baton.turn.result', result))),
            )
            if (result === 'failed') return yield* Effect.fail(new ReportedRunFailure())
          }),
          'baton.project.run',
          boot.trace,
          {
            attributes: {
              'baton.project.run.id': process.env.BATON_PROJECT_RUN_ID ?? '',
              ...(boot.project_id ? { 'baton.project.id': boot.project_id } : {}),
              'baton.conversation.id': boot.project.conversation.id,
              'gen_ai.request.model': boot.project.agent.model,
            },
          },
        ).pipe(
          Effect.catch((error) => (error instanceof ReportedRunFailure ? Effect.void : Effect.fail(error))),
          Effect.provide(telemetryLayer('baton-project-runtime', telemetryEnv)),
        ),
      )
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
