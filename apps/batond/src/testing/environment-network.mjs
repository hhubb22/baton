import { connectWebSocket } from '../daemon/transport.ts'
import { request } from 'node:https'

const [plain, secure, socket] = process.argv.slice(2)
try {
  const http = await fetch(plain).then((response) => response.text())
  const https = await fetch(secure).then((response) => response.text())
  const updateRequest = await new Promise((resolve, reject) => {
    const outgoing = request(secure, { signal: AbortSignal.timeout(5000) }, (response) => {
      let body = ''
      response.on('data', (chunk) => {
        body += String(chunk)
      })
      response.once('end', () => resolve(body))
      response.once('error', reject)
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
  const connection = await connectWebSocket(socket, { signal: AbortSignal.timeout(5000) })
  connection.close()
  console.log(JSON.stringify({ http, https, updateRequest, websocket: true }))
} catch {
  console.error('Environment network check failed')
  process.exitCode = 1
}
