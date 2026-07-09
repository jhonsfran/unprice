import { signIn } from "@unprice/auth/server"
import { APP_DOMAIN } from "@unprice/config"
import { Badge } from "@unprice/ui/badge"
import { cn } from "@unprice/ui/utils"
import { AuthButton } from "./auth-button"

export function SignInGoogle({
  className,
  redirectTo,
  isLastUsed,
}: { className?: string; redirectTo?: string; isLastUsed?: boolean }) {
  return (
    <div className={cn("relative w-full", className)}>
      {isLastUsed && (
        <Badge
          variant="secondary"
          className="-translate-y-1/2 absolute top-1/2 right-3 z-10 h-5 whitespace-nowrap px-2 text-[10px]"
        >
          Last used
        </Badge>
      )}
      <form className="w-full">
        <AuthButton
          provider="google"
          formAction={async () => {
            "use server"
            await signIn("google", {
              redirectTo: redirectTo ?? APP_DOMAIN,
            })
          }}
        >
          Google
        </AuthButton>
      </form>
    </div>
  )
}
