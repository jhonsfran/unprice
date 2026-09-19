import type { EntitlementWindowClient } from "@unprice/services/ingestion"
import type { Env } from "~/env"
import { type EntitlementWindowStub, getEntitlementWindowStub } from "../do-placement"

export type { EntitlementWindowStub }

export class CloudflareEntitlementWindowClient implements EntitlementWindowClient {
  private readonly env: Pick<Env, "APP_ENV" | "entitlementwindow">

  constructor(env: Pick<Env, "APP_ENV" | "entitlementwindow">) {
    this.env = env
  }

  // Keep the Durable Object key at entitlement scope, not period scope.
  // This DO owns singleton wallet reservation/recovery state and accepts late
  // events across grant periods. Adding periodKey to the object name would
  // fragment reservation/idempotency state and strand live DO storage without
  // improving current-period hot traffic.
  //
  // Addressing (name, jurisdiction, location hint) lives in do-placement.ts —
  // the run-budget pricing delegate reaches the same object and must not
  // derive the name a second time.
  public getEntitlementWindowStub(params: {
    customerEntitlementId: string
    customerId: string
    projectId: string
  }): EntitlementWindowStub {
    return getEntitlementWindowStub(this.env, params)
  }
}
