import { createModels, fauxProvider } from '@earendil-works/pi-ai'
import { runProjectRuntimeCLI } from '../src/command.js'

const models = createModels()
const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] })
models.setProvider(faux.provider)
faux.setResponses([
  async () => {
    process.stderr.write('model-waiting\n')
    setInterval(() => {}, 1000)
    return new Promise<never>(() => {})
  },
])
await runProjectRuntimeCLI(['run'], { models })
