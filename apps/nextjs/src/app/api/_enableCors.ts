import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, getAllowedCorsOrigin } from "@unprice/config"

function appendVaryOrigin(res: Response) {
  const vary = res.headers.get("Vary")
  if (!vary) {
    res.headers.set("Vary", "Origin")
    return
  }

  const values = vary.split(",").map((value) => value.trim().toLowerCase())
  if (!values.includes("origin")) {
    res.headers.set("Vary", `${vary}, Origin`)
  }
}

export function setCorsHeaders(res: Response, origin: string | null) {
  const allowedOrigin = getAllowedCorsOrigin(origin)

  if (allowedOrigin) {
    res.headers.set("Access-Control-Allow-Origin", allowedOrigin)
  }

  appendVaryOrigin(res)
  res.headers.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS.join(", "))
  res.headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS.join(", "))
}

export function CorsOptions(req: Request) {
  const response = new Response(null, {
    status: 204,
  })
  setCorsHeaders(response, req.headers.get("origin"))
  return response
}
