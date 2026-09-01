# Reservation-first landing demo

## Problem

The landing page's main integration sample ends at `access.check`. That call is useful for shadow
mode, but it does not reserve credits or enforce spend. A buyer who sees only the check cannot see
how Unprice stops an unfunded model call or turns actual token usage into an invoice line.

## Design

Replace the main `signUp -> check` sample with one complete AI generation flow:

1. Call `reservations.reserve` with the customer, a maximum amount, and an idempotency key.
2. Return before the provider call when Unprice cannot fund the reservation.
3. Run the model only after the reservation succeeds.
4. Call `reservation.settle` with actual token usage.
5. State that settlement captures actual funded usage and releases the unused amount.

The code sample will use the public `@unprice/api` reservation facade. It will match the working
pattern in `../ai-chatbot` without copying that application's helper layer.

## Supporting paths

Keep two smaller alternatives below the main sample:

- `usage.consume` for a request whose usage amount is known before work starts.
- `access.check` for read-only shadow comparison. Copy must say that it reserves nothing and must
  not guard paid work by itself.

Remove customer signup from the sample. Signup is setup work and hides the runtime value.

## Product story

The section must make this sequence visible without requiring the reader to infer it from API
names:

```text
reserve customer funds -> run the agent -> settle actual usage
         | denied                         | release unused funds
         +-> no provider cost             +-> invoice evidence
```

The primary heading will describe the business outcome, not the number of SDK calls.

## Scope

Change the landing integration section and any nearby demo labels that still present
`access.check` as the main proof. Do not change SDK behavior, API contracts, or the working
`ai-chatbot` project.

## Verification

- The sample uses real public SDK methods and valid input names.
- The visible order is reserve, provider call, settle.
- The denial branch prevents the provider call.
- The page identifies `usage.consume` and `access.check` correctly.
- Typecheck, formatting, and React Doctor pass.
