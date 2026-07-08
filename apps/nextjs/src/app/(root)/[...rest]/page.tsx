import { notFound } from "next/navigation"

// Route groups act as separate root layouts, so unmatched URLs would fall
// through to Next's default 404. This catch-all routes them to the (root)
// not-found page — the denial receipt.
export default function NotFoundCatchAll() {
  notFound()
}
