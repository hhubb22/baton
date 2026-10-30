import type { SignedUpdateManifest } from '@baton/protocol/update-manifest'
import type { DownloadItem } from '@baton/protocol/http-api'

export function shouldHandoffDesktop(state: { phase: string; target_version?: string } | null): boolean {
  return !!state?.target_version && ['syncing', 'completed'].includes(state.phase)
}

export function desktopArtifact(
  manifest: SignedUpdateManifest,
  targetVersion: string,
  platform: string = process.platform,
  arch: string = process.arch,
): DownloadItem {
  if (manifest.payload.version !== targetVersion) throw new Error('签名清单与设备更新目标不一致')
  const matches = manifest.payload.artifacts.filter(
    (item) => item.kind === 'desktop' && item.platform === platform && item.arch === arch,
  )
  if (matches.length !== 1) throw new Error('签名清单没有适用于此设备的桌面安装包')
  const item = matches[0]!
  const suffix =
    platform === 'darwin' && arch === 'arm64'
      ? 'darwin-arm64.zip'
      : platform === 'win32' && arch === 'x64'
        ? 'win32-x64.exe'
        : ''
  if (!suffix || item.file !== `baton-desktop-${targetVersion}-${suffix}`)
    throw new Error('签名清单中的桌面安装包名称或平台无效')
  const feeds = manifest.payload.artifacts.filter(
    (entry) => entry.kind === 'desktop-feed' && entry.platform === platform && entry.arch === arch,
  )
  if (feeds.length !== 1 || feeds[0]?.file !== (platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'))
    throw new Error('签名清单没有适用于此设备的更新元数据')
  return { ...item, kind: 'desktop' }
}
