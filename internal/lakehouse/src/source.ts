export const LAKEHOUSE_SOURCES = ["web_events", "budget_journal"] as const

export type LakehouseSource = (typeof LAKEHOUSE_SOURCES)[number]
