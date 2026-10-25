// 仅 Windows 绝对路径使用反斜杠分隔符，POSIX 文件名中的反斜杠按字面保留。
export function windowsFilePath(path: string) {
  return /^[a-z]:[\\/]/i.test(path) || /^(?:\\\\[^\\]+\\[^\\]+|\/\/[^/]+\/[^/]+)/.test(path)
}

export function normalizeFilePath(path: string, root = path) {
  return windowsFilePath(root) ? path.replaceAll('\\', '/') : path
}

export function insideFileFolder(path: string, root: string) {
  const normalized = normalizeFilePath(path, root)
  const base = normalizeFilePath(root).replace(/\/$/, '')
  return normalized === base || normalized.startsWith(`${base}/`)
}

export function joinFilePath(parent: string, name: string) {
  const separator = windowsFilePath(parent) && parent.includes('\\') ? '\\' : '/'
  return `${parent.endsWith(separator) ? parent : parent + separator}${name}`
}

export function fileName(path: string) {
  return normalizeFilePath(path).split('/').filter(Boolean).pop() ?? path
}

export function fileParent(path: string) {
  const normalized = normalizeFilePath(path).replace(/\/$/, '')
  if (/^[a-z]:$/i.test(normalized) || /^\/\/[^/]+\/[^/]+$/.test(normalized)) return null
  const index = normalized.lastIndexOf('/')
  if (index < 0) return null
  if (index === 0) return normalized ? '/' : null
  if (/^[a-z]:$/i.test(normalized.slice(0, index))) return path.slice(0, index + 1)
  return path.slice(0, index)
}
