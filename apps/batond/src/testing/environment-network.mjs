import { connectWebSocket } from '../daemon/transport.ts'

const [plain, secure, socket] = process.argv.slice(2)
try {
  const http = await fetch(plain).then((response) => response.text())
  const https = await fetch(secure).then((response) => response.text())
  const connection = await connectWebSocket(socket, { signal: AbortSignal.timeout(5000) })
  connection.close()
  console.log(JSON.stringify({ http, https, websocket: true }))
} catch {
  console.error('Environment network check failed')
  process.exitCode = 1
}
