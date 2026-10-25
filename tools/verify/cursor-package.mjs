import { createRequire } from 'node:module'
import { join } from 'node:path'

const [installed, workspace] = process.argv.slice(2)
const require = createRequire(join(installed, 'package.json'))
const denyNetwork = () => {
  throw new Error('Network is disabled in the packaging probe')
}
globalThis.fetch = denyNetwork
for (const name of ['node:http', 'node:https']) {
  const http = require(name)
  http.request = http.get = denyNetwork
}
const { SqliteLocalAgentStore } = require('@cursor/sdk/sqlite')
const store = await SqliteLocalAgentStore.open({ workspaceRef: workspace, stateRoot: join(workspace, 'state') })
await store.dispose()
console.log(JSON.stringify({ sqliteStore: true, modelCalls: 0 }))
