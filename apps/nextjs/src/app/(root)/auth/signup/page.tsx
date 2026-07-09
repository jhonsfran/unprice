import { redirect } from "next/navigation"

import { getSession } from "@unprice/auth/server-rsc"
import { APP_DOMAIN } from "@unprice/config"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { env } from "~/env"
import { SignInGithub } from "../_components/github-signin"
import { SignInGoogle } from "../_components/google-signin"
import { UpdateMarketingCookie } from "../_components/update-marketing-cookie"
import { SignUpCredentials } from "./credentials-signin"

export default async function AuthenticationPage({
  searchParams: { sessionId, next },
}: {
  searchParams: {
    sessionId?: string
    next?: string
  }
}) {
  const session = await getSession()

  if (session?.user?.id) {
    redirect(APP_DOMAIN)
  }

  return (
    <div className={cn("flex flex-col gap-6")}>
      <UpdateMarketingCookie sessionId={sessionId} />
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Create an account</CardTitle>
          <CardDescription>Sign up with your GitHub or Google account</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-8">
          <div className="flex w-full flex-col items-center justify-between gap-4">
            <SignInGithub redirectTo={next} />
            <SignInGoogle redirectTo={next} />
          </div>
          {env.NODE_ENV === "development" && (
            <>
              <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-border after:border-t">
                <span className="relative z-10 bg-card px-2 text-muted-foreground">
                  Or continue with
                </span>
              </div>
              <SignUpCredentials sessionId={sessionId} />

              <div className="text-center text-sm">
                Already have an account?{" "}
                <a href="/auth/signin" className="underline underline-offset-4">
                  Sign in
                </a>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <div className="text-balance text-center text-muted-foreground text-xs [&_a]:underline [&_a]:underline-offset-4 [&_a]:hover:text-primary ">
        By clicking continue, you agree to our{" "}
        <a href="/terms" className="underline underline-offset-4 hover:text-primary">
          Terms of Service
        </a>{" "}
        and{" "}
        <a href="/privacy" className="underline underline-offset-4 hover:text-primary">
          Privacy Policy
        </a>
        .
      </div>
    </div>
  )
}
