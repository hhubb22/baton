import type { DownloadItem, DownloadsResponse } from '@baton/protocol/http-api'

// 安装包元数据用于离线展示，不对应真实下载文件。
const items: DownloadItem[] = [
  {
    kind: 'cli',
    platform: 'darwin',
    arch: 'arm64',
    file: 'baton-v0.1.0-darwin-arm64.tar.gz',
    size: 32_000_000,
    sha256: 'a'.repeat(64),
  },
  {
    kind: 'cli',
    platform: 'linux',
    arch: 'x64',
    file: 'baton-v0.1.0-linux-x64.tar.gz',
    size: 31_000_000,
    sha256: 'b'.repeat(64),
  },
  {
    kind: 'cli',
    platform: 'linux',
    arch: 'arm64',
    file: 'baton-v0.1.0-linux-arm64.tar.gz',
    size: 30_000_000,
    sha256: 'c'.repeat(64),
  },
  {
    kind: 'desktop',
    platform: 'darwin',
    arch: 'arm64',
    file: 'baton-desktop-v0.1.0-darwin-arm64.dmg',
    size: 120_000_000,
    sha256: 'd'.repeat(64),
  },
  {
    kind: 'desktop',
    platform: 'win32',
    arch: 'x64',
    file: 'baton-desktop-v0.1.0-win32-x64.exe',
    size: 110_000_000,
    sha256: 'e'.repeat(64),
  },
]

export function mockDownloads(enabled: boolean, origin: string): DownloadsResponse {
  return {
    enabled,
    version: 'v0.1.0',
    connect_url: enabled ? `baton://connect?url=${encodeURIComponent(origin)}` : null,
    ca_sha256: null,
    items: enabled ? items : [],
  }
}
