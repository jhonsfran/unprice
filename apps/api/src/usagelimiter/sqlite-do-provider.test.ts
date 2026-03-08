import { describe, expect, it, vi } from "vitest"
vi.mock("../../drizzle/migrations", () => ({
  default: {
    journal: { version: "0", dialect: "sqlite", entries: [] },
    migrations: {},
  },
}))

import { SqliteDOStorageProvider } from "./sqlite-do-provider"

type MockFn = ReturnType<typeof vi.fn>

interface TestProvider extends Record<string, unknown> {
  initialized: boolean
  inFlightFlush: Promise<unknown> | null
  cursors: {
    lastTinybirdUsageSeq: number | null
    lastR2UsageSeq: number | null
    lastTinybirdVerificationSeq: number | null
    lastR2VerificationSeq: number | null
  }
  logger: {
    debug: MockFn
    info: MockFn
    warn: MockFn
    error: MockFn
  }
  saveCursors: MockFn
  deleteUsageRecordsBatch: MockFn
  deleteVerificationRecordsBatch: MockFn
}

function createProviderForTests(): TestProvider {
  const provider = Object.create(SqliteDOStorageProvider.prototype) as TestProvider

  provider.initialized = true
  provider.inFlightFlush = null
  provider.cursors = {
    lastTinybirdUsageSeq: null,
    lastR2UsageSeq: null,
    lastTinybirdVerificationSeq: null,
    lastR2VerificationSeq: null,
  }

  provider.logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  provider.getSeenMetaSet = vi.fn().mockResolvedValue(new Set())
  provider.getSeenSnapshotSet = vi.fn().mockResolvedValue(new Set())
  provider.fetchMetadataRowsByRefs = vi.fn().mockResolvedValue([])
  provider.buildLakehouseMetadataRecords = vi.fn().mockReturnValue([])
  provider.buildEntitlementSnapshots = vi
    .fn()
    .mockResolvedValue({ snapshots: [], emittedSnapshotIds: new Set() })
  provider.updateSeenMetaSet = vi.fn().mockResolvedValue(undefined)
  provider.updateSeenSnapshotSet = vi.fn().mockResolvedValue(undefined)
  provider.saveCursors = vi.fn().mockResolvedValue(undefined)
  provider.deleteUsageRecordsBatch = vi.fn().mockResolvedValue(0)
  provider.deleteVerificationRecordsBatch = vi.fn().mockResolvedValue(0)
  provider.pruneAggregateBuckets = vi.fn().mockResolvedValue(undefined)
  provider.fetchVerificationBatch = vi
    .fn()
    .mockResolvedValue({ records: [], firstSeq: null, lastSeq: null })
  provider.buildLakehouseVerificationRecords = vi.fn().mockReturnValue([])
  provider.ingestVerificationsToTinybird = vi.fn().mockResolvedValue({ success: true })

  return provider
}

describe("SqliteDOStorageProvider flush reliability", () => {
  it("persists Tinybird seq cursor progress when R2 fails", async () => {
    const provider = createProviderForTests()

    provider.fetchUsageBatch = vi.fn().mockResolvedValue({
      records: [
        { id: "usage-001", seq: 1, meta_id: "0" },
        { id: "usage-002", seq: 2, meta_id: "0" },
      ],
      firstSeq: 1,
      lastSeq: 2,
    })

    provider.buildLakehouseUsageRecords = vi.fn().mockReturnValue([{ id: "usage-001" }])
    provider.flushToR2 = vi.fn().mockResolvedValue({ success: false })
    provider.ingestUsageToTinybird = vi.fn().mockResolvedValue({ success: true })

    const result = await (provider as unknown as SqliteDOStorageProvider).flush()

    expect(result.err).toBeDefined()
    expect(result.err?.message).toContain("lakehouse_r2")
    expect(provider.cursors.lastTinybirdUsageSeq).toBe(2)
    expect(provider.cursors.lastR2UsageSeq).toBeNull()
    expect(provider.saveCursors).toHaveBeenCalledTimes(1)
    expect(provider.deleteUsageRecordsBatch).not.toHaveBeenCalled()
  })

  it("deletes acknowledged usage ranges by seq boundaries, independent from id ordering", async () => {
    const provider = createProviderForTests()

    provider.fetchUsageBatch = vi.fn().mockResolvedValue({
      records: [
        { id: "zzzz-last", seq: 10, meta_id: "0" },
        { id: "aaaa-next", seq: 11, meta_id: "0" },
      ],
      firstSeq: 10,
      lastSeq: 11,
    })

    provider.buildLakehouseUsageRecords = vi.fn().mockReturnValue([{ id: "usage-for-r2" }])
    provider.flushToR2 = vi.fn().mockResolvedValue({ success: true })
    provider.ingestUsageToTinybird = vi.fn().mockResolvedValue({ success: true })

    const result = await (provider as unknown as SqliteDOStorageProvider).flush()

    expect(result.err).toBeUndefined()
    expect(provider.cursors.lastTinybirdUsageSeq).toBe(11)
    expect(provider.cursors.lastR2UsageSeq).toBe(11)
    expect(provider.deleteUsageRecordsBatch).toHaveBeenCalledWith(10, 11)
  })
})

describe("SqliteDOStorageProvider metadata identity", () => {
  it("builds tenant-scoped metadata identities and dedupes by meta id", async () => {
    const provider = createProviderForTests()

    provider.getXxhash = vi.fn().mockResolvedValue({
      h64: (input: string) => `hash(${input})`,
    })

    const identityA = await (
      provider as {
        computeMetadataIdentity(params: {
          payload: string
          projectId: string
          customerId: string
        }): Promise<string>
      }
    ).computeMetadataIdentity({
      payload: '{"plan":"pro"}',
      projectId: "project-a",
      customerId: "customer-1",
    })

    const identityB = await (
      provider as {
        computeMetadataIdentity(params: {
          payload: string
          projectId: string
          customerId: string
        }): Promise<string>
      }
    ).computeMetadataIdentity({
      payload: '{"plan":"pro"}',
      projectId: "project-b",
      customerId: "customer-1",
    })

    const refs = (
      provider as {
        collectUnseenMetadataRefs(params: {
          usageRecords: Array<{ meta_id: string }>
          verificationRecords: Array<{ meta_id: string }>
          seenMetaSet: Set<string>
        }): string[]
      }
    ).collectUnseenMetadataRefs({
      usageRecords: [{ meta_id: identityA }],
      verificationRecords: [{ meta_id: identityA }, { meta_id: identityB }],
      seenMetaSet: new Set<string>([identityB]),
    })

    expect(identityA).not.toBe(identityB)
    expect(refs).toEqual([identityA])
  })
})
