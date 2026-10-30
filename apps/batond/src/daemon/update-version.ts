type Version = { numbers: readonly bigint[]; prerelease: readonly string[] }

function parse(value: string): Version {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match) throw new Error('更新版本必须是带 v 前缀的语义版本')
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))
    throw new Error('更新版本必须是带 v 前缀的语义版本')
  return { numbers: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], prerelease }
}

/** A signed manifest may advance or retry the same release, never downgrade it. */
export function compareUpdateVersions(left: string, right: string): number {
  const a = parse(left),
    b = parse(right)
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i]! !== b.numbers[i]!) return a.numbers[i]! > b.numbers[i]! ? 1 : -1
  }
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length)
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i],
      y = b.prerelease[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}
