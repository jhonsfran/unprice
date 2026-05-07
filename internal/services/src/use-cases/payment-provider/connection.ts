import { type Database, and, eq } from "@unprice/db"
import { paymentProviderConfig } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { PaymentProvider, PaymentProviderConfig } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { Stripe } from "@unprice/stripe"
import { env } from "../../../env"

type ProviderConnectionDeps = {
  db: Database
  logger: Logger
}

type ProviderConnectionInput = {
  projectId: string
  paymentProvider: PaymentProvider
}

type SetProviderEnabledInput = ProviderConnectionInput & {
  enabled: boolean
}

type StartProviderConnectionInput = ProviderConnectionInput & {
  returnUrl: string
  refreshUrl: string
  ownerEmail?: string | null
}

function createStripeClient(): Result<Stripe, FetchError> {
  if (!env.STRIPE_API_KEY) {
    return Err(
      new FetchError({
        message: "Stripe platform key is not configured",
        retry: false,
      })
    )
  }

  return Ok(
    new Stripe(env.STRIPE_API_KEY, {
      apiVersion: "2023-10-16",
      typescript: true,
    })
  )
}

function mapStripeAccountStatus(account: Stripe.Account): PaymentProviderConfig["status"] {
  if (account.charges_enabled && account.payouts_enabled) {
    return "active"
  }

  if (account.requirements?.disabled_reason) {
    return "disabled"
  }

  if ((account.requirements?.currently_due?.length ?? 0) > 0) {
    return "restricted"
  }

  return "pending"
}

function stripeAccountConnectionData(
  account: Stripe.Account
): PaymentProviderConfig["connectionData"] {
  return {
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    requirements: account.requirements ?? undefined,
    capabilities: account.capabilities
      ? (account.capabilities as unknown as Record<string, unknown>)
      : undefined,
    disabledReason: account.requirements?.disabled_reason ?? null,
  }
}

async function findProviderConnection(
  deps: ProviderConnectionDeps,
  input: ProviderConnectionInput
): Promise<Result<PaymentProviderConfig | undefined, FetchError>> {
  const { val, err } = await wrapResult(
    deps.db.query.paymentProviderConfig.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.projectId, input.projectId), eq(table.paymentProvider, input.paymentProvider)),
    }),
    (error) =>
      new FetchError({
        message: `error getting provider connection: ${error.message}`,
        retry: false,
      })
  )

  if (err) {
    deps.logger.error(err, {
      context: "error getting provider connection",
      projectId: input.projectId,
      paymentProvider: input.paymentProvider,
    })
    return Err(err)
  }

  return Ok(val as PaymentProviderConfig | undefined)
}

async function updateStripeConnectionStatus(
  deps: ProviderConnectionDeps,
  config: PaymentProviderConfig
): Promise<Result<PaymentProviderConfig, FetchError>> {
  if (config.paymentProvider !== "stripe" || config.connectionType !== "managed_connection") {
    return Ok(config)
  }

  if (!config.externalAccountId) {
    return Ok(config)
  }

  const stripeResult = createStripeClient()
  if (stripeResult.err) {
    return Err(stripeResult.err)
  }

  const { val: account, err } = await wrapResult(
    stripeResult.val.accounts.retrieve(config.externalAccountId),
    (error) =>
      new FetchError({
        message: `error retrieving stripe connected account: ${error.message}`,
        retry: false,
      })
  )

  if (err) {
    deps.logger.error(err, {
      context: "error retrieving stripe connected account",
      projectId: config.projectId,
      paymentProvider: config.paymentProvider,
      externalAccountId: config.externalAccountId,
    })
    return Err(err)
  }

  const { val: updated, err: updateErr } = await wrapResult(
    deps.db
      .update(paymentProviderConfig)
      .set({
        status: mapStripeAccountStatus(account),
        connectionData: stripeAccountConnectionData(account),
        updatedAtM: Date.now(),
      })
      .where(
        and(
          eq(paymentProviderConfig.projectId, config.projectId),
          eq(paymentProviderConfig.id, config.id)
        )
      )
      .returning()
      .then((rows) => rows[0] ?? null),
    (error) =>
      new FetchError({
        message: `error updating stripe provider connection: ${error.message}`,
        retry: false,
      })
  )

  if (updateErr) {
    return Err(updateErr)
  }

  return Ok((updated as PaymentProviderConfig | null) ?? config)
}

