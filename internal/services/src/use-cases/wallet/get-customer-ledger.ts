import {
  currencySchema,
  customerSelectSchema,
  searchParamsSchemaDataTable,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { FetchError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import {
  CUSTOMER_ACCOUNT_KINDS,
  type CustomerAccountKind,
  type CustomerLedgerMovement,
  PLATFORM_FUNDING_KINDS,
  type UnPriceLedgerError,
  customerAccountKeys,
  platformAccountKey,
} from "../../ledger"

export const customerLedgerAccountSchema = z.enum(CUSTOMER_ACCOUNT_KINDS)

/**
 * The known `metadata.flow` labels a wallet movement can carry. Anything not
 * in this list still renders — it just falls back to the raw gateway source
 * type — so adding a flow in the wallet service never breaks this tab.
 */
export const customerLedgerActivitySchema = z.enum([
  "topup",
  "adjust",
  "reserve",
  "release_reservation",
  "capture",
  "extend",
  "expire",
  "settle_receivable",
  "subscription",
])

/** Who is on one side of a movement. */
export const ledgerPartySchema = z.discriminatedUnion("side", [
  z.object({ side: z.literal("customer"), account: customerLedgerAccountSchema }),
  z.object({ side: z.literal("platform"), funding: z.enum(PLATFORM_FUNDING_KINDS) }),
  z.object({ side: z.literal("external"), name: z.string() }),
])

/**
 * Effect on the balance the customer can actually spend (purchased + granted).
 * `internal` means the money had already left spendable — a capture settling
 * an existing hold, for example — so the row must not read as a fresh charge.
 */
export const ledgerDirectionSchema = z.enum(["in", "out", "internal"])

export const customerLedgerMovementSchema = z.object({
  id: z.string(),
  eventAt: z.coerce.date(),
  flow: z.string().nullable(),
  from: ledgerPartySchema,
  to: ledgerPartySchema,
  // unsigned: direction lives in from/to and `direction`, never in the sign
  amount: z.number().int().nonnegative(),
  direction: ledgerDirectionSchema,
  balanceAfter: z
    .object({ account: customerLedgerAccountSchema, amount: z.number().int() })
    .nullable(),
  runId: z.string().nullable(),
  reservationId: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  statementKey: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
})

export const getCustomerLedgerInputSchema = searchParamsSchemaDataTable.extend({
  projectId: z.string(),
  customerId: z.string(),
})

export const getCustomerLedgerOutputSchema = z.object({
  customer: customerSelectSchema,
  currency: currencySchema,
  movements: customerLedgerMovementSchema.array(),
  pageCount: z.number(),
})

export type GetCustomerLedgerInput = z.infer<typeof getCustomerLedgerInputSchema>
export type GetCustomerLedgerOutput = z.infer<typeof getCustomerLedgerOutputSchema>
export type CustomerLedgerMovementView = z.infer<typeof customerLedgerMovementSchema>
export type LedgerParty = z.infer<typeof ledgerPartySchema>

export type GetCustomerLedgerDeps = {
  services: Pick<ServiceContext, "customerLedger" | "customers">
  logger: Logger
}

/** Accounts whose balance the customer can spend right now. */
const SPENDABLE_ACCOUNTS: readonly CustomerAccountKind[] = ["purchased", "granted"]

export async function getCustomerLedger(
  deps: GetCustomerLedgerDeps,
  rawInput: GetCustomerLedgerInput
): Promise<Result<GetCustomerLedgerOutput | null, FetchError | UnPriceLedgerError>> {
  const input = getCustomerLedgerInputSchema.parse(rawInput)

  deps.logger.set({
    business: {
      operation: "wallet.get_customer_ledger",
      project_id: input.projectId,
      customer_id: input.customerId,
    },
  })

  const customerResult = await deps.services.customers.getCustomerByIdInProject({
    id: input.customerId,
    projectId: input.projectId,
  })

  if (customerResult.err) {
    return Err(customerResult.err)
  }

  if (!customerResult.val) {
    return Ok(null)
  }

  const customer = customerResult.val

  const ledgerResult = await deps.services.customerLedger.listCustomerTransfers({
    projectId: input.projectId,
    customerId: input.customerId,
    kinds: parseFilter(input.filters.account, CUSTOMER_ACCOUNT_KINDS),
    flows: parseFilter(input.filters.activity, customerLedgerActivitySchema.options),
    search: input.search,
    from: input.from !== null ? new Date(input.from) : null,
    to: input.to !== null ? new Date(input.to) : null,
    page: input.page,
    pageSize: input.page_size,
  })

  if (ledgerResult.err) {
    return Err(ledgerResult.err)
  }

  const resolveParty = createPartyResolver(input)

  return Ok(
    getCustomerLedgerOutputSchema.parse({
      customer,
      currency: customer.defaultCurrency,
      movements: ledgerResult.val.movements.map((movement) =>
        toMovementView(movement, resolveParty)
      ),
      pageCount: Math.ceil(ledgerResult.val.total / input.page_size),
    })
  )
}

/**
 * Account name → party. Built once per request from the canonical key
 * builders, so the wire format is never re-derived by string surgery.
 */
function createPartyResolver(input: { projectId: string; customerId: string }) {
  const parties = new Map<string, LedgerParty>()

  const accountKeys = customerAccountKeys(input.customerId)
  for (const account of CUSTOMER_ACCOUNT_KINDS) {
    parties.set(accountKeys[account], { side: "customer", account })
  }

  for (const funding of PLATFORM_FUNDING_KINDS) {
    parties.set(platformAccountKey(funding, input.projectId), { side: "platform", funding })
  }

  return (name: string): LedgerParty => parties.get(name) ?? { side: "external", name }
}

function toMovementView(
  movement: CustomerLedgerMovement,
  resolveParty: (name: string) => LedgerParty
): CustomerLedgerMovementView {
  const from = resolveParty(movement.fromAccount)
  const to = resolveParty(movement.toAccount)
  const direction = resolveDirection(from, to)

  return {
    id: movement.id,
    eventAt: movement.eventAt,
    flow: readString(movement.metadata, "flow") ?? movement.sourceType,
    from,
    to,
    amount: toLedgerMinor(movement.amount),
    direction,
    balanceAfter: resolveBalanceAfter(movement, from, to, direction),
    runId: readRunId(movement),
    reservationId: readString(movement.metadata, "reservation_id"),
    sourceType: movement.sourceType,
    sourceId: movement.sourceId,
    statementKey: movement.statementKey,
    metadata: movement.metadata,
  }
}

function isSpendable(party: LedgerParty): boolean {
  return party.side === "customer" && SPENDABLE_ACCOUNTS.includes(party.account)
}

function resolveDirection(from: LedgerParty, to: LedgerParty): "in" | "out" | "internal" {
  if (isSpendable(to) && !isSpendable(from)) return "in"
  if (isSpendable(from) && !isSpendable(to)) return "out"
  return "internal"
}

/**
 * The balance worth showing is the one the reader is tracking: the spendable
 * account that funded an outgoing movement, the spendable account that
 * received an incoming one, and otherwise wherever the money landed.
 */
function resolveBalanceAfter(
  movement: CustomerLedgerMovement,
  from: LedgerParty,
  to: LedgerParty,
  direction: "in" | "out" | "internal"
): CustomerLedgerMovementView["balanceAfter"] {
  const preferFrom = direction === "out"
  const ordered = preferFrom
    ? ([
        [from, movement.fromBalanceAfter],
        [to, movement.toBalanceAfter],
      ] as const)
    : ([
        [to, movement.toBalanceAfter],
        [from, movement.fromBalanceAfter],
      ] as const)

  for (const [party, balance] of ordered) {
    if (party.side === "customer") {
      return { account: party.account, amount: toLedgerMinor(balance) }
    }
  }

  return null
}

function readString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * Only reservations owned by an agent run carry a run id worth linking. The
 * gateway resolves the owner from the reservation row, which covers release
 * and capture too; transfer metadata is the fallback for the reserve leg.
 */
function readRunId(movement: CustomerLedgerMovement): string | null {
  if (movement.reservationOwnerType === "agent_run" && movement.reservationOwnerId) {
    return movement.reservationOwnerId
  }

  if (readString(movement.metadata, "reservation_owner_type") !== "agent_run") {
    return null
  }

  return readString(movement.metadata, "reservation_owner_id")
}

function parseFilter<T extends string>(
  values: (string | number | boolean)[] | undefined,
  allowed: readonly T[]
): T[] | undefined {
  const parsed = values?.filter((value): value is T => allowed.includes(value as T))

  return parsed?.length ? parsed : undefined
}
