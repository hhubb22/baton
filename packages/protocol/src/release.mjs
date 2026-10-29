export const PROTOCOL_VERSION = 1
export const SCHEMA_VERSION = '0016_project_trace.sql'
export const LEDGER_VERSIONS = Object.freeze({ node: 1, project: 1, thread: 1 })

// 构建时注入同一份身份；源码运行和未指定身份的构建明确标为开发版本。
export const BUNDLED = typeof __BATON_BUILD__ !== 'undefined'
export const BUILD = !BUNDLED
  ? Object.freeze({ version: 'development', commit: 'development' })
  : Object.freeze(__BATON_BUILD__)

export function releaseMetadata(build = BUILD, platform = process.platform, arch = process.arch) {
  return {
    ...build,
    platform,
    arch,
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION,
    ledger_versions: LEDGER_VERSIONS,
    supported_daemon_versions: [build.version],
  }
}
