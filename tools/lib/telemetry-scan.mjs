import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// 安装包和网页产物不得包含外部遥测导出、配置开关或回放库。
// 标记分片拼接，避免工具源码本身命中删除项搜索。
const marker = (...parts) => parts.join('')
const markers = [
  marker('OTEL', '_EXPORTER', '_OTLP'),
  marker('BATON', '_TELEMETRY', '_FORWARD'),
  marker('BATON', '_TELEMETRY', '_LOCAL', '_RELAY'),
  marker('BATON', '_WEB', '_SESSION', '_REPLAY'),
  marker('@hyper', 'dx/', 'otel-', 'web'),
  marker('@opentelemetry/', 'exporter-', 'trace-', 'otlp-', 'http'),
  marker('rr', 'web'),
].map((value) => ({ value, bytes: Buffer.from(value) }))

async function scanFile(path) {
  const longest = Math.max(...markers.map((marker) => marker.bytes.length))
  let tail = Buffer.alloc(0)
  for await (const chunk of createReadStream(path)) {
    const data = Buffer.concat([tail, chunk])
    for (const marker of markers)
      if (data.includes(marker.bytes)) throw new Error(`安装包包含已删除的遥测标记：${marker.value}`)
    tail = data.subarray(Math.max(0, data.length - longest + 1))
  }
}

async function scanDirectory(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    // 只检查 Baton 自己的 bundle、网页产物和安装布局；第三方包可能附带未加载的功能源码，
    // releases/ 保存旧安装包，不属于当前产物。
    if (entry.name === 'node_modules' || entry.name === 'releases') continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) await scanDirectory(child)
    else if (entry.isFile()) await scanFile(child)
  }
}

export async function scanTelemetryArtifacts(directories) {
  const available = []
  for (const directory of directories) {
    try {
      if ((await stat(directory)).isDirectory()) available.push(directory)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  for (const directory of available) await scanDirectory(directory)
  return { scanned: true, directories: available.length, externalTelemetry: false }
}
