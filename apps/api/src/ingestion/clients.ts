import {
  type EntitlementWindowClient,
  type IdempotencyClient,
  buildIngestionWindowName,
} from "@unprice/services/ingestion"
import type { Env } from "~/env"
import { buildIngestionIdempotencyShardName } from "./idempotency"

export type IngestionIdempotencyStub = ReturnType<Env["ingestionidempotency"]["getByName"]>
export type EntitlementWindowStub = ReturnType<Env["entitlementwindow"]["getByName"]>

export class CloudflareIdempotencyClient implements IdempotencyClient {
  private readonly appEnv: Env["APP_ENV"]
  private readonly ingestionidempotency: Env["ingestionidempotency"]

  constructor(env: Pick<Env, "APP_ENV" | "ingestionidempotency">) {
    this.appEnv = env.APP_ENV
    this.ingestionidempotency = env.ingestionidempotency
  }

  public getIdempotencyStub(params: {
    customerId: string
    idempotencyKey: string
    projectId: string
  }): IngestionIdempotencyStub {
    return this.ingestionidempotency.getByName(
      buildIngestionIdempotencyShardName({
        appEnv: this.appEnv,
        projectId: params.projectId,
        customerId: params.customerId,
        idempotencyKey: params.idempotencyKey,
      })
    )
  }
}

export class CloudflareEntitlementWindowClient implements EntitlementWindowClient {
  private readonly appEnv: Env["APP_ENV"]
  private readonly entitlementwindow: Env["entitlementwindow"]

  constructor(env: Pick<Env, "APP_ENV" | "entitlementwindow">) {
    this.appEnv = env.APP_ENV
    this.entitlementwindow = env.entitlementwindow
  }

  public getEntitlementWindowStub(params: {
    customerId: string
    periodKey: string
    projectId: string
    streamId: string
  }): EntitlementWindowStub {
    return this.entitlementwindow.getByName(
      buildIngestionWindowName({
        appEnv: this.appEnv,
        customerId: params.customerId,
        periodKey: params.periodKey,
        projectId: params.projectId,
        streamId: params.streamId,
      })
    )
  }
}
