import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { Customer, Subscription, SubscriptionStatus } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import {
  type AnyActorRef,
  and,
  assign,
  createActor,
  fromPromise,
  not,
  setup,
  waitFor,
} from "xstate"

import { UnPriceMachineError } from "./errors"

import type { CustomerService } from "../customers/service"
import { GrantsManager } from "../entitlements/grants"
import type { LedgerGateway } from "../ledger"
import type { RatingService } from "../rating/service"
import { deriveActivationInputsFromPlan } from "../use-cases/billing/derive-provision-inputs"
import {
  type ActivateSubscriptionDeps,
  activateSubscription,
} from "../use-cases/billing/provision-period"
import type { WalletService } from "../wallet"
import sendCustomerNotification, { logTransition, updateSubscription } from "./actions"
import {
  canRenew,
  hasValidPaymentMethod,
  isAdvanceBilling,
  isAutoRenewEnabled,
  isCurrentPhaseNull,
  isSubscriptionActive,
  isTrialExpired,
  isWalletOnlyBilling,
} from "./guards"
import { invoiceSubscription, loadSubscription, renewSubscription } from "./invokes"
import type { SubscriptionRepository } from "./repository"
import type {
  MachineTags,
  SubscriptionActions,
  SubscriptionContext,
  SubscriptionEvent,
  SubscriptionGuards,
  SusbriptionMachineStatus,
} from "./types"

/**
 * Subscription Manager
 *
 * Handles subscription lifecycle using a state machine.
 * Supports trials, billing cycles, and plan changes.
 *
 * States:
 * - pending: Initial state before we determine the actual starting state
 * - trialing: Initial trial period
 * - active: Paid and active subscription
 * - past_due: Failed payment, awaiting resolution
 * - canceled: Terminated subscription
 * - expired: Final state for expired subscriptions
 */
export class SubscriptionMachine {
  private subscriptionId: string
  private projectId: string
  private analytics: Analytics
  private logger: Logger
  private actor!: AnyActorRef
  private db: Database
  private repo: SubscriptionRepository
  private now: number
  private customerService: CustomerService
  private grantService: GrantsManager
  private ratingService: RatingService
  private ledgerService: LedgerGateway
  private walletService: WalletService | null
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private machine: any
  // Serializes event sends to this actor to avoid concurrent transitions/races.
  // Each send chains onto this promise, so events are processed in order.
  // This is per-instance (per-subscription) and prevents overlapping invokes.
  // when i send multiple events at the same time, the events are processed in order
  private sendQueue: Promise<unknown> = Promise.resolve()

  private constructor({
    subscriptionId,
    projectId,
    analytics,
    logger,
    customer,
    ratingService,
    ledgerService,
    walletService,
    now,
    db,
    repo,
  }: {
    subscriptionId: string
    projectId: string
    analytics: Analytics
    logger: Logger
    customer: CustomerService
    ratingService: RatingService
    ledgerService: LedgerGateway
    walletService?: WalletService
    now: number
    db: Database
    repo: SubscriptionRepository
  }) {
    this.subscriptionId = subscriptionId
    this.projectId = projectId
    this.analytics = analytics
    this.logger = logger
    this.now = now
    this.customerService = customer
    this.ratingService = ratingService
    this.ledgerService = ledgerService
    // Nullable on purpose: older callers that don't wire wallet through
    // skip the `activating` state via a guard; once every caller passes
    // walletService this can become required. See `shouldActivate`.
    this.walletService = walletService ?? null
    this.db = db
    this.repo = repo
    this.machine = this.createMachineSubscription()
    this.grantService = new GrantsManager({ db: db, logger: logger })
  }

