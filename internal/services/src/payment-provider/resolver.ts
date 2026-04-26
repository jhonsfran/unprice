import type { Database } from "@unprice/db"
import { AesGCM } from "@unprice/db/utils"
import type { PaymentProvider } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { env } from "../../env"
import { UnPriceCustomerError } from "../customers/errors"
import { PaymentProviderService } from "./service"

export class PaymentProviderResolver {
  private readonly db: Database
  private readonly logger: Logger

  constructor({ db, logger }: { db: Database; logger: Logger }) {
    this.db = db
    this.logger = logger
  }

  public async resolve({
    customerId,
    projectId,
    provider,
  }: {
    customerId?: string
    projectId: string
    provider: PaymentProvider
  }): Promise<Result<PaymentProviderService, FetchError | UnPriceCustomerError>> {
    const { err: configErr, val: config } = await wrapResult(
      this.db.query.paymentProviderConfig.findFirst({
        where: (config, { and, eq }) =>
          and(
            eq(config.projectId, projectId),
            eq(config.paymentProvider, provider),
            eq(config.active, true)
          ),
      }),
      (error) =>
        new FetchError({
          message: `error getting payment provider config: ${error.message}`,
          retry: false,
        })
    )

    if (configErr) {
      this.logger.error(configErr, {
        context: "error getting payment provider config",
        customerId,
        projectId,
        provider,
      })
      return Err(configErr)
    }

    if (!config) {
      this.logger.warn("payment provider config not found or not active", {
        customerId,
        projectId,
        provider,
      })
      return Err(
        new UnPriceCustomerError({
          code: "PAYMENT_PROVIDER_CONFIG_NOT_FOUND",
          message: "Payment provider config not found or not active",
        })
      )
    }

    const { err: decryptErr, val: decryptedKey } = await wrapResult(
      this.decryptSecret({
        iv: config.keyIv,
        ciphertext: config.key,
      }),
      (error) =>
        new FetchError({
          message: `error decrypting payment provider token: ${error.message}`,
          retry: false,
        })
    )

    if (decryptErr) {
      this.logger.error(decryptErr, {
        context: "error decrypting payment provider token",
        customerId,
        projectId,
        provider,
      })
      return Err(decryptErr)
    }

    const { err: webhookSecretErr, val: webhookSecret } = await wrapResult(
      this.decryptWebhookSecret(config.webhookSecretIv, config.webhookSecret),
      (error) =>
        new FetchError({
          message: `error decrypting payment provider webhook secret: ${error.message}`,
          retry: false,
        })
    )

    if (webhookSecretErr) {
      this.logger.error(webhookSecretErr, {
        context: "error decrypting payment provider webhook secret",
        customerId,
        projectId,
        provider,
      })
      return Err(webhookSecretErr)
    }

    const { err: providerMappingErr, val: providerMapping } = await wrapResult(
      customerId
        ? this.db.query.customerProviderIds.findFirst({
            where: (mapping, { and, eq }) =>
              and(
                eq(mapping.projectId, projectId),
                eq(mapping.customerId, customerId),
                eq(mapping.provider, provider)
              ),
          })
        : Promise.resolve(undefined),
      (error) =>
        new FetchError({
          message: `error getting customer provider mapping: ${error.message}`,
          retry: false,
        })
    )

    if (providerMappingErr) {
      this.logger.error(providerMappingErr, {
        context: "error getting customer provider mapping",
        customerId,
        projectId,
        provider,
      })
      return Err(providerMappingErr)
    }

    return Ok(
      new PaymentProviderService({
        providerCustomerId: providerMapping?.providerCustomerId ?? undefined,
        logger: this.logger,
        paymentProvider: provider,
        token: decryptedKey,
        webhookSecret: webhookSecret ?? undefined,
      })
    )
  }

  private async decryptSecret({
    iv,
    ciphertext,
  }: {
    iv: string
    ciphertext: string
  }): Promise<string> {
    const aesGCM = await AesGCM.withBase64Key(env.ENCRYPTION_KEY)
    return aesGCM.decrypt({
      iv,
      ciphertext,
    })
  }

  private async decryptWebhookSecret(
    iv: string | null,
    ciphertext: string | null
  ): Promise<string | null> {
    if (!iv || !ciphertext) {
      return null
    }

    return this.decryptSecret({
      iv,
      ciphertext,
    })
  }
}
