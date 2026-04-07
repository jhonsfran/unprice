import { PAYMENT_PROVIDERS } from "@unprice/db/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { api } from "~/trpc/server"
import { PaymentProviderConfigForm } from "./_components/payment-provider-config-form"

const PROVIDER_META: Record<string, { label: string; description: string; disabled?: boolean }> = {
  stripe: {
    label: "Stripe",
    description: "Configure live Stripe credentials and webhook secret.",
  },
  sandbox: {
    label: "Sandbox",
    description: "Configure sandbox mode for development and onboarding parity.",
  },
  square: {
    label: "Square",
    description: "Square integration coming soon.",
    disabled: true,
  },
}

export default async function ProjectPaymentSettingsPage() {
  const enabledProviders = PAYMENT_PROVIDERS.filter((p) => !PROVIDER_META[p]?.disabled)

  const configs = await Promise.all(
    enabledProviders.map((provider) => api.paymentProvider.getConfig({ paymentProvider: provider }))
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-row items-center justify-between">
          <div className="flex flex-col space-y-1.5">
            <CardTitle>Payment Provider</CardTitle>
            <CardDescription>
              Configure your provider credentials to enable payment processing for this project
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-8">
        {enabledProviders.map((provider, i) => {
          const meta = PROVIDER_META[provider] ?? { label: provider, description: "" }
          return (
            <section key={provider} className={i > 0 ? "space-y-3 border-t pt-6" : "space-y-3"}>
              <div className="space-y-1">
                <h3 className="font-medium text-sm">{meta.label}</h3>
                <p className="text-muted-foreground text-xs">{meta.description}</p>
              </div>
              <PaymentProviderConfigForm
                provider={configs[i]?.paymentProviderConfig}
                paymentProvider={provider}
              />
            </section>
          )
        })}
      </CardContent>
    </Card>
  )
}
