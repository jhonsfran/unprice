import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import Balancer from "react-wrap-balancer"

export function WelcomeStep({ className }: React.ComponentProps<"div">) {
  const { next } = useOnboarding()
  return (
    <div className={cn("flex w-full flex-col gap-6", className)}>
      <div className="flex flex-col items-center gap-2 text-center">
        <Typography variant="h1" className="animate-content">
          <Balancer>Prove one customer money path</Balancer>
        </Typography>
        <Typography variant="p" affects="removePaddingMargin" className="animate-content">
          Create a Sandbox project, publish a workflow plan version, assign a test customer, and
          send usage evidence through the request path.
        </Typography>

        <Button className="mt-8 animate-button" onClick={() => next()}>
          Build the Sandbox money path
        </Button>
      </div>
    </div>
  )
}
