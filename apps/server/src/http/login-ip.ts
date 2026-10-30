import { isIP } from 'node:net'

type Address = { readonly family: 4 | 6; readonly value: bigint }
type Network = Address & { readonly prefix: number }

/** Addresses are parsed before matching, so IPv4-mapped IPv6 shares the IPv4 identity. */
function address(input: string): Address | undefined {
  const family = isIP(input)
  if (family === 4) {
    const value = input.split('.').reduce((result, part) => (result << 8n) | BigInt(part), 0n)
    return { family: 4, value }
  }
  if (family !== 6 || input.includes('%')) return undefined
  // URL's IPv6 parser canonicalizes compressed and embedded IPv4 forms.
  const host = new URL(`http://[${input}]/`).hostname.slice(1, -1)
  const [left, right] = host.split('::')
  const head = left ? left.split(':') : []
  const tail = right ? right.split(':') : []
  const zeros = 8 - head.length - tail.length
  const groups = host.includes('::') ? [...head, ...Array<string>(zeros).fill('0'), ...tail] : head
  const value = groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n)
  if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn }
  return { family: 6, value }
}

/** Parse an explicit comma-separated CIDR allowlist; malformed configuration is rejected. */
export function parseTrustedProxies(value: string): readonly Network[] {
  if (!value.trim()) return []
  return value.split(',').map((entry) => {
    const parts = entry.trim().split('/')
    const ip = address(parts[0] ?? '')
    if (parts.length !== 2 || !ip || !/^(0|[1-9]\d*)$/.test(parts[1] ?? ''))
      throw new Error('Invalid trusted proxy CIDR')
    let prefix = Number(parts[1])
    // Mapped CIDRs name IPv4 networks using the enclosing 96 IPv6 bits.
    if (isIP(parts[0]!) === 6 && ip.family === 4) {
      if (prefix < 96 || prefix > 128) throw new Error('Invalid trusted proxy CIDR')
      prefix -= 96
    }
    if (!Number.isSafeInteger(prefix) || prefix > (ip.family === 4 ? 32 : 128))
      throw new Error('Invalid trusted proxy CIDR')
    return { ...ip, prefix }
  })
}

function trusted(address: Address, networks: readonly Network[]): boolean {
  return networks.some((network) => {
    if (network.family !== address.family) return false
    const shift = BigInt((address.family === 4 ? 32 : 128) - network.prefix)
    return address.value >> shift === network.value >> shift
  })
}

function key(ip: Address): string {
  if (ip.family === 4) return [24n, 16n, 8n, 0n].map((shift) => Number((ip.value >> shift) & 255n)).join('.')
  const prefix = ip.value >> 64n
  return `${[48n, 32n, 16n, 0n].map((shift) => ((prefix >> shift) & 0xffffn).toString(16)).join(':')}::/64`
}

/** Select the first untrusted hop from the right; never trust XFF from an untrusted peer. */
export function loginClientIp(
  peer: string | undefined,
  forwardedFor: string | undefined,
  networks: readonly Network[],
): string | undefined {
  // A socket address can include an IPv6 zone identifier; it is not part of the IP identity.
  const direct = peer ? address(peer.split('%')[0]!) : undefined
  if (!direct) return undefined
  if (!forwardedFor || !trusted(direct, networks) || forwardedFor.length > 8192) return key(direct)
  const hops = forwardedFor.split(',')
  if (hops.length > 64) return key(direct)
  let current = direct
  for (let index = hops.length - 1; index >= 0 && trusted(current, networks); index--) {
    const hop = address(hops[index]!.trim())
    if (!hop) return key(direct)
    current = hop
  }
  return key(current)
}
