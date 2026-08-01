import { PAYMENT_PROVIDERS } from "@unprice/db/utils"
import { api } from "~/trpc/server"
import { PaymentProviderConfigForm } from "./_components/payment-provider-config-form"

const PROVIDER_META: Record<string, { disabled?: boolean }> = {
  stripe: {},
  sandbox: {},
  square: {
    disabled: true,
  },
}

export default async function ProjectPaymentSettingsPage(props: {
  params: Promise<{ workspaceSlug: string; projectSlug: string }>
}) {
  const params = await props.params
  const enabledProviders = PAYMENT_PROVIDERS.filter((p) => !PROVIDER_META[p]?.disabled)

  const configs = await Promise.all(
    enabledProviders.map((provider) =>
      api.paymentProvider.getConnection({
        paymentProvider: provider,
        workspaceSlug: params.workspaceSlug,
        projectSlug: params.projectSlug,
      })
    )
  )
  const providerRows = enabledProviders.map((provider, i) => ({
    provider,
    config: configs[i]?.paymentProviderConfig,
  }))

  return (
    <div className="flex flex-col gap-4">
      {providerRows.map(({ provider, config }) => {
        return (
          <PaymentProviderConfigForm
            key={provider}
            provider={config}
            paymentProvider={provider}
            workspaceSlug={params.workspaceSlug}
            projectSlug={params.projectSlug}
          />
        )
      })}
    </div>
  )
}
