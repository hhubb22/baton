import type { OrchestrationV2ProviderFailure } from '@t3tools/contracts'

/** Only explicit authentication failures receive sign-in guidance. */
export const kiroTurnFailure = (failure: OrchestrationV2ProviderFailure): string => {
  const authenticationFailure =
    /^(?:AuthenticationError|AuthenticationRequired|Unauthenticated|Unauthorized)$/iu.test(failure.code ?? '') ||
    /\b(?:authentication (?:required|failed)|not authenticated|unauthenticated|not logged in|not signed in|credentials? (?:expired|invalid)|(?:expired|invalid) credentials?)\b/iu.test(
      failure.message,
    )
  return authenticationFailure ? 'Sign in to Kiro CLI and try again.' : 'Check Kiro CLI on this device and try again.'
}
