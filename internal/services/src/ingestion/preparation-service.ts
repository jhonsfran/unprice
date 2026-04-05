import type { CustomerService } from "../customers"
import { type GrantsManager, MAX_EVENT_AGE_MS } from "../entitlements"
import type { IngestionRejectionReason } from "./interface"
import type { IngestionQueueMessage } from "./message"

export type IngestionCandidateGrants = Parameters<
  GrantsManager["resolveIngestionStatesFromGrants"]
>[0]["grants"]

export type PreparedCustomerMessageGroup = {
  candidateGrants: IngestionCandidateGrants
  messages: IngestionQueueMessage[]
  rejectionReason?: IngestionRejectionReason
}

export type PreparedCustomerGrantContext = {
  candidateGrants: IngestionCandidateGrants
  rejectionReason?: IngestionRejectionReason
}

export class IngestionPreparationService {
  private readonly customerService: CustomerService
  private readonly grantsManager: GrantsManager

  constructor(params: { customerService: CustomerService; grantsManager: GrantsManager }) {
    this.customerService = params.customerService
    this.grantsManager = params.grantsManager
  }

  public async prepareCustomerMessageGroup(params: {
    customerId: string
    messages: IngestionQueueMessage[]
    projectId: string
  }): Promise<PreparedCustomerMessageGroup> {
    const { customerId, messages, projectId } = params

    const earliestMessage = messages[0]
    const latestMessage = messages.at(-1)

    if (!earliestMessage || !latestMessage) {
      return {
        messages,
        candidateGrants: [],
      }
    }

    const preparedContext = await this.prepareCustomerGrantContext({
      customerId,
      projectId,
      startAt: Math.max(0, earliestMessage.timestamp - MAX_EVENT_AGE_MS),
      endAt: latestMessage.timestamp,
    })

    return {
      messages,
      candidateGrants: preparedContext.candidateGrants,
      rejectionReason: preparedContext.rejectionReason,
    }
  }

  public async prepareCustomerGrantContext(params: {
    customerId: string
    endAt: number
    projectId: string
    startAt: number
  }): Promise<PreparedCustomerGrantContext> {
    const { customerId, endAt, projectId, startAt } = params

    const { err: customerErr, val: customer } = await this.customerService.getCustomer(customerId)

    if (customerErr) {
      throw customerErr
    }

    if (!customer || customer.projectId !== projectId) {
      return {
        candidateGrants: [],
        rejectionReason: "CUSTOMER_NOT_FOUND",
      }
    }

    const { err, val } = await this.grantsManager.getGrantsForCustomer({
      projectId,
      customerId,
      startAt,
      endAt,
    })

    if (err) {
      throw err
    }

    const candidateGrants = val.grants

    return {
      candidateGrants,
      rejectionReason: hasUsageGrant(candidateGrants) ? undefined : "NO_MATCHING_ENTITLEMENT",
    }
  }
}

function hasUsageGrant(candidateGrants: IngestionCandidateGrants): boolean {
  return candidateGrants.some(
    (grant) =>
      grant.featurePlanVersion.featureType === "usage" &&
      Boolean(grant.featurePlanVersion.meterConfig)
  )
}