  /**
   * Creates the state machine definition
   */
  private createMachineSubscription() {
    return setup({
      types: {} as {
        context: SubscriptionContext
        events: SubscriptionEvent
        guards: SubscriptionGuards
        actions: SubscriptionActions
        states: SubscriptionStatus
        tags: MachineTags
        input: {
          now: number
          subscriptionId: string
          projectId: string
        }
      },
      actors: {
        loadSubscription: fromPromise(
          async ({
            input,
          }: {
            input: {
              context: SubscriptionContext
              logger: Logger
              repo: SubscriptionRepository
              customerService: CustomerService
            }
          }) => {
            const result = await loadSubscription({
              context: input.context,
              logger: input.logger,
              repo: input.repo,
              customerService: input.customerService,
            })

            return result
          }
        ),
        invoiceSubscription: fromPromise(
          async ({
            input,
          }: {
            input: {
              context: SubscriptionContext
              logger: Logger
              db: Database
              repo: SubscriptionRepository
              ratingService: RatingService
              ledgerService: LedgerGateway
            }
          }) => {
            const result = await invoiceSubscription({
              context: input.context,
              logger: input.logger,
              db: input.db,
              repo: input.repo,
              ratingService: input.ratingService,
              ledgerService: input.ledgerService,
            })

            return result
          }
        ),
        activateSubscription: fromPromise(
          async ({
            input,
          }: {
            input: {
              context: SubscriptionContext
              db: Database
              walletService: WalletService | null
              ledgerService: LedgerGateway
              logger: Logger
            }
          }) => {
            // If wallet is not wired in for this machine instance, the
            // activating state is a no-op pass-through. Callers that
            // upgrade to Phase 7 activation wire walletService through
            // SubscriptionMachine.create.
            if (!input.walletService) {
              return {
                skipped: true as const,
                grantsIssued: [] as Array<{ grantId: string; amount: number; source: string }>,
              }
            }

            const derived = await deriveActivationInputsFromPlan(input.db, {
              subscriptionId: input.context.subscriptionId,
              projectId: input.context.projectId,
            })

            if (!derived) {
              return {
                skipped: true as const,
                grantsIssued: [] as Array<{ grantId: string; amount: number; source: string }>,
              }
            }

            // Phase 7: activation issues period grants only.
            // - Reservations: lazy in EntitlementWindowDO on first priced event.
            // - Base fees / usage: settled by `invoiceSubscription` at period
            //   boundaries.
            // - Trial credits: issued at `trialing` entry, not here.
            const periodStartAt = new Date(
              input.context.subscription.currentCycleStartAt ?? input.context.now
            )
            const periodEndAt = new Date(
              input.context.subscription.currentCycleEndAt ?? input.context.now
            )

            const deps: ActivateSubscriptionDeps = {
              services: {
                wallet: input.walletService,
                ledger: input.ledgerService,
                // activateSubscription only calls `services.wallet`; the
                // `subscriptions` and `ledger` fields on the Pick type
                // are not dereferenced.
                subscriptions: undefined as never,
              },
              db: input.db,
              logger: input.logger,
            }

            const result = await activateSubscription(deps, {
              subscriptionId: input.context.subscriptionId,
              projectId: input.context.projectId,
              periodStartAt,
              periodEndAt,
              idempotencyKey: `cycle:${input.context.subscriptionId}:${periodStartAt.toISOString()}`,
              grants: derived.grants,
            })

            if (result.err) {
              throw result.err
            }

            return {
              skipped: false as const,
              grantsIssued: result.val.grantsIssued,
            }
          }
        ),
        renewSubscription: fromPromise(
          async ({
            input,
          }: {
            input: {
              context: SubscriptionContext
              logger: Logger
              customerService: CustomerService
              repo: SubscriptionRepository
            }
          }) => {
            const result = await renewSubscription({
              context: input.context,
              logger: input.logger,
              customerService: input.customerService,
              repo: input.repo,
            })

            return result
          }
        ),
      },
      guards: {
        isTrialExpired: isTrialExpired,
        canRenew: canRenew,
        hasValidPaymentMethod: ({ context }) =>
          hasValidPaymentMethod({ context, logger: this.logger }),
        isAutoRenewEnabled: isAutoRenewEnabled,
        isCurrentPhaseNull: isCurrentPhaseNull,
        isSubscriptionActive: isSubscriptionActive,
        isAdvanceBilling: isAdvanceBilling,
        isWalletOnlyBilling: isWalletOnlyBilling,
      },
      actions: {
        logStateTransition: ({ context, event }) =>
          logTransition({ context, event, logger: this.logger }),
        notifyCustomer: ({ context, event }) =>
          sendCustomerNotification({ context, event, logger: this.logger }),
      },
    }).createMachine({
      id: "subscriptionMachine",
      initial: "loading",
      context: ({ input }) =>
        ({
          now: input.now,
          subscriptionId: input.subscriptionId,
          projectId: input.projectId,
          paymentMethodId: null,
          requiredPaymentMethod: false,
          phases: [],
          currentPhase: null,
          openInvoices: [],
          subscription: {} as Subscription,
          customer: {} as Customer,
        }) as SubscriptionContext,
      output: ({ context }) => ({
        error: context.error,
        status: context.subscription?.status,
      }),
      // TODO: add global states here
      states: {
        loading: {
          tags: ["machine", "loading"],
          description:
            "Loading the subscription. This is the initial state which is not reported to the database",
          invoke: {
            id: "loadSubscription",
            src: "loadSubscription",
            input: ({ context }) => ({
              context,
              logger: this.logger,
              repo: this.repo,
              customerService: this.customerService,
            }),
            onDone: {
              target: "restored", // transitional state that will be used to determine the next state
              actions: [
                assign({
                  now: ({ event }) => event.output.now,
                  subscription: ({ event }) => event.output.subscription,
                  currentPhase: ({ event }) => event.output.currentPhase,
                  customer: ({ event }) => event.output.customer,
                  paymentMethodId: ({ event }) => event.output.paymentMethodId,
                  requiredPaymentMethod: ({ event }) => event.output.requiredPaymentMethod,
                }),
              ],
            },
            onError: {
              target: "error",
              actions: assign({
                error: ({ event }) => {
                  return event.error as Error
                },
              }),
            },
          },
        },
        error: {
          //  it's often cleaner to treat the error state as a final state that contains the error information.
          // The waitFor function can then inspect that final state and its context to return a Result.Err
          tags: ["machine", "error"],
          description: "Subscription error, it will throw an error as a final state",
          type: "final",
          entry: ({ context, event }) => {
            // log the error here, then it's propagated to the waitFor function
            this.logger.error(context.error?.message ?? "Unknown error", {
              subscriptionId: this.subscriptionId,
              customerId: context.customer.id,
              currentPhaseId: context.currentPhase?.id,
              projectId: this.projectId,
              now: this.now,
              event: JSON.stringify(event),
            })
          },
        },
        restored: {
          description: "Subscription restored, transition to the correct state",
          tags: ["machine", "loading"],
          always: [
            {
              target: "trialing",
              guard: ({ context }) => context.subscription.status === "trialing",
              actions: "logStateTransition",
            },
            {
              target: "active",
              guard: ({ context }) => context.subscription.status === "active",
              actions: "logStateTransition",
            },
            {
              target: "pending_payment",
              guard: ({ context }) => context.subscription.status === "pending_payment",
              actions: "logStateTransition",
            },
            {
              target: "pending_activation",
              guard: ({ context }) => context.subscription.status === "pending_activation",
              actions: "logStateTransition",
            },
            {
              target: "past_due",
              guard: ({ context }) => context.subscription.status === "past_due",
              actions: "logStateTransition",
            },
            {
              target: "canceled",
              guard: ({ context }) => context.subscription.status === "canceled",
              actions: "logStateTransition",
            },
            {
              target: "expired",
              guard: ({ context }) => context.subscription.status === "expired",
              actions: "logStateTransition",
            },
            // if the subscription is in an unknown state, transition to error
            {
              target: "error",
              actions: [
                "logStateTransition",
                assign({
                  error: () => ({
                    message: "Subscription is in an unknown state",
                  }),
                }),
              ],
            },
          ],
        },
        trialing: {
          tags: ["subscription"],
          description: "Subscription is trialing, meaning is waiting for the trial to end",
          on: {
            // first possible event is renew which will end the trial and update the phase
            RENEW: [
              {
                guard: "isCurrentPhaseNull", // verify that the subscription has a current phase
                target: "error", // if the subscription has no current phase, throw an error
                actions: assign({
                  error: () => ({
                    message: "Subscription has no active phase",
                  }),
                }),
              },
              {
                guard: not("isSubscriptionActive"), // verify that the subscription is active
                target: "error", // if the subscription is not active, throw an error
                actions: assign({
                  error: () => ({
                    message: "Subscription is not active",
                  }),
                }),
              },
              {
                guard: and(["isTrialExpired", "hasValidPaymentMethod", "canRenew"]), // verify that the trial has expired and the payment method is valid
                target: "renewing", // if the trial has expired and the payment method is valid, transition to the invoicing state
                actions: "logStateTransition",
              },
              {
                target: "error", // if the trial has not expired or the payment method is invalid, throw an error
                actions: assign({
                  error: ({ context }) => {
                    const trialEndAt = context.currentPhase?.trialEndsAt! // the state machine already verified that the subscription has a current phase
                    const trialEndAtDate = new Date(trialEndAt).toLocaleString()

                    const canRenewResult = canRenew({ context })
                    const isExpired = isTrialExpired({ context })
                    const isPaymentMethodValid = hasValidPaymentMethod({
                      context,
                      logger: this.logger,
                    })

                    if (!isExpired) {
                      return {
                        message: `Cannot end trial, dates are not due yet at ${trialEndAtDate}`,
                      }
                    }

                    if (!canRenewResult) {
                      return {
                        message: `Cannot end trial, subscription is not due to be renewed at ${trialEndAtDate}`,
                      }
                    }

                    if (!isPaymentMethodValid) {
                      return {
                        message: `Cannot end trial, payment method is invalid at ${trialEndAtDate}`,
                      }
                    }

                    return {
                      message: `Cannot end trial, dates are not due yet and payment method is invalid at ${trialEndAtDate}`,
                    }
                  },
                }),
              },
            ],
          },
        },
        pending_payment: {
          tags: ["subscription"],
          description:
            "Pay-in-advance plan waiting on the first payment provider webhook before the subscription becomes active. Customer cannot consume usage yet — the EntitlementWindowDO denies events while the wallet is empty.",
          on: {
            // First successful payment of the bootstrap invoice settles the
            // wallet topup; the webhook fires PAYMENT_SUCCESS, which moves us
            // into `activating` to issue period grants and flip to `active`.
            PAYMENT_SUCCESS: {
              target: "activating",
              actions: "logStateTransition",
            },
            // Provider declined the first payment. Surface as `past_due` so
            // the same retry/dunning flow that handles renewal failures kicks
            // in — no special-case path for first-payment failure.
            PAYMENT_FAILURE: {
              target: "past_due",
              actions: "logStateTransition",
            },
            CANCEL: {
              target: "canceling",
              actions: "logStateTransition",
            },
          },
        },
        invoicing: {
          tags: ["machine", "transition"],
          description: "Invoicing the subscription depending on the whenToBill setting",
          invoke: {
            id: "invoiceSubscription",
            src: "invoiceSubscription",
            input: ({ context }) => ({
              context,
              logger: this.logger,
              db: this.db,
              repo: this.repo,
              ratingService: this.ratingService,
              ledgerService: this.ledgerService,
            }),
            onDone: {
              target: "activating",
              actions: [
                assign({
                  subscription: ({ event, context }) => {
                    if (event.output.subscription) {
                      return event.output.subscription
                    }

                    return context.subscription
                  },
                }),
                "logStateTransition",
                "notifyCustomer",
              ],
            },
            onError: {
              target: "error",
              actions: [
                // update the metadata for the subscription to keep track of the reason
                ({ context }) =>
                  updateSubscription({
                    context,
                    subscription: {
                      metadata: {
                        reason: "invoice_failed",
                        note: "Invoice failed after trying to invoice",
                      },
                    },
                    repo: this.repo,
                  }),
                assign({
                  error: ({ event }) => ({
                    message: `Invoice failed: ${(event.error as Error)?.message ?? "Unknown error"}`,
                  }),
                }),
                "logStateTransition",
              ],
            },
          },
        },
        renewing: {
          tags: ["machine", "transition"],
          description: "Renewing the subscription, update billing dates for the next cycle",
          invoke: {
            id: "renewSubscription",
            src: "renewSubscription",
            input: ({ context }) => ({
              context,
              customerService: this.customerService,
              logger: this.logger,
              repo: this.repo,
            }),
            onDone: {
              target: "activating",
              actions: [
                assign({
                  subscription: ({ event, context }) => {
                    if (event.output.subscription) {
                      return event.output.subscription
                    }

                    return context.subscription
                  },
                }),
                "logStateTransition",
                "notifyCustomer",
              ],
            },
            onError: {
              target: "error",
              actions: assign({
                error: ({ event }) => {
                  const err = event.error as Error
                  return {
                    message: err.message,
                  }
                },
              }),
            },
          },
        },
        activating: {
          tags: ["machine", "transition"],
          description:
            "Issues plan-included credits and opens per-meter reservations for the current billing period. Phase 7 activation hook — runs after invoicing or renewal, before the subscription enters `active`. No-op when walletService isn't wired in.",
          invoke: {
            id: "activateSubscription",
            src: "activateSubscription",
            input: ({ context }) => ({
              context,
              db: this.db,
              walletService: this.walletService,
              ledgerService: this.ledgerService,
              logger: this.logger,
            }),
            onDone: {
              target: "active",
              actions: ["logStateTransition"],
            },
            // Activation failure is recoverable: park the subscription in
            // `pending_activation` (a tagged subscription state, so the
            // status persists to the DB) and let the activation sweeper
            // retry. The previous `error` (final) target left the machine
            // dead while the DB row stayed `active` — paid plans then had
            // no grants and ingestion saw a green light. See HARD-007.
            onError: {
              target: "pending_activation",
              actions: [
                assign({
                  error: ({ event }) => ({
                    message: `Activation failed: ${(event.error as Error)?.message ?? "Unknown error"}`,
                  }),
                }),
                "logStateTransition",
              ],
            },
          },
        },
        pending_activation: {
          tags: ["subscription"],
          description:
            "Wallet activation failed (period grants could not be issued). The subscription is parked here until the activation sweeper retries successfully. Ingestion is denied while in this state.",
          on: {
            // Sweeper / manual retry path. Re-enters `activating` which
            // re-runs grant issuance under the same advisory lock; grant
            // idempotency keys keep retries convergent on the same
            // wallet_grants rows.
            ACTIVATE: {
              target: "activating",
              actions: "logStateTransition",
            },
            CANCEL: {
              target: "canceling",
              actions: "logStateTransition",
            },
          },
        },
        active: {
          tags: ["subscription"],
          description: "Subscription is active",
          on: {
            ACTIVATE: {
              target: "activating",
              actions: "logStateTransition",
            },
            CANCEL: {
              target: "canceling",
              actions: "logStateTransition",
            },
            CHANGE: {
              target: "changing",
              actions: "logStateTransition",
            },
            // if the subscription is on advance billing and can be renewed, renew the subscription
            PAYMENT_SUCCESS: [
              {
                guard: and(["isAdvanceBilling", "canRenew"]),
                target: "renewing",
                actions: ["logStateTransition"],
              },
              { target: "active", actions: ["logStateTransition"] },
            ],
            PAYMENT_FAILURE: {
              target: "past_due",
              actions: [
                "logStateTransition",
                ({ event }) => {
                  // TODO: notify the customer or admin
                  console.info("Payment failed", event)
                },
              ],
            },
            // if the subscription is on advance billing and can be renewed, renew the subscription
            INVOICE_SUCCESS: [
              {
                guard: and(["isAdvanceBilling", "canRenew"]),
                target: "renewing",
                actions: ["logStateTransition"],
              },
              { target: "active", actions: ["logStateTransition"] },
            ],
            INVOICE_FAILURE: {
              target: "past_due",
              actions: [
                "logStateTransition",
                ({ event }) => {
                  // TODO: notify the customer or admin
                  console.info("Invoice failed", event)
                },
              ],
            },
            RENEW: [
              {
                guard: "isCurrentPhaseNull", // verify that the subscription has a current phase
                target: "error", // if the subscription has no current phase, throw an error
                actions: assign({
                  error: () => ({
                    message: "Subscription has no active phase",
                  }),
                }),
              },
              {
                guard: not("isSubscriptionActive"), // verify that the subscription is active
                target: "error", // if the subscription is not active, throw an error
                actions: assign({
                  error: () => ({
                    message: "Subscription is not active",
                  }),
                }),
              },
              {
                guard: and(["canRenew", "isAutoRenewEnabled"]), // only renew if the subscription can be renewed and auto renew is enabled
                target: "renewing",
                actions: "logStateTransition",
              },
              {
                guard: not("isAutoRenewEnabled"), // if auto renew is disabled, expire the subscription
                target: "expired",
                actions: "logStateTransition",
              },
              {
                target: "error",
                actions: assign({
                  error: ({ context }) => {
                    const renewAtDate = context.subscription.renewAt
                      ? new Date(context.subscription.renewAt).toLocaleString()
                      : new Date(context.now).toLocaleString()
                    const renew = canRenew({ context })
                    const autoRenew = isAutoRenewEnabled({ context })

                    if (!autoRenew) {
                      return {
                        message: "Cannot renew subscription, auto renew is disabled",
                      }
                    }

                    if (!renew) {
                      return {
                        message: `Cannot renew subscription, subscription  will be renewed at ${renewAtDate}`,
                      }
                    }

                    return {
                      message:
                        "Cannot renew subscription, dates are not due yet and auto renew is disabled",
                    }
                  },
                }),
              },
            ],
            INVOICE: [
              {
                // Wallet-only subscriptions never invoice — usage drains the
                // wallet directly. Reject INVOICE so a stray scheduler tick
                // can't push the machine through the BILL phase.
                guard: "isWalletOnlyBilling",
                target: "error",
                actions: assign({
                  error: () => ({
                    message: "Cannot invoice wallet-only subscription (BILL phase is skipped)",
                  }),
                }),
              },
              {
                guard: and(["hasValidPaymentMethod"]),
                target: "invoicing",
                actions: "logStateTransition",
              },
              {
                target: "error",
                actions: assign({
                  error: ({ context }) => {
                    const isPaymentMethodValid = hasValidPaymentMethod({
                      context,
                      logger: this.logger,
                    })

                    if (!isPaymentMethodValid) {
                      return {
                        message: "Cannot invoice subscription, payment method is invalid",
                      }
                    }

                    return {
                      message: "Cannot invoice subscription, payment method is invalid",
                    }
                  },
                }),
              },
            ],
          },
        },
        past_due: {
          tags: ["subscription"],
          description: "Subscription is past due can retry payment or invoice",
          on: {
            PAYMENT_SUCCESS: [
              {
                guard: and(["isAdvanceBilling", "canRenew"]),
                target: "renewing",
                actions: ["logStateTransition"],
              },
              { target: "active", actions: ["logStateTransition"] },
            ],
            PAYMENT_FAILURE: {
              target: "past_due",
              actions: [
                "logStateTransition",
                ({ event }) => {
                  // TODO: notify the customer or admin
                  console.info("Payment failed", event)
                },
              ],
            },
            INVOICE_FAILURE: {
              target: "past_due",
              actions: [
                "logStateTransition",
                ({ event }) => {
                  // TODO: notify the customer or admin
                  console.info("Invoice failed", event)
                },
              ],
            },
            INVOICE_SUCCESS: [
              {
                guard: and(["isAdvanceBilling", "canRenew"]),
                target: "renewing",
                actions: ["logStateTransition"],
              },
              { target: "active", actions: ["logStateTransition"] },
            ],
            CANCEL: {
              target: "canceled",
              actions: "logStateTransition",
            },
            INVOICE: [
              {
                guard: "isWalletOnlyBilling",
                target: "error",
                actions: assign({
                  error: () => ({
                    message: "Cannot invoice wallet-only subscription (BILL phase is skipped)",
                  }),
                }),
              },
              {
                guard: and(["hasValidPaymentMethod"]),
                target: "invoicing",
                actions: "logStateTransition",
              },
              {
                target: "error",
                actions: assign({
                  error: () => ({
                    message: "Cannot invoice subscription yet, payment method is invalid",
                  }),
                }),
              },
            ],
          },
        },
        // TODO: implement the rest of the states as they become relevant
        canceling: {
          tags: ["machine", "transition"],
          description: "Canceling the subscription, update billing dates",
        },
        changing: {
          tags: ["machine", "transition"],
          description: "Changing the subscription, update billing dates",
        },
        expiring: {
          tags: ["machine", "transition"],
          description: "Subscription expired, no more payments will be made",
        },
        canceled: {
          tags: ["subscription", "final"],
          type: "final",
          description: "Subscription canceled, no more payments will be made",
        },
        expired: {
          tags: ["subscription", "final"],
          description: "Subscription expired, no more payments will be made",
          type: "final",
        },
      },
    })
  }

