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
