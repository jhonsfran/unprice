import { buildInlineLakehouseQuery } from "./query-builder"

const metadataRawQuery = buildInlineLakehouseQuery({
  from: { table: "metadata" },
  select: [{ column: "id" }, { column: "payload" }, { column: "timestamp" }],
  orderBy: [{ column: { column: "timestamp" }, direction: "desc" }],
  limit: 200,
})

const entitlementSnapshotsRawQuery = buildInlineLakehouseQuery({
  from: { table: "entitlement_snapshots" },
  distinct: true,
  select: [
    { column: "id" },
    { column: "feature_slug" },
    { column: "feature_type" },
    { column: "aggregation_method" },
    { column: "merging_policy" },
    { column: "limit" },
    { column: "effective_at" },
    { column: "expires_at" },
    { column: "version" },
    { column: "timestamp" },
  ],
  orderBy: [{ column: { column: "timestamp" }, direction: "desc" }],
  limit: 200,
})

const verificationRawQuery = buildInlineLakehouseQuery({
  from: { table: "verifications" },
  select: [
    { column: "id" },
    { column: "customer_id" },
    { column: "feature_slug" },
    { column: "allowed" },
    { column: "denied_reason" },
    { column: "latency" },
    { column: "timestamp" },
  ],
  orderBy: [{ column: { column: "timestamp" }, direction: "desc" }],
  limit: 500,
})

const verificationWithMetadataQuery = `WITH metadata_dedup AS (
  SELECT
    CAST(id AS VARCHAR) AS meta_id,
    project_id,
    customer_id,
    MIN(payload) AS payload
  FROM metadata
  GROUP BY 1, 2, 3
)
SELECT
  v.*,
  CAST(m.payload AS VARCHAR) AS metadata_payload
FROM verifications v
LEFT JOIN metadata_dedup m
  ON CAST(v.meta_id AS VARCHAR) = m.meta_id
  AND v.project_id = m.project_id
  AND v.customer_id = m.customer_id
LIMIT 500`

const usageWithEntitlementContextQuery = buildInlineLakehouseQuery({
  from: { table: "usage", alias: "u" },
  select: [
    { table: "u", column: "id" },
    { table: "u", column: "timestamp" },
    { table: "u", column: "customer_id" },
    { table: "u", column: "feature_slug" },
    { table: "u", column: "usage" },
    { table: "u", column: "cost" },
    { table: "u", column: "rate_amount" },
    { table: "u", column: "rate_currency" },
    { table: "u", column: "entitlement_id" },
    { table: "s", column: "feature_type" },
    { table: "s", column: "aggregation_method" },
    { table: "s", column: "merging_policy" },
    { table: "s", column: "limit" },
    { table: "s", column: "version" },
  ],
  joins: [
    {
      type: "left",
      table: "entitlement_snapshots",
      alias: "s",
      on: [
        {
          left: { table: "u", column: "entitlement_id" },
          right: { table: "s", column: "id" },
        },
        {
          left: { table: "u", column: "project_id" },
          right: { table: "s", column: "project_id" },
        },
        {
          left: { table: "u", column: "customer_id" },
          right: { table: "s", column: "customer_id" },
        },
        {
          left: { table: "u", column: "feature_slug" },
          right: { table: "s", column: "feature_slug" },
        },
      ],
    },
  ],
  where: [{ column: { table: "u", column: "deleted" }, op: "eq", value: 0 }],
  limit: 500,
})

