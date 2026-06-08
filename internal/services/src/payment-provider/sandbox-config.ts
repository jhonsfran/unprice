import type { Database } from "@unprice/db"
import { paymentProviderConfig } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { PaymentProviderConfig } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"

type PaymentProviderConfigWriter = Pick<Database, "insert">

export async function upsertManagedSandboxProviderConfig({
  db,
  projectId,
  existingId,
}: {
  db: PaymentProviderConfigWriter
  projectId: string
  existingId?: string
}): Promise<Result<PaymentProviderConfig, FetchError>> {
  const { val, err } = await wrapResult(
    db
      .insert(paymentProviderConfig)
      .values({
        id: existingId ?? newId("payment_provider_config"),
        projectId,
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

  return Ok(val as PaymentProviderConfig)
}
