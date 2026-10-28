import type { JWT } from "@auth/core/jwt"

/**
 * Keeps a JWT session only while its user row still exists.
 *
 * Sessions use the JWT strategy, so deleting the user (e.g. after a personal workspace and
 * account deletion) does not revoke cookies that were already issued. Returning `null` from
 * the Auth.js `jwt` callback clears the session cookie, which signs the browser out and lets
 * the middleware send it to the sign-in page instead of onboarding.
 *
 * The lookup is skipped right after sign-in (the user was just loaded or created) and fails
 * open on database errors so a transient outage does not sign everyone out.
 */
export async function keepTokenIfUserExists(opts: {
  token: JWT
  isSignIn: boolean
  userExists: (userId: string) => Promise<boolean>
  onError?: (error: unknown) => void
}): Promise<JWT | null> {
  const { token, isSignIn, userExists, onError } = opts
  const userId = token.sub

  if (!userId || isSignIn) {
    return token
  }

  try {
    return (await userExists(userId)) ? token : null
  } catch (error) {
    onError?.(error)
    return token
  }
}
