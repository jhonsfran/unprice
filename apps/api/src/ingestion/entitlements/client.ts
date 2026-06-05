import { type EntitlementWindowClient, buildIngestionWindowName } from "@unprice/services/ingestion"
import type { Env } from "~/env"

export type EntitlementWindowStub = ReturnType<Env["entitlementwindow"]["getByName"]>

export class CloudflareEntitlementWindowClient implements EntitlementWindowClient {
  private readonly appEnv: Env["APP_ENV"]
  private readonly entitlementwindow: Env["entitlementwindow"]

  constructor(env: Pick<Env, "APP_ENV" | "entitlementwindow">) {
    this.appEnv = env.APP_ENV
    this.entitlementwindow = env.entitlementwindow
  }

  // Keep the Durable Object key at entitlement scope, not period scope.
  // This DO owns singleton wallet reservation/recovery state and accepts late
  // events across grant periods. Adding periodKey to the object name would
  // fragment reservation/idempotency state and strand live DO storage without
  // improving current-period hot traffic.
  public getEntitlementWindowStub(params: {
    customerEntitlementId: string
    customerId: string
    projectId: string
  }): EntitlementWindowStub {
    return this.entitlementwindow.getByName(
      buildIngestionWindowName({
        appEnv: this.appEnv,
        customerEntitlementId: params.customerEntitlementId,
        customerId: params.customerId,
        projectId: params.projectId,
      })
    )
  }
}
