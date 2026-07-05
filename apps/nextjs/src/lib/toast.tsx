import type { ExternalToast } from "@unprice/ui/sonner"
import { toast } from "@unprice/ui/sonner"

type ToastType = "default" | "description" | "success" | "warning" | "info" | "error" | "promise"

const config = {
  error: {
    type: "error",
    title: "Action could not be completed",
  },
  "error-contact": {
    type: "error",
    title: "Action could not be completed",
    description: "Try again or contact support if it keeps failing.",
    action: {
      label: "Open Discord",
      onClick: () => window.open("/discord", "_blank")?.location,
    },
  },
  "unique-slug": {
    type: "warning",
    title: "Slug is already taken",
    description: "Please select another slug. Every slug is unique.",
  },
  success: { type: "success", title: "Change saved" },
  deleted: { type: "success", title: "Record deleted" },
  removed: { type: "success", title: "Record removed" },
  saved: { type: "success", title: "Record saved" },
  updated: { type: "success", title: "Record updated" },
  "test-error": {
    type: "error",
    title: "Connection Failed",
    description: "Please enter a correct URL",
  },
  "test-warning-empty-url": {
    type: "warning",
    title: "URL is Empty",
    description: "Please enter a valid, non-empty URL",
  },
  "test-success": {
    type: "success",
    title: "Connection Established",
  },
} as const

type ToastConfig = Pick<ExternalToast, "action" | "description"> & {
  type: ToastType
  title: string
}

const _config: Record<string, ToastConfig> = config

type ToastAction = keyof typeof config

/**
 * Truncates a message to a maximum of 3 lines for display
 */
function truncateMessage(message: string, maxLines = 3): string {
  const lines = message.split("\n")
  if (lines.length <= maxLines) {
    return message
  }
  return `${lines.slice(0, maxLines).join("\n")}...`
}

export function toastAction(
  action: ToastAction,
  message?: string,
  options?: { requestId?: string }
) {
  const { title, type, ...rest } = _config[action]!
  const props = { ...rest, description: truncateMessage(message ?? "", 3) }

  if (options?.requestId) {
    props.action = {
      label: "Copy request ID",
      onClick: async (event) => {
        event?.preventDefault?.() // keeps toast open if supported
        await navigator.clipboard.writeText(`Request ID: ${options.requestId}\n\n${message ?? ""}`)
        toast.success("Request ID copied")
      },
    }
  }

  if (type === "default") return toast(title, props)
  if (type === "success") return toast.success(title, props)
  if (type === "error") return toast.error(title, props)
  if (type === "warning") return toast.warning(title, props)
  if (type === "description") return toast.message(title, props)
  if (type === "info") return toast.info(title, props)
}

export { toast }