export async function startProviderConnection(
  deps: ProviderConnectionDeps,
  input: StartProviderConnectionInput
): Promise<Result<{ url: string; paymentProviderConfig: PaymentProviderConfig }, FetchError>> {
  if (input.paymentProvider !== "stripe") {
    return Err(
      new FetchError({
        message: "Managed provider connection is only implemented for Stripe",
        retry: false,
      })
    )
  }

  const stripeResult = createStripeClient()
  if (stripeResult.err) {
    return Err(stripeResult.err)
  }

  const existingResult = await findProviderConnection(deps, input)
  if (existingResult.err) {
    return Err(existingResult.err)
  }

  const existing = existingResult.val
  let externalAccountId = existing?.externalAccountId ?? null

  if (!externalAccountId) {
    const { val: account, err } = await wrapResult(
      stripeResult.val.accounts.create({
        type: "standard",
        email: input.ownerEmail ?? undefined,
        metadata: {
          projectId: input.projectId,
        },
      }),
      (error) =>
        new FetchError({
          message: `error creating stripe connected account: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      return Err(err)
    }

    externalAccountId = account.id
  }

  const { val: config, err: configErr } = await wrapResult(
    deps.db
      .insert(paymentProviderConfig)
      .values({
        id: existing?.id ?? newId("payment_provider_config"),
        projectId: input.projectId,
        paymentProvider: "stripe",
        active: true,
        connectionType: "managed_connection",
        mode: "test",
        status: "pending",
        key: null,
        keyIv: null,
        webhookSecret: null,
        webhookSecretIv: null,
        externalAccountId,
        connectionData: existing?.connectionData ?? null,
      })
      .onConflictDoUpdate({
        target: [paymentProviderConfig.paymentProvider, paymentProviderConfig.projectId],
        set: {
          active: true,
          connectionType: "managed_connection",
          mode: "test",
          status: "pending",
          key: null,
          keyIv: null,
          webhookSecret: null,
          webhookSecretIv: null,
          externalAccountId,
          updatedAtM: Date.now(),
        },
      })
      .returning()
      .then((rows) => rows[0] ?? null),
    (error) =>
      new FetchError({
        message: `error saving stripe provider connection: ${error.message}`,
        retry: false,
      })
  )

  if (configErr) {
    return Err(configErr)
  }

  if (!config) {
    return Err(
      new FetchError({ message: "Stripe provider connection was not saved", retry: false })
    )
  }

  const { val: accountLink, err: accountLinkErr } = await wrapResult(
    stripeResult.val.accountLinks.create({
      account: externalAccountId,
      refresh_url: input.refreshUrl,
      return_url: input.returnUrl,
      type: "account_onboarding",
    }),
    (error) =>
      new FetchError({
        message: `error creating stripe account link: ${error.message}`,
        retry: false,
      })
  )

  if (accountLinkErr) {
    return Err(accountLinkErr)
  }

  return Ok({
    url: accountLink.url,
    paymentProviderConfig: config as PaymentProviderConfig,
  })
}

export async function refreshProviderConnection(
  deps: ProviderConnectionDeps,
  input: StartProviderConnectionInput
): Promise<Result<{ url: string; paymentProviderConfig: PaymentProviderConfig }, FetchError>> {
  return startProviderConnection(deps, input)
}

export async function getProviderConnection(
  deps: ProviderConnectionDeps,
  input: ProviderConnectionInput
): Promise<Result<{ paymentProviderConfig?: PaymentProviderConfig }, FetchError>> {
  const configResult = await findProviderConnection(deps, input)
  if (configResult.err) {
    return Err(configResult.err)
  }

  const config = configResult.val

  if (!config) {
    return Ok({ paymentProviderConfig: undefined })
  }

  const updated = await updateStripeConnectionStatus(deps, config)
  if (updated.err) {
    return Err(updated.err)
  }

  return Ok({ paymentProviderConfig: updated.val })
}

export async function disconnectProviderConnection(
  deps: ProviderConnectionDeps,
  input: ProviderConnectionInput
): Promise<Result<{ paymentProviderConfig?: PaymentProviderConfig }, FetchError>> {
  const { val, err } = await wrapResult(
    deps.db
      .update(paymentProviderConfig)
      .set({
        active: false,
        status: "disabled",
        updatedAtM: Date.now(),
      })
      .where(
        and(
          eq(paymentProviderConfig.projectId, input.projectId),
          eq(paymentProviderConfig.paymentProvider, input.paymentProvider)
        )
      )
      .returning()
      .then((rows) => rows[0] ?? undefined),
    (error) =>
      new FetchError({
        message: `error disconnecting provider connection: ${error.message}`,
        retry: false,
      })
  )

  if (err) {
    return Err(err)
  }

  return Ok({ paymentProviderConfig: val as PaymentProviderConfig | undefined })
}

export async function setProviderEnabled(
  deps: ProviderConnectionDeps,
  input: SetProviderEnabledInput
): Promise<Result<{ paymentProviderConfig?: PaymentProviderConfig }, FetchError>> {
  const existingResult = await findProviderConnection(deps, input)
  if (existingResult.err) {
    return Err(existingResult.err)
  }

  const existing = existingResult.val

  if (!input.enabled) {
    if (!existing) {
      return Ok({ paymentProviderConfig: undefined })
    }

    const { val, err } = await wrapResult(
      deps.db
        .update(paymentProviderConfig)
        .set({
          active: false,
          updatedAtM: Date.now(),
        })
        .where(
          and(
            eq(paymentProviderConfig.projectId, input.projectId),
            eq(paymentProviderConfig.paymentProvider, input.paymentProvider)
          )
        )
        .returning()
        .then((rows) => rows[0] ?? undefined),
      (error) =>
        new FetchError({
          message: `error disabling provider connection: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      return Err(err)
    }

    return Ok({ paymentProviderConfig: val as PaymentProviderConfig | undefined })
  }

  if (input.paymentProvider === "sandbox") {
    const { val, err } = await wrapResult(
      deps.db
        .insert(paymentProviderConfig)
        .values({
          id: existing?.id ?? newId("payment_provider_config"),
          projectId: input.projectId,
          paymentProvider: "sandbox",
          active: true,
          connectionType: "managed_connection",
          mode: "test",
          status: "active",
          key: null,
          keyIv: null,
          webhookSecret: null,
          webhookSecretIv: null,
          externalAccountId: null,
          connectionData: null,
        })
        .onConflictDoUpdate({
          target: [paymentProviderConfig.paymentProvider, paymentProviderConfig.projectId],
          set: {
            active: true,
            connectionType: "managed_connection",
            mode: "test",
            status: "active",
            key: null,
            keyIv: null,
            webhookSecret: null,
            webhookSecretIv: null,
            externalAccountId: null,
            connectionData: null,
            updatedAtM: Date.now(),
          },
        })
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error enabling sandbox provider: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Sandbox provider connection was not saved",
          retry: false,
        })
      )
    }

    return Ok({ paymentProviderConfig: val as PaymentProviderConfig })
  }

  if (input.paymentProvider !== "stripe") {
    return Err(
      new FetchError({
        message: "Payment provider enablement is not implemented for this provider",
        retry: false,
      })
    )
  }

  if (!existing?.externalAccountId) {
    return Err(
      new FetchError({
        message: "Connect Stripe before enabling this payment provider",
        retry: false,
      })
    )
  }

  const { val, err } = await wrapResult(
    deps.db
      .update(paymentProviderConfig)
      .set({
        active: true,
        updatedAtM: Date.now(),
      })
      .where(
        and(
          eq(paymentProviderConfig.projectId, input.projectId),
          eq(paymentProviderConfig.paymentProvider, input.paymentProvider)
        )
      )
      .returning()
      .then((rows) => rows[0] ?? undefined),
    (error) =>
      new FetchError({
        message: `error enabling provider connection: ${error.message}`,
        retry: false,
      })
  )

  if (err) {
    return Err(err)
  }

  return Ok({ paymentProviderConfig: val as PaymentProviderConfig | undefined })
}
