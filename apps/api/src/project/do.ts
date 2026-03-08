import type { DenyReason } from "@unprice/services/customers"
import { log } from "evlog"
import { Server } from "partyserver"

// for now this is used to broadcast events in realtime but could be used to send alerts or
// notifications
export class DurableObjectProject extends Server {
  // Debounce delay for the broadcast
  private lastBroadcastTime = 0
  // debounce delay for the broadcast
  private readonly DEBOUNCE_DELAY = 1000 * 1 // 1 second

  // hibernate the do when no websocket nor connections are active
  static options = {
    hibernate: true,
  }

  async broadcastEvents(data: {
    customerId: string
    featureSlug: string
    type: "can" | "reportUsage"
    success: boolean
    deniedReason?: DenyReason
    usage?: number
    limit?: number
  }) {
    // all events comming from the customer in the same project
    // are broadcasted to the clients connected to it, usually the dashboard
    const now = Date.now()

    if (now - this.lastBroadcastTime >= this.DEBOUNCE_DELAY) {
      this.broadcast(JSON.stringify(data))
      this.lastBroadcastTime = now
    }
  }

  async onConnect() {
    log.info({ message: "Connected to project durable object" })
  }

  async onClose() {
    log.info({ message: "Closed project durable object" })
  }
}
