"use server"

import { signOut } from "@unprice/auth/server"
import { getSession } from "@unprice/auth/server-rsc"

/**
 * Clears the Auth.js session cookie after the signed-in account was deleted. The JWT still
 * points at the removed user, so the session has to go before the next sign-in can start a
 * fresh signup and onboarding. The client navigates to the sign-in page afterwards.
 */
export async function signOutAfterAccountDeletion() {
  const session = await getSession()

  // nothing to clear for anonymous callers
  if (!session?.user?.id) {
    return
  }

  await signOut({ redirect: false })
}
