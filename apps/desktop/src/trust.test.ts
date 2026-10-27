import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'
import { verifyCertificate, type CertificateChain } from './trust.ts'

const cert = (name: string) => readFileSync(new URL(`./testing/data/${name}.crt`, import.meta.url), 'utf8')
const ca = cert('ca'),
  leaf = cert('leaf'),
  intermediate = cert('intermediate')
const deployment = { format: 1 as const, coordinator_url: 'https://coordinator.test:8443', ca_pem: ca }
const validTime = Date.parse(new X509Certificate(leaf).validFrom) + 60_000
const chain: CertificateChain = { data: leaf, issuerCert: { data: intermediate, issuerCert: { data: ca } } }

describe('中心私有 CA 校验', () => {
  it('验证中间证书链、直接签发、DNS 和 IP 主机名', () => {
    expect(verifyCertificate('coordinator.test', chain, deployment, validTime)).toBe(0)
    expect(verifyCertificate('coordinator.test', { data: cert('direct-leaf') }, deployment, validTime)).toBe(0)
    for (const hostname of ['127.0.0.1', '[::1]'])
      expect(
        verifyCertificate(
          hostname,
          chain,
          {
            ...deployment,
            coordinator_url: `https://${hostname}:8443`,
          },
          validTime,
        ),
      ).toBe(0)
  })
  it('其他 host 和系统信任配置交给 Chromium，中心自定义 CA 失败时拒绝', () => {
    expect(verifyCertificate('other.test', chain, deployment, validTime)).toBe(-3)
    expect(verifyCertificate('coordinator.test', chain, undefined, validTime)).toBe(-3)
    expect(
      verifyCertificate(
        'coordinator.test',
        chain,
        { format: 1, coordinator_url: deployment.coordinator_url },
        validTime,
      ),
    ).toBe(-3)
    expect(
      verifyCertificate('wrong.test', chain, { ...deployment, coordinator_url: 'https://wrong.test' }, validTime),
    ).toBe(-2)
  })
  it('拒绝相同 subject 的其他 CA、非 CA 签发者和缺少中间证书的链', () => {
    expect(
      verifyCertificate(
        'coordinator.test',
        { data: cert('other-leaf'), issuerCert: { data: cert('other-ca') } },
        deployment,
        validTime,
      ),
    ).toBe(-2)
    expect(
      verifyCertificate('coordinator.test', { data: cert('non-ca-child'), issuerCert: chain }, deployment, validTime),
    ).toBe(-2)
    expect(verifyCertificate('coordinator.test', { data: leaf }, deployment, validTime)).toBe(-2)
    expect(verifyCertificate('coordinator.test', chain, { ...deployment, ca_pem: leaf }, validTime)).toBe(-2)
  })
  it('拒绝未支持的名称约束和违反 pathlen 的中间 CA 链', () => {
    expect(
      verifyCertificate(
        'coordinator.test',
        {
          data: cert('constrained-leaf'),
          issuerCert: { data: cert('constrained') },
        },
        deployment,
        validTime,
      ),
    ).toBe(-2)
    expect(
      verifyCertificate(
        'coordinator.test',
        {
          data: cert('sub-leaf'),
          issuerCert: { data: cert('sub-ca'), issuerCert: { data: intermediate } },
        },
        deployment,
        validTime,
      ),
    ).toBe(-2)
  })
  it('拒绝过期或尚未生效的证书、客户端证书和损坏的证书', () => {
    for (const now of [validTime - 24 * 3600_000, validTime + 31 * 24 * 3600_000])
      expect(verifyCertificate('coordinator.test', chain, deployment, now)).toBe(-2)
    expect(verifyCertificate('coordinator.test', chain, deployment, validTime + 6 * 24 * 3600_000)).toBe(-2)
    expect(
      verifyCertificate(
        'coordinator.test',
        { data: cert('direct-leaf') },
        deployment,
        Date.parse(new X509Certificate(ca).validTo) + 1000,
      ),
    ).toBe(-2)
    expect(verifyCertificate('coordinator.test', { data: cert('client-leaf') }, deployment, validTime)).toBe(-2)
    expect(verifyCertificate('coordinator.test', { data: 'broken' }, deployment, validTime)).toBe(-2)
  })
})
