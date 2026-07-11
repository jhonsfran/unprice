"use client"

import { useMutation } from "@tanstack/react-query"
import { toast } from "@unprice/ui/sonner"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTRPC } from "~/trpc/client"

const MAX_STORED_REPLAY_IDS = 500

export const MAX_REPLAY_IDS = 50

/**
 * Owns the replay-queue state for the events panel: the pending (in-flight) and queued (persisted)
 * id sets, their localStorage bookkeeping, the replay mutation, and the user-facing toasts.
 *
 * @param storageKey  Per-workspace/project localStorage key for the persisted queued ids.
 * @param onReplaySuccess  Invoked after a successful replay (e.g. to refetch the events query).
 */
export function useReplayQueue(storageKey: string, onReplaySuccess: () => Promise<unknown>) {
  const trpc = useTRPC()
  const [queuedReplayIds, setQueuedReplayIds] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingReplayIds, setPendingReplayIds] = useState<ReadonlySet<string>>(() => new Set())
  const blockedReplayIds = useMemo(
    () => new Set([...queuedReplayIds, ...pendingReplayIds]),
    [pendingReplayIds, queuedReplayIds]
  )

  useEffect(() => {
    setQueuedReplayIds(new Set(readStoredReplayIds(storageKey)))
  }, [storageKey])

  const replayMutation = useMutation(
    trpc.analytics.replayIngestionEvents.mutationOptions({
      onSuccess: async () => {
        await onReplaySuccess()
      },
    })
  )

  const handleReplay = useCallback(
    async (canonicalAuditIds: string | string[]) => {
      const ids = Array.isArray(canonicalAuditIds) ? canonicalAuditIds : [canonicalAuditIds]
      const dedupedIds = Array.from(new Set(ids)).filter((id) => !blockedReplayIds.has(id))

      if (dedupedIds.length === 0) {
        toast.info("Replay already queued")
        return
      }

      if (dedupedIds.length > MAX_REPLAY_IDS) {
        const message = `Select ${MAX_REPLAY_IDS} or fewer failed events to replay.`
        toast.error(message)
        throw new Error(message)
      }

      setPendingReplayIds((previousIds) => new Set([...previousIds, ...dedupedIds]))

      try {
        const result = await replayMutation.mutateAsync({ canonicalAuditIds: dedupedIds })
        setQueuedReplayIds((previousIds) =>
          persistReplayIds(storageKey, previousIds, dedupedIds)
        )
        toast.success(result.replayed === 1 ? "Replay queued" : `${result.replayed} replays queued`)
      } catch (error) {
        toast.error(getReplayErrorMessage(error))
        throw error
      } finally {
        setPendingReplayIds((previousIds) => removeReplayIds(previousIds, dedupedIds))
      }
    },
    [blockedReplayIds, replayMutation, storageKey]
  )

  return {
    queuedReplayIds,
    pendingReplayIds,
    blockedReplayIds,
    handleReplay,
    replayIsPending: replayMutation.isPending,
  }
}

function readStoredReplayIds(storageKey: string): string[] {
  try {
    const rawValue = window.localStorage.getItem(storageKey)
    if (!rawValue) {
      return []
    }

    const parsedValue: unknown = JSON.parse(rawValue)
    if (!Array.isArray(parsedValue)) {
      return []
    }

    return parsedValue.filter((value): value is string => typeof value === "string")
  } catch {
    return []
  }
}

function persistReplayIds(
  storageKey: string,
  previousIds: ReadonlySet<string>,
  addedIds: string[]
): ReadonlySet<string> {
  const nextIds = Array.from(new Set([...previousIds, ...addedIds])).slice(-MAX_STORED_REPLAY_IDS)

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(nextIds))
  } catch {
    // Storage may be unavailable in private mode; the in-memory block still applies.
  }

  return new Set(nextIds)
}

function removeReplayIds(
  previousIds: ReadonlySet<string>,
  removedIds: string[]
): ReadonlySet<string> {
  const nextIds = new Set(previousIds)
  for (const removedId of removedIds) {
    nextIds.delete(removedId)
  }

  return nextIds
}

function getReplayErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return "Failed to replay ingestion events"
}
