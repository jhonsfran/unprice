import { GET as authGET, POST as authPOST } from "@unprice/auth/server"
import { withEvlog } from "~/lib/observability"

export const GET = withEvlog(authGET)
export const POST = withEvlog(authPOST)

export const runtime = "edge"
export const preferredRegion = ["fra1"]
export const maxDuration = 10
