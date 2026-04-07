import { GalleryVerticalEnd } from "lucide-react"

import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { cn } from "@unprice/ui/utils"
import { PaymentProviderConfigForm } from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/payment/_components/payment-provider-config-form"

export function PaymentProviderStep({
  className,
}: React.ComponentProps<"div"> & StepComponentProps) {
  const { updateContext, next } = useOnboarding()

  return (
    <div className={cn("flex max-w-md flex-col gap-6", className)}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          {/* biome-ignore lint/a11y/useValidAnchor: <explanation> */}
          <a href="#" className="flex flex-col items-center gap-2 font-medium">
            <div className="flex size-8 animate-content items-center justify-center rounded-md delay-0!">
              <GalleryVerticalEnd className="size-6" />
            </div>
          </a>
          <h1 className="animate-content font-bold text-2xl delay-0!">
            Connect a Payment Provider
          </h1>
          <div className="animate-content text-center text-sm delay-0!">
            A payment provider is required to publish plans. Start with sandbox now, then configure
            your production provider when you are ready to go live.
          </div>
        </div>
        <div className="animate-content delay-200!">
          <PaymentProviderConfigForm
            isOnboarding={true}
            paymentProvider="sandbox"
            skip={true}
            onSuccess={(data) => {
              updateContext({
                flowData: {
                  paymentProvider: data,
                },
              })
              next()
            }}
            onSkip={() => {
              updateContext({
                flowData: {
                  paymentProvider: "sandbox",
                },
              })
              next()
            }}
          />
        </div>
      </div>
    </div>
  )
}
