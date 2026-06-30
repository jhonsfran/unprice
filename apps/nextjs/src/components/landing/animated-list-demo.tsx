"use client"

import { cn } from "@unprice/ui/utils"
import { Activity, Ban, Receipt, ShieldCheck } from "lucide-react"
import { AnimatedList } from "./animated-list"
import { Notification } from "./notification"

let notifications = [
  {
    name: "Usage metered",
    description: "events.report",
    time: "15m ago",
    icon: <Activity className="size-5" />,
    iconClassName: "bg-info text-info-foreground",
  },
  {
    name: "Entitlement allowed",
    description: "access.check",
    time: "10m ago",
    icon: <ShieldCheck className="size-5" />,
    iconClassName: "bg-success-solid text-white",
  },
  {
    name: "Over-budget call blocked",
    description: "budget.exceeded",
    time: "5m ago",
    icon: <Ban className="size-5" />,
    iconClassName: "bg-danger-solid text-white",
  },
  {
    name: "Invoice explained",
    description: "invoice.explain",
    time: "2m ago",
    icon: <Receipt className="size-5" />,
    iconClassName: "bg-primary text-primary-foreground",
  },
]

notifications = Array.from({ length: 10 }, () => notifications).flat()

export const AnimatedListDemo = ({ className }: { className?: string }) => {
  return (
    <div className={cn("relative flex h-[500px] w-full flex-col overflow-hidden p-2", className)}>
      <AnimatedList>
        {notifications.map((item, idx) => (
          <Notification key={`${idx}-${item.name}`} {...item} />
        ))}
      </AnimatedList>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-background" />
    </div>
  )
}