export const PREDEFINED_LAKEHOUSE_QUERIES = {
  allUsage: {
    label: "Usage (raw + metadata)",
    description: "All usage events with metadata tags",
    query: `WITH metadata_dedup AS (
  SELECT
    CAST(id AS VARCHAR) AS meta_id,
    project_id,
    customer_id,
    MIN(payload) AS payload
  FROM metadata
  GROUP BY 1, 2, 3
)
SELECT
  u.*,
  CAST(m.payload AS VARCHAR) AS metadata_payload
FROM usage u
LEFT JOIN metadata_dedup m
  ON CAST(u.meta_id AS VARCHAR) = m.meta_id
  AND u.project_id = m.project_id
  AND u.customer_id = m.customer_id
WHERE u.deleted = 0
LIMIT 500`,
  },
  usageByFeature: {
    label: "Usage by Feature",
    description: "Aggregate usage grouped by feature",
    query: `SELECT
  u.feature_slug,
  COUNT(*) as total_events,
  SUM(u.usage) as total_usage,
  COUNT(DISTINCT u.customer_id) as unique_customers,
  MIN(u.timestamp) as first_event,
  MAX(u.timestamp) as last_event
FROM usage u
WHERE u.deleted = 0
GROUP BY u.feature_slug
ORDER BY total_usage DESC`,
  },
  usageByCustomer: {
    label: "Usage by Customer",
    description: "Aggregate usage grouped by customer",
    query: `SELECT
  u.customer_id,
  COUNT(*) as total_events,
  SUM(u.usage) as total_usage,
  COUNT(DISTINCT u.feature_slug) as features_used,
  MIN(u.timestamp) as first_event,
  MAX(u.timestamp) as last_event
FROM usage u
WHERE u.deleted = 0
GROUP BY u.customer_id
ORDER BY total_usage DESC`,
  },
  usageByRegion: {
    label: "Usage by Region",
    description: "Aggregate usage grouped by region/geography",
    query: `SELECT
  u.region,
  COUNT(*) as total_events,
  SUM(u.usage) as total_usage,
  COUNT(DISTINCT u.customer_id) as unique_customers,
  COUNT(DISTINCT u.feature_slug) as features_used
FROM usage u
WHERE u.deleted = 0
GROUP BY u.region
ORDER BY total_usage DESC`,
  },
  verificationByFeature: {
    label: "Verification Deny Rate by Feature",
    description: "Where users get blocked most",
    query: `SELECT
  v.feature_slug,
  COUNT(*) as total_checks,
  SUM(CASE WHEN v.allowed = 0 THEN 1 ELSE 0 END) as denied,
  ROUND(SUM(CASE WHEN v.allowed = 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 2) as deny_rate_pct,
  AVG(v.latency) as avg_latency
FROM verifications v
GROUP BY v.feature_slug
ORDER BY deny_rate_pct DESC`,
  },
  deniedCustomers: {
    label: "Customers Impacted by Denials",
    description: "Accounts with the most denied checks",
    query: `SELECT
  v.customer_id,
  COUNT(*) as denied_events,
  COUNT(DISTINCT v.feature_slug) as affected_features,
  MIN(v.timestamp) as first_denial,
  MAX(v.timestamp) as last_denial
FROM verifications v
WHERE v.allowed = 0
GROUP BY v.customer_id
ORDER BY denied_events DESC
LIMIT 200`,
  },
  verificationLatency: {
    label: "Verification Latency by Feature",
    description: "Which features are slow to verify",
    query: `SELECT
  v.feature_slug,
  AVG(v.latency) as avg_latency,
  MAX(v.latency) as max_latency,
  COUNT(*) as total_checks
FROM verifications v
GROUP BY v.feature_slug
ORDER BY avg_latency DESC`,
  },
  usageByTagKey: {
    label: "Usage by Tag Key",
    description: "Which metadata tags show up most",
    query: `WITH metadata_dedup AS (
  SELECT
    CAST(id AS VARCHAR) AS meta_id,
    project_id,
    customer_id,
    MIN(payload) AS payload
  FROM metadata
  GROUP BY 1, 2, 3
),
joined AS (
  SELECT u.id, TRY_CAST(m.payload AS JSON) AS payload_json
  FROM usage u
  LEFT JOIN metadata_dedup m
    ON CAST(u.meta_id AS VARCHAR) = m.meta_id
    AND u.project_id = m.project_id
    AND u.customer_id = m.customer_id
  WHERE u.deleted = 0 AND m.payload IS NOT NULL
),
tags AS (
  SELECT unnest(json_keys(payload_json)) AS tag
  FROM joined
  WHERE payload_json IS NOT NULL
)
SELECT tag, COUNT(*) AS events
FROM tags
WHERE tag IS NOT NULL
  AND tag NOT IN ('cost', 'rate', 'rate_amount', 'rate_currency', 'rate_unit_size', 'usage', 'remaining')
GROUP BY tag
ORDER BY events DESC`,
  },
  metadataRaw: {
    label: "Metadata (raw)",
    description: "Raw metadata records with tags",
    query: metadataRawQuery,
  },
  verificationRaw: {
    label: "Verification (raw)",
    description: "Raw verification events",
    query: verificationRawQuery,
  },
  verificationWithMetadata: {
    label: "Verification + Metadata",
    description: "Verification events joined with metadata payload",
    query: verificationWithMetadataQuery,
  },
  entitlementSnapshotsRaw: {
    label: "Entitlement Snapshots (raw)",
    description: "Immutable entitlement snapshots",
    query: entitlementSnapshotsRawQuery,
  },
  usageWithEntitlementContext: {
    label: "Usage + Entitlements",
    description: "Usage joined with immutable entitlement context",
    query: usageWithEntitlementContextQuery,
  },
} as const

export type PredefinedLakehouseQueryKey = keyof typeof PREDEFINED_LAKEHOUSE_QUERIES

export const DEFAULT_LAKEHOUSE_QUERY = PREDEFINED_LAKEHOUSE_QUERIES.allUsage.query
