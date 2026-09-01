import { redirect } from "next/navigation"
import { Suspense } from "react"

import { getSession } from "@unprice/auth/server-rsc"
import { APP_DOMAIN, AUTH_ROUTES } from "@unprice/config"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { env } from "~/env"
import {
  PRIVACY_URL,
  TERMS_URL,
  buildAuthHref,
  getSafeNextPath,
  getSignupIntent,
  getSingleSearchParam,
} from "~/lib/signup-funnel"
import { FunnelPageEvent } from "../_components/funnel-page-event"
import { SignInGithub } from "../_components/github-signin"
import { SignInGoogle } from "../_components/google-signin"
import { UpdateMarketingCookie } from "../_components/update-marketing-cookie"
import { SignUpCredentials } from "./credentials-signin"

// This page reads the request's session and query string to select the authentication flow.
export const dynamic = "force-dynamic"

export default async function AuthenticationPage(props: {
  searchParams: Promise<{
    sessionId?: string | string[]
    intent?: string | string[]
    next?: string | string[]
  }>
}) {
  const { sessionId, intent, next } = await props.searchParams
  const singleSessionId = getSingleSearchParam(sessionId)
  const signupIntent = getSignupIntent(intent)
  const safeNext = getSafeNextPath(getSingleSearchParam(next))
  const session = await getSession()

  if (session?.user?.id) {
    redirect(safeNext ?? APP_DOMAIN)
  }

  return (
    <div className={cn("flex flex-col gap-6")}>
      <UpdateMarketingCookie sessionId={singleSessionId} />
      <Suspense fallback={null}>
        <FunnelPageEvent next={safeNext} />
      </Suspense>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            {signupIntent === "paid-action" ? "Start with one agent action" : "Create an account"}
          </CardTitle>
          <CardDescription>
            {signupIntent === "paid-action"
              ? "Create a Sandbox money path — no card required."
              : "Sign up with your GitHub or Google account"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-8">
          <div className="flex w-full flex-col items-center justify-between gap-4">
            <SignInGithub redirectTo={safeNext ?? undefined} />
            <SignInGoogle redirectTo={safeNext ?? undefined} />
          </div>
          {env.NODE_ENV === "development" && (
            <>
              <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-border after:border-t">
                <span className="relative z-10 bg-card px-2 text-muted-foreground">
                  Or continue with
                </span>
              </div>
              <SignUpCredentials
                intent={signupIntent}
                next={safeNext ?? undefined}
                sessionId={singleSessionId}
              />

              <div className="text-center text-sm">
                Already have an account?{" "}
                <a
                  href={buildAuthHref(AUTH_ROUTES.SIGNIN, {
                    sessionId: singleSessionId,
                    intent: signupIntent,
                    next: safeNext,
                  })}
                  className="underline underline-offset-4"
                >
                  Sign in
                </a>
              </div>
            </>
          )}
          {signupIntent === "paid-action" && (
            <p className="text-center text-muted-foreground text-xs">
              One agent action · Sandbox · no card
            </p>
          )}
        </CardContent>
      </Card>
      <div className="text-balance text-center text-muted-foreground text-xs [&_a]:underline [&_a]:underline-offset-4 [&_a]:hover:text-primary ">
        By clicking continue, you agree to our{" "}
        <a href={TERMS_URL} className="underline underline-offset-4 hover:text-primary">
          Terms of Service
        </a>{" "}
        and{" "}
        <a href={PRIVACY_URL} className="underline underline-offset-4 hover:text-primary">
          Privacy Policy
        </a>
        .
      </div>
    </div>
  )
}
