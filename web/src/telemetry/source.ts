import { applicationAssetUrl } from './runtime'

export function sourceLocation(source: string, line: number, column: number, assetUrl = applicationAssetUrl) {
  if (!Number.isSafeInteger(line) || line < 1 || line > 10_000_000) return undefined
  if (!Number.isSafeInteger(column) || column < 1 || column > 10_000_000) return undefined
  try {
    const asset = new URL(assetUrl)
    const reported = new URL(source, asset)
    if (reported.origin !== asset.origin || reported.pathname !== asset.pathname || reported.search || reported.hash)
      return undefined
    const filename = asset.pathname.split('/').at(-1)
    if (!filename || !/^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js$/.test(filename)) return undefined
    return {
      'baton.web.source.asset': filename,
      'code.line.number': line,
      'code.column.number': column,
    }
  } catch {
    return undefined
  }
}
