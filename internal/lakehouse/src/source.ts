export const LAKEHOUSE_SOURCES = ["events", "web_events", "budget_journal"] as const

export type LakehouseSource = (typeof LAKEHOUSE_SOURCES)[number]
