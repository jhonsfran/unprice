export type LedgerEntry = {
  auditPayloadJson: string
  canonicalAuditId: string
  firstSeenAt: number
  idempotencyKey: string
  meterFactsJson?: string
  payloadHash: string
  rejectionReason?: string
  resultJson: string
  status: "processed" | "rejected"
}

export function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    typeof record.auditPayloadJson === "string" &&
    typeof record.canonicalAuditId === "string" &&
    typeof record.firstSeenAt === "number" &&
    typeof record.idempotencyKey === "string" &&
    (record.meterFactsJson === undefined || typeof record.meterFactsJson === "string") &&
    typeof record.payloadHash === "string" &&
    typeof record.resultJson === "string" &&
    (record.status === "processed" || record.status === "rejected") &&
    (record.rejectionReason === undefined || typeof record.rejectionReason === "string")
  )
}
