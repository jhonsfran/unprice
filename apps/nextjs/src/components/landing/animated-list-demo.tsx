"use client"

import { cn } from "@unprice/ui/utils"
import { AnimatedList } from "./animated-list"
import { Notification } from "./notification"

let notifications = [
  {
    name: "Payment received",
    description: "Unrpice",
    time: "15m ago",

    icon: "💸",
    color: "#00C9A7",
  },
  {
    name: "User signed up",
    description: "Unrpice",
    time: "10m ago",
    icon: "👤",
    color: "#FFB800",
  },
  {
    name: "Verification",
    description: "Unrpice",
    time: "5m ago",
    icon: "💬",
    color: "#FF3D71",
  },
  {
    name: "Usage report",
    description: "Unrpice",
    time: "2m ago",
    icon: "🗞️",
    color: "#1E86FF",
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
