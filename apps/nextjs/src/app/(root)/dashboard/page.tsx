import { notFound } from "next/navigation"

// `/dashboard` is an internal rewrite target; workspace routes are the real
// dashboard entry points. Keep the terminal route explicit so parallel slots
// do not fall through to the root catch-all during the production build.
export default function DashboardRootPage() {
  notFound()
}
