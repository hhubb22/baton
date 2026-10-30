import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { caFingerprint, loadDeployment, parseConnectLink, saveDeployment, type DeploymentConfig } from './deployment.ts'

const ca = readFileSync(new URL('./testing/data/ca.crt', import.meta.url), 'utf8')
const otherCA = readFileSync(new URL('./testing/data/other-ca.crt', import.meta.url), 'utf8')
const leaf = readFileSync(new URL('./testing/data/leaf.crt', import.meta.url), 'utf8')
const encodedCA = new X509Certificate(ca).raw.toString('base64url')
const origin = 'https://coordinator.test:8443'
const link = `baton://connect?url=${encodeURIComponent(origin)}`
const systemTrust: DeploymentConfig = { format: 1, coordinator_url: origin }
const customTrust: DeploymentConfig = { ...systemTrust, ca_pem: ca }

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'baton-desktop-deployment-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('parseConnectLink', () => {
  it('解析公共信任与 DER base64url CA，保留端口', () => {
    expect(parseConnectLink(link)).toEqual(systemTrust)
    expect(parseConnectLink(`${link}&ca=${encodedCA}`)).toEqual(customTrust)
    expect(parseConnectLink(`baton://connect?ca=${encodedCA}&url=${encodeURIComponent(origin)}`)).toEqual(customTrust)
  })

  it.each(['https://127.0.0.1:8443', 'https://[::1]:8443', 'https://coordinator.test'])('允许 HTTPS 源 %s', (url) => {
    expect(parseConnectLink(`baton://connect?url=${encodeURIComponent(url)}`).coordinator_url).toBe(url)
  })

  // Windows 的 ShellExecute 把 baton://connect?… 改写成 baton://connect/?…，两种形式都必须能接入。
  it('接受 Windows ShellExecute 补斜杠后的路由', () => {
    expect(parseConnectLink(`baton://connect/?url=${encodeURIComponent(origin)}`)).toEqual(systemTrust)
    expect(parseConnectLink(`baton://connect/?url=${encodeURIComponent(origin)}&ca=${encodedCA}`)).toEqual(customTrust)
  })

  it.each([
    'http://coordinator.test',
    'file:///tmp/example',
    'https://coordinator.test/',
    'https://coordinator.test/path',
    'https://user:password@coordinator.test',
    'https://coordinator.test?query=1',
    'https://coordinator.test#fragment',
    'https://coordinator.test:443',
    'https://coordinator.test/../',
    'not a URL',
  ])('按共享 Schema 拒绝非 HTTPS 源 %s', (url) => {
    expect(() => parseConnectLink(`baton://connect?url=${encodeURIComponent(url)}`)).toThrow()
  })

  it.each([
    'https://connect?url=https://coordinator.test',
    'baton://other?url=https://coordinator.test',
    'baton://CONNECT?url=https://coordinator.test',
    'BATON://connect?url=https://coordinator.test',
    'baton://connect/path?url=https://coordinator.test',
    'baton://connect:123?url=https://coordinator.test',
    'baton://user@connect?url=https://coordinator.test',
    'baton://connect',
    'baton://connect?',
    'baton://connect?ca=abc',
    `${link}#fragment`,
    `${link}#`,
    `${link}\n`,
    ` ${link}`,
    `${link}&url=https://other.test`,
    `${link}&%75rl=https://other.test`,
    `${link}&ca=${encodedCA}&ca=${encodedCA}`,
    `${link}&unknown=value`,
    `${link}&ca=`,
    `${link}&ca`,
    `${link}&`,
    'baton://connect?url=',
    'baton://connect?url=%',
    'baton://connect?url=%GG',
    'baton://connect?url=%FF',
    `${link}&ca=%FF`,
  ])('拒绝错误路由和参数 %s', (raw) => {
    expect(() => parseConnectLink(raw)).toThrow()
  })

  it('以 UTF-8 字节计算 8KB 上限', () => {
    const prefix = 'baton://connect?url=https://'
    const atLimit = prefix + 'a'.repeat(8192 - prefix.length)
    expect(() => parseConnectLink(atLimit)).not.toThrow()
    expect(() => parseConnectLink(`${atLimit}a`)).toThrow('8KB')
    expect(() => parseConnectLink(prefix + '中'.repeat(3000))).toThrow('8KB')
  })

  it.each([
    'not-a-certificate',
    `${encodedCA}=`,
    `${encodedCA}+`,
    `${encodedCA}/`,
    'A',
    'AB',
    Buffer.from('-----BEGIN CERTIFICATE-----').toString('base64url'),
    new X509Certificate(leaf).raw.toString('base64url'),
    Buffer.concat([new X509Certificate(ca).raw, Buffer.from([0])]).toString('base64url'),
  ])('拒绝无效 CA 或非规范编码 %s', (encoded) => {
    expect(() => parseConnectLink(`${link}&ca=${encoded}`)).toThrow()
  })

  it('显示 SHA-256 CA 指纹或系统信任标签', () => {
    expect(caFingerprint(customTrust)).toBe(new X509Certificate(ca).fingerprint256)
    expect(caFingerprint(systemTrust)).toBe('系统信任')
  })
})

