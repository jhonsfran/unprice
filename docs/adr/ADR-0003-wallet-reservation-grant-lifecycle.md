# ADR-0003: Wallet Reservation And Grant Lifecycle

## Status

Accepted

## Date

2026-05-17

## Context

Wallet reservations and wallet grants were coupled through the old
`flushReservation({ final })` command. A non-final flush captured usage and
refilled runway, while a final flush captured usage and also decided what
unused reserved funds should become.

That overloaded the meaning of reservation closeout. In particular, unused
granted reservation funds could be released directly to platform funding even
when the grant period had not been explicitly expired. This made a period
allowance look partially missing: the money left `reserved`, but it did not
return to the customer's available grant window.

We need accounting events that match the domain:

```text
release reservation = reserved -> customer available
expire grant        = customer available -> platform funding
```

## Decision

Reservation release and grant expiration are separate financial events.

Wallet reservation lifecycle is represented by explicit commands:

- `captureReservationUsage`: moves consumed funds from `reserved` to
  `consumed`.
- `createReservation`: creates a reservation
- `extendReservation`: moves additional customer available funds into
  `reserved`.
- `releaseReservation`: closes a reservation and restores unused funds to the
  original customer available buckets.
- `expireGrant`: drains only remaining available grant balance to the matching
  platform funding account.

Reservation funding attribution is first-class data. Each reservation funding
leg records the reservation, source bucket, wallet credit when granted,
allocated amount, captured amount, released amount, and ordering. The invariant
is:

```text
allocated = captured + released + still_reserved
```

`wallet_credits.remaining_amount` remains the cache for available grant
balance:

- reserving granted funds decrements it;
- releasing unused granted reservation funds increments it;
- expiring a grant drains it;
- expiration does not touch active reserved funds.

Durable Objects may capture usage, extend reservation runway, and release idle
or closed reservations. Durable Objects must not decide that grant money expires
to platform funding.

The period-close ordering is:

1. Capture pending usage through the period end.
2. Release unused reservation funds back to their grants.
3. Expire the period grant's remaining available balance.
4. Provision the next period grant.

The expiration sweep must skip grants that still have active reservation
funding legs.

## Consequences

### Positive

- Reservation closeout is mechanically simple and does not contain grant
  lifecycle policy.
- Grant availability is understandable from `wallet_credits.remaining_amount`
  and the ledger buckets.
- Expiration is safer: it refuses active reserved funds instead of silently
  crossing lifecycle boundaries.
- Command-specific idempotency makes crash recovery explicit for capture,
  extend, release, and expire.

### Negative

- There is one additional normalized attribution table and one wallet command
  idempotency table.
- Callers that previously treated final flush as "close and expire" must use
  period close plus grant expiration.
- Existing affected balances are not repaired by this decision.

## Guardrails

- Do not add `releaseMode` or any equivalent flag to reservation closeout.
- Do not move reservation funds directly to platform funding.
- Do not expire grants with active reservation funding legs.
- Do not use JSON metadata as accounting truth for reservation funding.

## Related Documents

- [ADR-0001: Canonical Backend Architecture Boundaries](./ADR-0001-canonical-backend-architecture-boundaries.md)
- [ADR-0002: Wallet Payment Provider Activation Guardrails](./ADR-0002-wallet-payment-provider-activation-guardrails.md)
