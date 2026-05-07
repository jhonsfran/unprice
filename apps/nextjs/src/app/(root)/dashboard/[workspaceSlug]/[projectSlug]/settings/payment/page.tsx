import { PAYMENT_PROVIDERS } from "@unprice/db/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { api } from "~/trpc/server"
import { PaymentProviderConfigForm } from "./_components/payment-provider-config-form"

const PROVIDER_META: Record<string, { disabled?: boolean }> = {
  stripe: {},
  sandbox: {},
  square: {
    disabled: true,
  },
}

export default async function ProjectPaymentSettingsPage() {
  const enabledProviders = PAYMENT_PROVIDERS.filter((p) => !PROVIDER_META[p]?.disabled)

  const configs = await Promise.all(
    enabledProviders.map((provider) =>
      api.paymentProvider.getConnection({ paymentProvider: provider })
    )
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-row items-center justify-between">
          <div className="flex flex-col space-y-1.5">
            <CardTitle>Payment providers</CardTitle>
            <CardDescription>
              Enable the providers that plan versions can use for new subscriptions.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {enabledProviders.map((provider, i) => {
          return (
            <section key={provider} className={i > 0 ? "pt-1" : undefined}>
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
