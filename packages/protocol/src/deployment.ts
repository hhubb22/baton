import { Schema } from 'effect'

// 中心地址：只含 https scheme、host 和可选端口
export const CoordinatorOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value
    } catch {
      return false
    }
  }),
)

// 中心写入 CLI 安装包、桌面客户端从接入链接保存的部署配置，只含公开信息
export const DeploymentConfig = Schema.Struct({
  format: Schema.Literal(1),
  coordinator_url: CoordinatorOrigin,
  ca_pem: Schema.optional(Schema.String),
})
export type DeploymentConfig = typeof DeploymentConfig.Type