  private async initialize(opts?: { dryRun?: boolean }): Promise<
    Result<SusbriptionMachineStatus, UnPriceMachineError>
  > {
    this.actor = createActor(this.machine, {
      input: {
        subscriptionId: this.subscriptionId,
        projectId: this.projectId,
        now: this.now,
      },
    })

    // Subscribe to ALL state changes and persist them
    let lastPersisted: SubscriptionStatus | null = null

    this.actor.subscribe({
      next: async (snapshot) => {
        // only persist the subscription status
        if (!snapshot.hasTag("subscription") || opts?.dryRun) return

        const currentState = snapshot.value as SusbriptionMachineStatus
        if (currentState === lastPersisted) return

        try {
          await this.repo.updateSubscription({
            subscriptionId: this.subscriptionId,
            projectId: this.projectId,
            data: {
              status: currentState as SubscriptionStatus,
              active: !["expired", "canceled"].includes(currentState),
            },
          })

          // Keep the ACL cache in sync. The bouncer reads from it (Edge,
          // ~0-10ms latency) and denies/allows ingestion based on the
          // subscriptionStatus. Without this, transitions like
          // active → pending_activation / past_due would only take effect
          // after the SWR TTL elapses, leaving the customer's events
          // unblocked for the cache window. Best-effort: failures here
          // do not roll back the persisted status — the cache will catch
          // up on the next miss.
          const customerId = snapshot.context.customer?.id
          if (customerId) {
            try {
              await this.customerService.updateAccessControlList({
                customerId,
                projectId: this.projectId,
                updates: { subscriptionStatus: currentState as SubscriptionStatus },
              })
            } catch (cacheErr) {
              this.logger.warn("Failed to refresh ACL cache after status change", {
                subscriptionId: this.subscriptionId,
                projectId: this.projectId,
                customerId,
                state: currentState,
                error: (cacheErr as Error).message,
              })
            }
          }

          lastPersisted = currentState as SubscriptionStatus
        } catch (err) {
          this.logger.error(err as Error, {
            subscriptionId: this.subscriptionId,
            projectId: this.projectId,
            state: currentState,
            context: "Failed to update subscription status",
          })
        }
      },
    })

    // Start the actor
    this.actor.start()

    // Wait for initialization to complete
    const result = await this.waitFor({ timeout: 5000, tag: "subscription" })

    if (result.err) {
      return Err(result.err)
    }

    return Ok(result.val)
  }

