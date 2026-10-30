import { createPublicKey, verify } from 'node:crypto'
import { Schema } from 'effect'

const identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/))
const filename = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/))
const hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const UpdateArtifact = Schema.Struct({
  kind: Schema.Literals(['daemon', 'desktop', 'desktop-feed', 'desktop-manual']),
  platform: Schema.Literals(['darwin', 'linux', 'win32']),
  arch: Schema.Literals(['x64', 'arm64']),
  file: filename,
  size: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2 * 1024 * 1024 * 1024)),
  sha256: hex,
})
export const UpdatePayload = Schema.Struct({
  version: Schema.String.check(
    Schema.isPattern(/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/),
    Schema.isMaxLength(128),
  ),
  commit: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  protocol_version: Schema.Int.check(Schema.isGreaterThan(0)),
  server_image: Schema.String.check(Schema.isPattern(/^ghcr\.io\/hhubb22\/baton@sha256:[a-f0-9]{64}$/)),
  artifacts: Schema.Array(UpdateArtifact).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
})
export const SignedUpdateManifest = Schema.Struct({
  format: Schema.Literal(1),
  key_id: identifier,
  payload: UpdatePayload,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
})
export type SignedUpdateManifest = typeof SignedUpdateManifest.Type
export type UpdatePayload = typeof UpdatePayload.Type

/** Only these fields, in this order, are signed; extra JSON fields have no effect. */
export function updatePayloadBytes(payload: UpdatePayload): Buffer {
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

export function verifyUpdateManifest(
  input: unknown,
  trustedKeys: Readonly<Record<string, string>>,
): SignedUpdateManifest {
  const manifest = Schema.decodeUnknownSync(SignedUpdateManifest)(input)
  const key = Object.hasOwn(trustedKeys, manifest.key_id) ? trustedKeys[manifest.key_id] : undefined
  if (!key || !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(key)) throw new Error('更新签名密钥不受信任')
  const publicKey = createPublicKey(key)
  if (
    publicKey.asymmetricKeyType !== 'ed25519' ||
    !verify(null, updatePayloadBytes(manifest.payload), publicKey, Buffer.from(manifest.signature, 'base64url'))
  )
    throw new Error('更新清单签名无效')
  const targets = new Set(manifest.payload.artifacts.map((entry) => `${entry.kind}:${entry.platform}:${entry.arch}`))
  const files = new Set(manifest.payload.artifacts.map((entry) => entry.file))
  if (targets.size !== manifest.payload.artifacts.length || files.size !== manifest.payload.artifacts.length)
    throw new Error('更新清单包含重复平台或文件')
  if (
    manifest.payload.artifacts.some((entry) =>
      entry.kind === 'daemon'
        ? entry.platform === 'win32'
          ? !entry.file.endsWith('.zip')
          : !entry.file.endsWith('.tar.gz')
        : entry.kind === 'desktop-manual'
          ? entry.platform !== 'darwin' || !entry.file.endsWith('.dmg')
          : entry.kind === 'desktop-feed'
            ? !['darwin', 'win32'].includes(entry.platform) || !entry.file.endsWith('.yml')
            : entry.platform === 'darwin'
              ? !entry.file.endsWith('.zip')
              : entry.platform === 'win32'
                ? !entry.file.endsWith('.exe')
                : true,
    )
  )
    throw new Error('更新包格式与平台不符')
  return manifest
}
