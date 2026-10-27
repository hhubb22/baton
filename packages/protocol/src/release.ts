import { Schema } from 'effect'

export { BUILD, BUNDLED, PROTOCOL_VERSION, SCHEMA_VERSION, LEDGER_VERSIONS, releaseMetadata } from './release.mjs'

export const ReleaseMetadata = Schema.Struct({
  version: Schema.String,
  commit: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  protocol_version: Schema.Int,
  schema_version: Schema.String,
  ledger_versions: Schema.Struct({ node: Schema.Int, project: Schema.Int, thread: Schema.Int }),
  supported_daemon_versions: Schema.Array(Schema.String),
})
export type ReleaseMetadata = typeof ReleaseMetadata.Type