  public getState(): SusbriptionMachineStatus {
    return this.actor.getSnapshot().value as SusbriptionMachineStatus
  }

  public static async create(payload: {
    subscriptionId: string
    projectId: string
    analytics: Analytics
    logger: Logger
    customer: CustomerService
    ratingService: RatingService
    ledgerService: LedgerGateway
    walletService?: WalletService
    now: number
    db: Database
    repo: SubscriptionRepository
    dryRun?: boolean
  }): Promise<Result<SubscriptionMachine, UnPriceMachineError>> {
    const subscription = new SubscriptionMachine(payload)

    try {
      const result = await subscription.initialize({ dryRun: payload.dryRun })

      if (result.err) {
        return Err(result.err)
      }

      return Ok(subscription)
    } catch (error) {
      return Err(new UnPriceMachineError({ message: (error as Error).message ?? "Unknown error" }))
    }
  }

  // Sends an event and waits until the machine reaches one of the target states or tag.
  // Uses waitFor under the hood; set longer timeouts for I/O-heavy transitions (e.g., invoicing).
  private async sendAndWait(
    event: SubscriptionEvent,
    opts?: { states?: SusbriptionMachineStatus[]; tag?: MachineTags; timeout?: number }
  ): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    // serialize sends to this actor
    const run = async () => {
      const snapshot = this.actor.getSnapshot()
      if (!snapshot.can(event)) {
        return Err(
          new UnPriceMachineError({
            message: `Transition not allowed from ${snapshot.value} via ${event.type}`,
          })
        )
      }

      this.actor.send(event)

      const res = await this.waitFor({
        states: opts?.states,
        tag: opts?.tag,
        timeout: opts?.timeout,
      })
      return res
    }

