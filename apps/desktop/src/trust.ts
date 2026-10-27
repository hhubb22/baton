import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import type { DeploymentConfig } from '@baton/protocol/deployment'

// Electron Certificate 的最小结构；Node 测试无需加载 Electron。
export interface CertificateChain {
  data: string
  issuerCert?: CertificateChain
}

const MAX_CHAIN_LENGTH = 16

function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function validAt(certificate: X509Certificate, now: number): boolean {
  return now >= Date.parse(certificate.validFrom) && now <= Date.parse(certificate.validTo)
}

function issuedBy(certificate: X509Certificate, issuer: X509Certificate): boolean {
  return issuer.ca && certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey)
}

function element(der: Buffer, offset: number) {
  const tag = der[offset++]!
  let length = der[offset++]!
  if (length & 0x80) {
    const bytes = length & 0x7f
    if (bytes < 1 || bytes > 4) throw new Error('DER 长度无效')
    length = 0
    for (let i = 0; i < bytes; i++) length = length * 256 + der[offset++]!
  }
  const end = offset + length
  if (!Number.isSafeInteger(end) || end > der.length) throw new Error('DER 内容不完整')
  return { tag, start: offset, end }
}

// X509Certificate 不执行名称、策略或未知 critical 扩展约束；遇到这些约束时拒绝覆盖系统校验。
function constraints(certificate: X509Certificate): number | undefined {
  const der = certificate.raw
  const outer = element(der, 0)
  const tbs = element(der, outer.start)
  let pathLength: number | undefined
  for (let position = tbs.start; position < tbs.end;) {
    const field = element(der, position)
    position = field.end
    if (field.tag !== 0xa3) continue
    const extensions = element(der, field.start)
    for (let cursor = extensions.start; cursor < extensions.end;) {
      const extension = element(der, cursor)
      cursor = extension.end
      const oid = element(der, extension.start)
      const name = der.subarray(oid.start, oid.end).toString('hex')
      let value = element(der, oid.end)
      const critical = value.tag === 1 && der[value.start] !== 0
      if (value.tag === 1) value = element(der, value.end)
      if (['551d1e', '551d24', '551d36'].includes(name)) throw new Error('证书链包含未支持的名称或策略约束')
      if (critical && !['551d0e', '551d0f', '551d11', '551d13', '551d23', '551d25'].includes(name))
        throw new Error('证书包含未支持的 critical 扩展')
      if (name === '551d13') {
        const basic = element(der, value.start)
        if (basic.start === basic.end) continue
        let entry = element(der, basic.start)
        if (entry.tag === 1 && entry.end < basic.end) entry = element(der, entry.end)
        if (entry.tag === 2) {
          pathLength = 0
          for (const byte of der.subarray(entry.start, entry.end)) pathLength = pathLength * 256 + byte
          if (!Number.isSafeInteger(pathLength) || der[entry.start]! >= 0x80) throw new Error('CA 路径长度无效')
        }
      }
    }
  }
  return pathLength
}

function serverUsage(certificate: X509Certificate) {
  return (
    !certificate.keyUsage || certificate.keyUsage.some((oid) => oid === '1.3.6.1.5.5.7.3.1' || oid === '2.5.29.37.0')
  )
}

/** now 使用 Unix 毫秒；返回 Electron certificate verify proc 的结果码。 */
export function verifyCertificate(
  hostname: string,
  certificate: CertificateChain,
  deployment: DeploymentConfig | undefined,
  now: number = Date.now(),
): number {
  if (deployment?.ca_pem === undefined) return -3
  try {
    const host = unbracket(hostname).toLowerCase()
    const coordinatorHost = unbracket(new URL(deployment.coordinator_url).hostname).toLowerCase()
    if (host !== coordinatorHost) return -3

    const anchor = new X509Certificate(deployment.ca_pem)
    if (!anchor.ca || !validAt(anchor, now) || !serverUsage(anchor)) return -2
    const anchorLimit = constraints(anchor)

    let chain = certificate
    let current = new X509Certificate(chain.data)
    if (current.ca || !validAt(current, now) || !serverUsage(current)) return -2
    constraints(current)
    const matchesHost = isIP(host) ? current.checkIP(host) : current.checkHost(host, { partialWildcards: false })
    if (!matchesHost) return -2
    const seen = new Set<string>()
    for (let depth = 0; depth < MAX_CHAIN_LENGTH; depth++) {
      if (seen.has(current.fingerprint256)) return -2
      seen.add(current.fingerprint256)
      if (current.raw.equals(anchor.raw) || issuedBy(current, anchor))
        return anchorLimit === undefined || depth <= anchorLimit ? 0 : -2
      if (!chain.issuerCert) return -2
      chain = chain.issuerCert
      const issuer = new X509Certificate(chain.data)
      if (!validAt(issuer, now) || !issuedBy(current, issuer) || !serverUsage(issuer)) return -2
      const limit = constraints(issuer)
      if (limit !== undefined && depth > limit) return -2
      current = issuer
    }
  } catch {
    return -2
  }
  return -2
}
