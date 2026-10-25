import type { OrchestrationV2ProviderFailure } from '@t3tools/contracts'

/** Only explicit authentication failures receive sign-in guidance. */
export const kiroTurnFailure = (failure: OrchestrationV2ProviderFailure): string => {
  const authenticationFailure =
    /^(?:AuthenticationError|AuthenticationRequired|Unauthenticated|Unauthorized)$/iu.test(failure.code ?? '') ||
    /\b(?:authentication (?:required|failed)|not authenticated|unauthenticated|not logged in|not signed in|credentials? (?:expired|invalid)|(?:expired|invalid) credentials?)\b/iu.test(
      failure.message,
    )
  return authenticationFailure
    ? 'Kiro CLI 认证失败，请在设备上登录 Kiro CLI 后重试'
    : 'Kiro 执行失败，请检查设备上的 Kiro CLI 状态后重试'
}