describe('deployment storage', () => {
  it('文件缺失时返回 undefined，忽略单独残留的 ca.pem', async () => {
    const directory = await temporaryDirectory()
    expect(await loadDeployment(join(directory, 'missing'))).toBeUndefined()
    await writeFile(join(directory, 'ca.pem'), ca)
    expect(await loadDeployment(directory)).toBeUndefined()
  })

  it('创建目录，保存并读取配置，同时替换 CA 和私有文件权限', async () => {
    const directory = join(await temporaryDirectory(), 'userData')
    await saveDeployment(directory, customTrust)
    expect(await loadDeployment(directory)).toEqual(customTrust)
    expect(await readFile(join(directory, 'ca.pem'), 'utf8')).toBe(ca)
    await writeFile(join(directory, 'deployment.json'), '{}', { mode: 0o644 })
    await saveDeployment(directory, { ...systemTrust, ca_pem: otherCA })
    expect(await loadDeployment(directory)).toEqual({ ...systemTrust, ca_pem: otherCA })
    expect(await readFile(join(directory, 'ca.pem'), 'utf8')).toBe(otherCA)
    expect((await readdir(directory)).sort()).toEqual(['ca.pem', 'deployment.json'])
    if (process.platform !== 'win32') {
      for (const file of ['deployment.json', 'ca.pem']) {
        expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600)
      }
    }
  })

  it('切回系统信任时删除 ca.pem，并可重复保存', async () => {
    const directory = await temporaryDirectory()
    await saveDeployment(directory, customTrust)
    await saveDeployment(directory, systemTrust)
    await saveDeployment(directory, systemTrust)
    expect(await loadDeployment(directory)).toEqual(systemTrust)
    expect(await readdir(directory)).toEqual(['deployment.json'])
  })

  it.each([
    '{broken',
    'null',
    JSON.stringify({ ...systemTrust, format: 2 }),
    JSON.stringify({ ...systemTrust, coordinator_url: 'http://coordinator.test' }),
    JSON.stringify({ ...systemTrust, ca_pem: '' }),
    JSON.stringify({ ...systemTrust, ca_pem: 'invalid PEM' }),
    JSON.stringify({ ...systemTrust, ca_pem: leaf }),
    JSON.stringify({ ...systemTrust, ca_pem: ca + otherCA }),
  ])('拒绝损坏的已存配置 %s', async (json) => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'deployment.json'), json)
    await expect(loadDeployment(directory)).rejects.toThrow()
  })

  it('不吞掉读取错误', async () => {
    const directory = await temporaryDirectory()
    await mkdir(join(directory, 'deployment.json'))
    await expect(loadDeployment(directory)).rejects.toThrow()
  })

  it('无效配置不修改已存文件', async () => {
    const directory = await temporaryDirectory()
    await saveDeployment(directory, customTrust)
    await expect(saveDeployment(directory, { ...systemTrust, ca_pem: leaf })).rejects.toThrow()
    expect(await loadDeployment(directory)).toEqual(customTrust)
    expect(await readFile(join(directory, 'ca.pem'), 'utf8')).toBe(ca)
  })

  it('原子替换失败时清理临时文件并报告错误', async () => {
    const directory = await temporaryDirectory()
    await mkdir(join(directory, 'deployment.json'))
    await expect(saveDeployment(directory, systemTrust)).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['deployment.json'])
  })
})
