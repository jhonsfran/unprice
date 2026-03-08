import type { Analytics, AnalyticsUsage, AnalyticsVerification } from "@unprice/analytics"
import type { EntitlementState } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { UnPriceEntitlementStorageError } from "./errors"
import type { UnPriceEntitlementStorage } from "./storage-provider"

export class MemoryEntitlementStorageProvider implements UnPriceEntitlementStorage {
  readonly name = "memory"
  private states = new Map<string, EntitlementState>()
  private usageRecords: AnalyticsUsage[] = []
  private verifications: AnalyticsVerification[] = []
  private initialized = false
  private logger: Logger
  private analytics?: Analytics

  constructor({
    logger,
    analytics,
  }: {
    logger: Logger
    analytics?: Analytics
  }) {
    this.logger = logger
    this.analytics = analytics
    this.initialized = false
  }

  async insertVerification(
    record: AnalyticsVerification
  ): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      this.verifications.push(record)
      return Promise.resolve(Ok(undefined))
    } catch (error) {
      this.logger.error("Insert verification failed", {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Insert verification failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async insertReportUsageDeniedEvent(_record: {
    project_id: string
    customer_id: string
    feature_slug: string
    timestamp: number
    denied_reason: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    return Ok(undefined)
  }

  private isInitialized(): Result<void, UnPriceEntitlementStorageError> {
    if (!this.initialized) {
      return Err(new UnPriceEntitlementStorageError({ message: "Not initialized" }))
    }
    return Ok(undefined)
  }

  async initialize(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.states.clear()
      this.usageRecords = []
      this.verifications = []
      this.initialized = true
      return Ok(undefined)
    } catch (error) {
      this.initialized = false
      this.states.clear()
      this.usageRecords = []
      this.verifications = []
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Initialize failed: ${error instanceof Error ? error.message : "unknown"}`,
          context: { error: error instanceof Error ? error.message : "unknown" },
        })
      )
    }
  }

  async get(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<EntitlementState | null, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      const key = this.makeKey(params)
      return Ok(this.states.get(key) ?? null)
    } catch (error) {
      this.logger.error("Get failed", { error: error instanceof Error ? error.message : "unknown" })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Get failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async getAll(): Promise<Result<EntitlementState[], UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      return Ok(Array.from(this.states.values()))
    } catch (error) {
      this.logger.error("Get all failed", {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Get all failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async deleteAll(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      this.states.clear()
      this.usageRecords = []
      this.verifications = []
      return Ok(undefined)
    } catch (error) {
      this.logger.error("Delete all failed", {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Delete all failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async set(params: { state: EntitlementState }): Promise<
    Result<void, UnPriceEntitlementStorageError>
  > {
    try {
      this.isInitialized()
      const key = this.makeKey({
        customerId: params.state.customerId,
        projectId: params.state.projectId,
        featureSlug: params.state.featureSlug,
      })
      this.states.set(key, params.state)
      return Ok(undefined)
    } catch (error) {
      this.logger.error("Set failed", { error: error instanceof Error ? error.message : "unknown" })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Set failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async delete(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      this.states.delete(this.makeKey(params))
      return Ok(undefined)
    } catch (error) {
      this.logger.error("Delete failed", {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Delete failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async hasIdempotenceKey(
    idempotenceKey: string
  ): Promise<Result<boolean, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      const exists = this.usageRecords.some((r) => r.idempotence_key === idempotenceKey)
      return Ok(exists)
    } catch (error) {
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Has idempotence key failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async insertUsageRecord(
    record: AnalyticsUsage
  ): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      this.usageRecords.push(record)
      return Ok(undefined)
    } catch (error) {
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Insert usage record failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async deleteAllVerifications(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      this.verifications = []
      return Ok(undefined)
    } catch (error) {
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Delete all verifications failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async deleteAllUsageRecords(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      this.usageRecords = []
      return Ok(undefined)
    } catch (error) {
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Delete all usage records failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async getAllVerifications(): Promise<
    Result<AnalyticsVerification[], UnPriceEntitlementStorageError>
  > {
    try {
      this.isInitialized()
      return Ok([...this.verifications])
    } catch (error) {
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Get verifications failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async getAllUsageRecords(): Promise<Result<AnalyticsUsage[], UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      return Ok([...this.usageRecords])
    } catch (error) {
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Get usage records failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  public makeKey(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): string {
    return `${params.projectId}:${params.customerId}:${params.featureSlug}`
  }

  async flush(): Promise<
    Result<
      {
        usage: { count: number; lastId: string | null }
        verification: { count: number; lastId: string | null }
      },
      UnPriceEntitlementStorageError
    >
  > {
    try {
      this.isInitialized()

      if (this.analytics) {
        if (this.usageRecords.length > 0) {
          await this.analytics.ingestFeaturesUsage(this.usageRecords)
        }
        if (this.verifications.length > 0) {
          await this.analytics.ingestFeaturesVerification(this.verifications)
        }
      }

      const result = {
        usage: {
          count: this.usageRecords.length,
          lastId: this.usageRecords[this.usageRecords.length - 1]?.id ?? null,
        },
        verification: {
          count: this.verifications.length,
          lastId: this.verifications[this.verifications.length - 1]?.request_id ?? null,
        },
      }

      this.usageRecords = []
      this.verifications = []

      return Ok(result)
    } catch (error) {
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Flush failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }

  async reset(): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      this.isInitialized()
      this.states.clear()
      this.usageRecords = []
      this.verifications = []
      return Ok(undefined)
    } catch (error) {
      return Err(
        new UnPriceEntitlementStorageError({
          message: `Reset failed: ${error instanceof Error ? error.message : "unknown"}`,
        })
      )
    }
  }
}
