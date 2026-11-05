import { createPublicKey, verify } from 'node:crypto'
import { Schema } from 'effect'

const identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/))
const filename = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/))
const hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const ReleaseArtifact = Schema.Struct({
  kind: Schema.Literals(['daemon', 'desktop', 'desktop-manual']),
  platform: Schema.Literals(['darwin', 'linux', 'win32']),
  arch: Schema.Literals(['x64', 'arm64']),
  file: filename,
  size: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2 * 1024 * 1024 * 1024)),
  sha256: hex,
})
export const ReleasePayload = Schema.Struct({
  version: Schema.String.check(
    Schema.isPattern(/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/),
    Schema.isMaxLength(128),
  ),
  commit: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  protocol_version: Schema.Int.check(Schema.isGreaterThan(0)),
  server_image: Schema.String.check(Schema.isPattern(/^ghcr\.io\/hhubb22\/baton@sha256:[a-f0-9]{64}$/)),
  artifacts: Schema.Array(ReleaseArtifact).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
})
export const SignedReleaseManifest = Schema.Struct({
  format: Schema.Literal(1),
  key_id: identifier,
  payload: ReleasePayload,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
})
export type SignedReleaseManifest = typeof SignedReleaseManifest.Type
export type ReleasePayload = typeof ReleasePayload.Type

/** Only these fields, in this order, are signed; extra JSON fields have no effect. */
export function releasePayloadBytes(payload: ReleasePayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: payload.version,
      commit: payload.commit,
      protocol_version: payload.protocol_version,
      server_image: payload.server_image,
      artifacts: payload.artifacts.map(({ kind, platform, arch, file, size, sha256 }) => ({
        kind,
        platform,
        arch,
        file,
        size,
        sha256,
      })),
    }),
  )
}

export function verifyReleaseManifest(
  input: unknown,
  trustedKeys: Readonly<Record<string, string>>,
): SignedReleaseManifest {
  const manifest = Schema.decodeUnknownSync(SignedReleaseManifest)(input)
  const key = Object.hasOwn(trustedKeys, manifest.key_id) ? trustedKeys[manifest.key_id] : undefined
  if (!key || !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(key)) throw new Error('发布签名密钥不受信任')
  const publicKey = createPublicKey(key)
  if (
    publicKey.asymmetricKeyType !== 'ed25519' ||
    !verify(null, releasePayloadBytes(manifest.payload), publicKey, Buffer.from(manifest.signature, 'base64url'))
  )
    throw new Error('发布清单签名无效')
  const targets = new Set(manifest.payload.artifacts.map((entry) => `${entry.kind}:${entry.platform}:${entry.arch}`))
  const files = new Set(manifest.payload.artifacts.map((entry) => entry.file))
  if (targets.size !== manifest.payload.artifacts.length || files.size !== manifest.payload.artifacts.length)
    throw new Error('发布清单包含重复平台或文件')
  if (
    manifest.payload.artifacts.some((entry) =>
      entry.kind === 'daemon'
        ? entry.platform === 'win32'
          ? !entry.file.endsWith('.zip')
          : !entry.file.endsWith('.tar.gz')
        : entry.kind === 'desktop-manual'
          ? entry.platform !== 'darwin' || !entry.file.endsWith('.dmg')
          : entry.platform === 'darwin'
            ? !entry.file.endsWith('.zip')
            : entry.platform === 'win32'
              ? !entry.file.endsWith('.exe')
              : true,
    )
  )
    throw new Error('发布文件格式与平台不符')
  return manifest
}
