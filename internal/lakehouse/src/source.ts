export const LAKEHOUSE_SOURCES = ["events", "web_events"] as const

export type LakehouseSource = (typeof LAKEHOUSE_SOURCES)[number]
