import type { StorageAdapter, SyncStorageAdapter } from "@unprice/services/entitlements"

const METER_STATE_PREFIX = "meter-state:"
const METER_STATE_UPDATED_AT_PREFIX = "meter-state-updated-at:"

export type MeterStateDraft = {
  createdAt: number
  dirty: boolean
  exists: boolean
  meterKey: string
  updatedAt: number | null
  usage: number
}

export class InMemoryMeterStorageAdapter implements StorageAdapter, SyncStorageAdapter {
  constructor(private readonly state: MeterStateDraft) {}

  async get<T>(key: string): Promise<T | null> {
    return this.getSync<T>(key)
  }

  getSync<T>(key: string): T | null {
    if (!this.state.exists) {
      return null
    }

    if (key.startsWith(METER_STATE_UPDATED_AT_PREFIX)) {
      return (this.state.updatedAt as T | null | undefined) ?? null
    }

    if (key.startsWith(METER_STATE_PREFIX)) {
      return this.state.usage as T
    }

    throw new Error(`InMemoryMeterStorageAdapter: unsupported key "${key}"`)
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.putSync(key, value)
  }

  putSync<T>(key: string, value: T): void {
    const numeric = Number(value)
    if (key.startsWith(METER_STATE_UPDATED_AT_PREFIX)) {
      this.state.updatedAt = numeric
      this.state.exists = true
      this.state.dirty = true
      return
    }

    if (key.startsWith(METER_STATE_PREFIX)) {
      this.state.usage = numeric
      this.state.exists = true
      this.state.dirty = true
      return
    }

    throw new Error(`InMemoryMeterStorageAdapter: unsupported key "${key}"`)
  }

  async list<T>(prefix: string): Promise<T[]> {
    return this.listSync(prefix)
  }

  listSync<T>(prefix: string): T[] {
    const value = this.getSync<T>(prefix)
    return value === null ? [] : [value]
  }
}
