import type { Database } from "@unprice/db"
import { paymentProviderConfig } from "@unprice/db/schema"
import { AesGCM, newId } from "@unprice/db/utils"
import type { PaymentProvider, PaymentProviderConfig } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { env } from "../../../env"
import { toErrorContext } from "../../utils/log-context"

type SavePaymentProviderConfigDeps = {
  db: Database
  logger: Logger
}

type SavePaymentProviderConfigInput = {
  projectId: string
  paymentProvider: PaymentProvider
  key: string
}

export async function savePaymentProviderConfig(
  deps: SavePaymentProviderConfigDeps,
  input: SavePaymentProviderConfigInput
): Promise<Result<PaymentProviderConfig, FetchError>> {
  const { projectId, paymentProvider, key } = input

  const { val: encryptedKey, err: encryptErr } = await wrapResult(
    (async () => {
      const aesGCM = await AesGCM.withBase64Key(env.ENCRYPTION_KEY)
      return aesGCM.encrypt(key)
    })(),
    (error) =>
      new FetchError({
        message: `error encrypting payment provider key: ${error.message}`,
        retry: false,
      })
  )

  if (encryptErr) {
    deps.logger.error("error encrypting payment provider key", {
      error: toErrorContext(encryptErr),
      projectId,
      paymentProvider,
    })
    return Err(encryptErr)
  }

  const { val, err } = await wrapResult(
    deps.db
      .insert(paymentProviderConfig)
      .values({
        id: newId("payment_provider_config"),
        projectId,
        paymentProvider,
        active: true,
        key: encryptedKey.ciphertext,
        keyIv: encryptedKey.iv,
      })
      .onConflictDoUpdate({
        target: [paymentProviderConfig.paymentProvider, paymentProviderConfig.projectId],
        set: {
          active: true,
          key: encryptedKey.ciphertext,
          keyIv: encryptedKey.iv,
        },
      })
      .returning()
      .then((rows) => rows[0] ?? null),
    (error) =>
      new FetchError({
        message: `error saving payment provider config: ${error.message}`,
        retry: false,
      })
  )

  if (err) {
    deps.logger.error("error saving payment provider config", {
      error: toErrorContext(err),
      projectId,
      paymentProvider,
    })
    return Err(err)
  }

  if (!val) {
    return Err(
      new FetchError({
        message: "Error creating payment provider config",
        retry: false,
      })
    )
  }

  return Ok(val as PaymentProviderConfig)
}
