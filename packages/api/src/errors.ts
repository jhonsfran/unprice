// One error union for both SDKs: @unprice/budgets types it from every error schema the API answers
// with, so a status added upstream joins it the next time the SDKs are regenerated.
export type { ApiError, ErrorResponse } from "@unprice/budgets"
