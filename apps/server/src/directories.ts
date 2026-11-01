import path from 'node:path'
import type { RuntimeReport } from '@baton/protocol'

export function absoluteDirectory(system: string, directory: string) {
  return (system === 'windows' ? path.win32 : path.posix).isAbsolute(directory)
}

export function directoryAllowed(system: string, directory: string, roots: RuntimeReport['roots']) {
  const windows = system === 'windows'
  const parser = windows ? path.win32 : path.posix
  if (!absoluteDirectory(system, directory)) return false
  const normalize = (value: string) => (windows ? parser.resolve(value).toLowerCase() : parser.resolve(value))
  const target = normalize(directory)
  return (
    roots?.some((root) => {
      const relative = parser.relative(normalize(root.path), target)
      return (
        relative === '' ||
        (!relative.startsWith('..' + parser.sep) && relative !== '..' && !parser.isAbsolute(relative))
      )
    }) ?? false
  )
}
