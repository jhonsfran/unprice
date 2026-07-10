export { cn } from "cnfast"

export const focusRing = [
  // base
  "ring-offset-background focus-visible:outline-1 focus-visible:ring-none focus-visible:ring-ring focus-visible:ring-offset-1 focus:outline-ring focus:outline-1",
]

export const focusInput = [
  // base
  "focus:ring-1",
  // ring color
  "focus:outline-background-solid",
  // border color
  "focus:outline-background-solid",
]

export const hasErrorInput = [
  // base
  "ring-2",
  // border color
  "border-red-500 dark:border-red-700",
  // ring color
  "ring-red-200 dark:ring-red-700/30",
]
