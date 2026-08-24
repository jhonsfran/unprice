---
"@unprice/api": minor
---

Add the `reservations` SDK facade for one expensive operation. Applications can reserve a maximum
cost before provider work starts, settle actual feature usage, or release a known non-billable
reservation. Settlement uses the first-class `runs.settle` endpoint so incurred usage bypasses the
feature and run-budget limits, reports whether the full cost was funded, and records full usage.
The declared maximum remains a hard capture ceiling when actual provider usage costs more.
The one-operation facade then closes the underlying run.
