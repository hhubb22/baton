import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { runProjectRuntimeCLI } from '../src/command.js'

if (process.argv[2] === 'probe') {
  console.log(
    JSON.stringify({
      version: '0.1.0',
      providers: [
        { provider: 'openai-codex', status: 'available', models: [{ id: 'trace-model', name: 'Trace model' }] },
      ],
    }),
  )
} else {
  const models = createModels()
  const faux = fauxProvider({
    provider: 'openai-codex',
    models: [{ id: 'trace-model', contextWindow: 24000, maxTokens: 2000 }],
  })
  models.setProvider(faux.provider)
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall('devices.list', {}, { id: 'truncated' })], { stopReason: 'length' }),
  ])
  await runProjectRuntimeCLI(process.argv.slice(2), { models })
}
