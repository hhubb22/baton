import { createServer, request, type IncomingMessage, type RequestOptions } from 'node:http'
import { promisify } from 'node:util'
import { hasCode } from '../platform/errors.ts'
import { chmod } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { vi } from 'vite-plus/test'
import { releaseMetadata, type ReleaseMetadata } from '@baton/protocol/release'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'

export async function writeUpgradePackage(directory: string, release: ReleaseMetadata = releaseMetadata()) {
  await ensurePrivateDirectory(directory)
  await writePrivateFileAtomic(join(directory, 'release.json'), JSON.stringify(release))
  await writePrivateFileAtomic(join(directory, 'version.json'), JSON.stringify(release))
  const binary = join(directory, process.platform === 'win32' ? 'batond.exe' : 'batond')
  await writePrivateFileAtomic(
    binary,
    `#!/usr/bin/env node
const release = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'version.json')))
if (process.argv[2] === '--version' || process.argv[2] === '--binary-version') process.stdout.write(JSON.stringify(release))
else if (process.argv[2] === 'update-preflight') process.stdout.write(JSON.stringify({ release, required_bytes: 1, available_bytes: 1000000 }))
else process.exit(1)
`,
  )
  await chmod(binary, 0o700)
}

export async function upgradeCenter(cleanup: Array<() => Promise<unknown>>) {
  let release: ReleaseMetadata = releaseMetadata()
  const requests: Array<{ path?: string; method?: string; authenticated: boolean }> = []
  const server = createServer((req, res) => {
    requests.push({
      ...(req.url ? { path: req.url } : {}),
      ...(req.method ? { method: req.method } : {}),
      authenticated: req.headers.authorization !== undefined,
    })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(release))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => (error && !hasCode(error, 'ERR_SERVER_NOT_RUNNING') ? reject(error) : resolve()))
    })
  cleanup.push(close)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local HTTP address')
  return {
    url: `https://127.0.0.1:${address.port}`,
    requests,
    close,
    setRelease(value: ReleaseMetadata) {
      release = value
    },
  }
}

// 仅替换 TLS 传输，仍向本机 HTTP 服务发送实际 GET，不连接外部服务。
export function upgradeHTTPSFixture() {
  return {
    request(url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) {
      if (!url.startsWith('https://127.0.0.1:')) throw new Error('升级测试只允许本机中心')
      return request(url.replace('https:', 'http:'), options, callback)
    },
  }
}

// 各平台均用 Node 启动离线 batond 替身；--version 来自独立文件，实际创建子进程。
export async function upgradeProcessFixture() {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const execFile = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      ['batond', 'batond.exe'].includes(basename(args[0])) &&
      Array.isArray(args[1]) &&
      (args[1][0] === '--version' || args[1][0] === '--binary-version' || args[1][0] === 'update-preflight')
    )
      return Reflect.apply(actual.execFile, undefined, [process.execPath, [args[0], ...args[1]], ...args.slice(2)])
    return Reflect.apply(actual.execFile, undefined, args)
  }
  Object.defineProperty(execFile, promisify.custom, { value: Reflect.get(actual.execFile, promisify.custom) })
  return { ...actual, execFile }
}
