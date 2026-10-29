export interface BuildInfo {
  readonly version: string
  readonly commit: string
}
export const PROTOCOL_VERSION: 1
export const SCHEMA_VERSION: '0015_project_read.sql'
export const LEDGER_VERSIONS: Readonly<{ node: 1; project: 1; thread: 1 }>
export const BUNDLED: boolean
export const BUILD: BuildInfo
export interface ReleaseMetadata extends BuildInfo {
  readonly platform: string
  readonly arch: string
  readonly protocol_version: number
  readonly schema_version: string
  readonly ledger_versions: Readonly<{ node: number; project: number; thread: number }>
  readonly supported_daemon_versions: readonly string[]
}
export function releaseMetadata(build?: BuildInfo, platform?: string, arch?: string): ReleaseMetadata
