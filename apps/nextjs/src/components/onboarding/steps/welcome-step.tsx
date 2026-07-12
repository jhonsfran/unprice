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
          <Balancer>Build one Sandbox paid action</Balancer>
        </Typography>
        <Typography variant="p" affects="removePaddingMargin" className="animate-content">
          Create a Sandbox project, publish a plan version, assign a test customer, and generate
          synthetic evidence for the paid action you want to protect.
        </Typography>

        <Button className="mt-8 animate-button" onClick={() => next()}>
          Build the Sandbox paid action
        </Button>
      </div>
    </div>
  )
}
