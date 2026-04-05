import type { Database } from "@unprice/db"
import { AesGCM } from "@unprice/db/utils"
import type { Customer, PaymentProvider } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { env } from "../../env"
import { UnPriceCustomerError } from "../customers/errors"
import { toErrorContext } from "../utils/log-context"
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
    let customerData: Customer | undefined

    if (customerId) {
      customerData = await this.db.query.customers.findFirst({
        where: (customer, { eq }) => eq(customer.id, customerId),
      })

      if (!customerData) {
        return Err(
          new UnPriceCustomerError({
            code: "CUSTOMER_NOT_FOUND",
            message: "Customer not found",
          })
        )
      }
    }

    const { err: configErr, val: config } = await wrapResult(
      this.db.query.paymentProviderConfig.findFirst({
        where: (config, { and, eq }) =>
          and(
            eq(config.projectId, projectId),
            eq(config.paymentProvider, provider),
            eq(config.active, true)
          ),
      }),
      (err) =>
        new FetchError({
          message: `error getting payment provider config: ${err.message}`,
          retry: false,
        })
    )

    if (configErr) {
      this.logger.error("error getting payment provider config", {
        error: toErrorContext(configErr),
        customerId,
        projectId,
        provider,
      })
      return Err(configErr)
    }

    if (!config) {
      return Err(
        new UnPriceCustomerError({
          code: "PAYMENT_PROVIDER_CONFIG_NOT_FOUND",
          message: "Payment provider config not found or not active",
        })
      )
    }

    const { err: decryptErr, val: decryptedKey } = await wrapResult(
      (async () => {
        const aesGCM = await AesGCM.withBase64Key(env.ENCRYPTION_KEY)
        return aesGCM.decrypt({
          iv: config.keyIv,
          ciphertext: config.key,
        })
      })(),
      (err) =>
        new FetchError({
          message: `error decrypting payment provider token: ${err.message}`,
          retry: false,
        })
    )

    if (decryptErr) {
      this.logger.error("error decrypting payment provider token", {
        error: toErrorContext(decryptErr),
        customerId,
        projectId,
        provider,
      })
      return Err(decryptErr)
    }

    const providerCustomerId = this.getProviderCustomerId(customerData, provider)

    return Ok(
      new PaymentProviderService({
        providerCustomerId,
        logger: this.logger,
        paymentProvider: provider,
        token: decryptedKey,
      })
    )
  }

  private getProviderCustomerId(
    customerData: Customer | undefined,
    provider: PaymentProvider
  ): string | undefined {
    if (provider === "stripe") {
      return customerData?.stripeCustomerId ?? undefined
    }

    if (provider === "sandbox") {
      return customerData?.id ?? undefined
    }

    return customerData?.stripeCustomerId ?? undefined
  }
}
