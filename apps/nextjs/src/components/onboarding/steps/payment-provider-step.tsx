import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { Loader2, WalletCards } from "lucide-react"
import { useState } from "react"
import { useTRPC } from "~/trpc/client"

export function PaymentProviderStep({
  className,
}: React.ComponentProps<"div"> & StepComponentProps) {
  const { updateContext, next } = useOnboarding()
  const trpc = useTRPC()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const setSandboxProvider = useMutation(
    trpc.paymentProvider.setEnabled.mutationOptions({
      onSuccess: async (data) => {
        await updateContext({
          flowData: {
            paymentProvider: data.paymentProviderConfig?.paymentProvider ?? "sandbox",
          },
        })
        await next()
      },
      onError: (error) => {
        setErrorMessage(error.message)
      },
    })
  )

  const useSandbox = () => {
    setErrorMessage(null)
    setSandboxProvider.mutate({
      paymentProvider: "sandbox",
      enabled: true,
    })
  }

  return (
    <div className={cn("flex max-w-md flex-col gap-6", className)}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-8 animate-content items-center justify-center rounded-md delay-0!">
            <WalletCards className="size-6" />
          </div>
          <h1 className="animate-content font-bold text-2xl delay-0!">Payment provider</h1>
          <div className="animate-content text-center text-sm delay-0!">
            Use Sandbox to publish plans, assign subscriptions, settle credits, and generate invoice
            behavior without a real processor.
          </div>
        </div>
        <div className="animate-content delay-200!">
          <Card>
            <CardHeader>
              <CardTitle>Sandbox</CardTitle>
              <CardDescription>
                Test payment behavior with Unprice's built-in provider.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border bg-background-bgSubtle px-3 py-2 text-muted-foreground text-xs">
                No credentials or external processor required.
              </div>
            </CardContent>
            <CardFooter className="flex flex-col gap-3">
              {errorMessage && (
                <div className="w-full rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive text-xs">
                  {errorMessage}
                </div>
              )}
              <Button
                className="w-full"
                onClick={useSandbox}
                disabled={setSandboxProvider.isPending}
              >
                {setSandboxProvider.isPending && (
                  <Loader2 data-icon="inline-start" className="mr-1 size-4 animate-spin" />
                )}
                Use Sandbox
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  )
}
