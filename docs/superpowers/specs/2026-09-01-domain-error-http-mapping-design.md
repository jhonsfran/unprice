# Domain error HTTP mapping design

## Goal

Preserve known domain error semantics at the public API boundary. A disabled customer must return
`403 FORBIDDEN`, and other registered domain errors must keep their conflict, precondition,
not-found, or internal classification instead of becoming `400 BAD_REQUEST`.

## Root cause

Domain services expose `resolveDomainErrorKind`, with per-domain maps for customer, subscription,
billing, and use-case errors. The canonical API adapter `toUnpriceApiError` does not use it. It
special-cases every `UnPriceCustomerError` as `BAD_REQUEST`, then treats other `BaseError` values
the same way. The global Hono error handler repeats part of this mapping, so normalized and
unnormalized paths can also disagree.

## Design

Add `forbidden` to `DomainErrorKind`. Classify disabled customers and projects as forbidden,
missing customer records as not found, customer identity conflicts as conflicts, and customer
subscription/configuration requirements as preconditions. Classify replay payload validation
failures as bad requests instead of relying on the API's old catch-all mapping.

`toUnpriceApiError` remains the canonical HTTP adapter. It maps resolved domain kinds as follows:

| Domain kind | Public API code | HTTP status |
| --- | --- | --- |
| `bad_request` | `BAD_REQUEST` | 400 |
| `forbidden` | `FORBIDDEN` | 403 |
| `not_found` | `NOT_FOUND` | 404 |
| `conflict` | `CONFLICT` | 409 |
| `precondition` | `PRECONDITION_FAILED` | 412 |
| `internal` | `INTERNAL_SERVER_ERROR` | 500 |

Infrastructure exceptions keep their current explicit handling. Unknown `BaseError` instances are
internal failures, not assumed client mistakes. The global Hono error handler delegates every
non-`UnpriceApiError` to `toUnpriceApiError`, then uses the existing response serialization path.
This removes its duplicate customer and fetch-error branches.

The public OpenAPI and SDK contract do not change. `FORBIDDEN` and the other mapped codes already
exist in `@unprice/api@0.3.0`.

## Verification

Add focused tests for every domain kind and for an unknown domain error. Assert both the
`UnpriceApiError` classification and serialized status/body behavior. Add a subscription route test
that proves `CUSTOMER_DISABLED` returns `403 FORBIDDEN`. Run the API error tests, the subscription
route tests, API typecheck, and repository validation checks that do not start a server or call live
services.
