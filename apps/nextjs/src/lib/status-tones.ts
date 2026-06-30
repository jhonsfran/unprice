export type StatusTone = "default" | "danger" | "info" | "success" | "warning"

export const statusToneClasses: Record<
  StatusTone,
  {
    badgeVariant: "default" | "destructive" | "info" | "success" | "warning"
    dot: string
    text: string
  }
> = {
  default: {
    badgeVariant: "default",
    dot: "bg-gray-solid",
    text: "text-muted-foreground",
  },
  danger: {
    badgeVariant: "destructive",
    dot: "bg-danger-solid",
    text: "text-danger",
  },
  info: {
    badgeVariant: "info",
    dot: "bg-info-solid",
    text: "text-info",
  },
  success: {
    badgeVariant: "success",
    dot: "bg-success-solid",
    text: "text-success",
  },
  warning: {
    badgeVariant: "warning",
    dot: "bg-warning-solid",
    text: "text-warning",
  },
}

const statusTones: Record<string, StatusTone> = {
  active: "info",
  archived: "default",
  deactivated: "danger",
  draft: "default",
  failed: "danger",
  inactive: "danger",
  latest: "info",
  paid: "success",
  pending: "warning",
  published: "success",
  unpaid: "danger",
  void: "success",
}

export function getStatusTone(status: string | null | undefined): StatusTone {
  if (!status) {
    return "default"
  }

  return statusTones[status.toLowerCase()] ?? "default"
}
