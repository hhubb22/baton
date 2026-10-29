import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export function telemetryMarkers(env) {
  const result = []
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/^OTEL_EXPORTER_OTLP_(?:(?:TRACES|LOGS|METRICS)_)?(?:ENDPOINT|HEADERS)$/.test(name)) continue
    const values = name.endsWith('_HEADERS')
      ? value.split(',').flatMap((entry) => {
          const index = entry.indexOf('=')
          if (index < 0) return []
          const raw = entry.slice(index + 1).trim()
          try {
            return [raw, decodeURIComponent(raw)]
          } catch {
            return [raw]
          }
        })
      : [value]
    for (const marker of values) if (marker) result.push({ name, bytes: Buffer.from(marker) })
  }
  return result
}

async function scanFile(path, markers) {
  const longest = Math.max(...markers.map((marker) => marker.bytes.length))
  let tail = Buffer.alloc(0)
  for await (const chunk of createReadStream(path)) {
    const data = Buffer.concat([tail, chunk])
    for (const marker of markers)
      if (data.includes(marker.bytes)) throw new Error(`遥测配置出现在构建产物中：${marker.name}`)
    tail = data.subarray(Math.max(0, data.length - longest + 1))
  }
}

async function scanDirectory(path, markers) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await scanDirectory(child, markers)
    else if (entry.isFile()) await scanFile(child, markers)
  }
}

export async function scanTelemetryArtifacts(directories, env = process.env) {
  const markers = telemetryMarkers(env)
  const available = []
  for (const directory of directories) {
    try {
      if ((await stat(directory)).isDirectory()) available.push(directory)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (markers.length) for (const directory of available) await scanDirectory(directory, markers)
  return {
    provided: [...new Set(markers.map((marker) => marker.name))],
    scanned: markers.length > 0,
    directories: available.length,
  }
}
