---
"@unprice/api": minor
---

Runs, reservations, and ingestion replay are removed.

- `runs.start`, `runs.consume`, `runs.settle`, `runs.end`, and `runs.get` are gone, with the `/v1/runs/*` routes. A capped run is a budget key with `closesAt`: use `unprice.budgets.upsert` and `unprice.budget(key)`.
- `reservations.reserve` and its `Reservation`, `Reservations`, `ReservationSettlement`, `ReserveInput`, and `SettleReservationInput` types are gone. Hold a maximum cost with `unprice.budget(key).authorize` and settle the hold.
- `ingestionEvents.replay` is gone: usage goes to the payer budget directly, so there is no failed queue event to replay.