    // chain onto queue to keep order; ignore previous rejection
    this.sendQueue = this.sendQueue.then(run, run)
    return this.sendQueue as Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>>
  }

  private async waitFor({
    timeout = 10000,
    states,
    tag,
  }: {
    timeout?: number
    states?: SusbriptionMachineStatus[]
    tag?: MachineTags
  }): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    try {
      // Wait for the desired tag OR the error tag OR final state
      const snap = await waitFor(
        this.actor,
        (s) =>
          Boolean(
            states?.some((st) => s.matches(st)) ||
              (tag && s.hasTag(tag)) ||
              s.hasTag("error") ||
              s.hasTag("final")
          ),
        { timeout }
      )
      if (snap.hasTag("error")) {
        // Correctly access the error from the context
        return Err(
          new UnPriceMachineError({ message: snap.context.error?.message ?? "Unknown error" })
        )
      }

      return Ok(snap.value as SusbriptionMachineStatus)
    } catch (e) {
      return Err(new UnPriceMachineError({ message: (e as Error)?.message ?? "Timeout" }))
    }
  }

  /**
   * Renews the subscription for the next billing cycle
   */
  public async renew(): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return this.sendAndWait({ type: "RENEW" }, { tag: "subscription", timeout: 15000 })
  }

  public async invoice(): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return this.sendAndWait({ type: "INVOICE" }, { tag: "subscription", timeout: 30000 })
  }

  /**
   * Triggers Phase 7 wallet activation (plan credits + reservations)
   * for an already-active subscription. Used when a subscription is
   * created directly as active (e.g. sandbox provider, no trial).
   */
  public async activate(): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return this.sendAndWait({ type: "ACTIVATE" }, { tag: "subscription", timeout: 15000 })
  }

  public async reportPaymentSuccess({
    invoiceId,
  }: {
    invoiceId: string
  }): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return await this.sendAndWait({ type: "PAYMENT_SUCCESS", invoiceId }, { states: ["active"] })
  }

  public async reportPaymentFailure({
    invoiceId,
    error,
  }: {
    invoiceId: string
    error: string
  }): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return await this.sendAndWait(
      { type: "PAYMENT_FAILURE", invoiceId, error },
      { states: ["past_due"] }
    )
  }

  public async reportInvoiceSuccess({
    invoiceId,
  }: {
    invoiceId: string
  }): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return await this.sendAndWait(
      {
        type: "INVOICE_SUCCESS",
        invoiceId,
      },
      { states: ["active"] }
    )
  }

  public async reportInvoiceFailure({
    error,
    invoiceId,
  }: {
    invoiceId: string
    error: string
  }): Promise<Result<SusbriptionMachineStatus, UnPriceMachineError>> {
    return await this.sendAndWait(
      {
        type: "INVOICE_FAILURE",
        invoiceId,
        error,
      },
      { states: ["past_due"] }
    )
  }

  public async shutdown(timeout = 5000): Promise<void> {
    // if there are previous events in the queue, wait for them to complete
    if (this.sendQueue) {
      try {
        await Promise.race([
          this.sendQueue,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeout)),
        ])
      } catch {}
    }
    this.actor.stop()
  }
}
