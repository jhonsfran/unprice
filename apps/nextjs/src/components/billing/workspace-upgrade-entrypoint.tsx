"use client"

import { Button } from "@unprice/ui/button"
import { useRouter } from "next/navigation"
import type { ReactNode } from "react"
import {
  type WorkspaceUpgradeIntent,
  encodeWorkspaceUpgradeIntent,
} from "~/components/billing/workspace-upgrade-intent"

export function WorkspaceUpgradeEntrypoint(props: {
  intent: WorkspaceUpgradeIntent
  children?: ReactNode
}) {
  const router = useRouter()

  const handleClick = () => {
    const params = encodeWorkspaceUpgradeIntent(props.intent)
    router.push(`/${props.intent.workspaceSlug}/settings/billing/change-plan?${params.toString()}`)
  }

  return (
    <Button type="button" variant="primary" onClick={handleClick}>
      {props.children ?? "Change plan"}
    </Button>
  )
}
