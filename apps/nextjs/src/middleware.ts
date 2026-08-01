import { NextResponse } from "next/server"

import { auth } from "@unprice/auth/server"

import { APP_DOMAIN, isAppHostname } from "@unprice/config"
import { getValidSubdomain, parse } from "~/lib/domains"
import AppMiddleware from "~/middleware/app"
import SitesMiddleware from "~/middleware/sites"

export default auth((req) => {
  const { domain, fullPath, path } = parse(req)
  const subdomain = getValidSubdomain(domain) ?? ""

  // Bypass Vercel's required endpoint
  if (path.startsWith("/.well-known/vercel/flags")) {
    return NextResponse.next()
  }

  // // 1. we validate api routes
  // if (API_HOSTNAMES.has(domain)) {
  //   return ApiMiddleware(req)
  // }

  // 2. we validate app routes inside the dashboard (isAppHostname supports any app.localhost port in dev)
  if (isAppHostname(domain)) {
    return AppMiddleware(req)
  }

  // 3. validate subdomains www and empty (landing page)
  if (subdomain === "" || subdomain === "www") {
    // Auth creates host-only session cookies. Always begin auth on the app host so
    // the callback returns where the browser can send that session cookie.
    if (path === "/auth" || path.startsWith("/auth/")) {
      return NextResponse.redirect(new URL(fullPath, APP_DOMAIN))
    }

    // If the user is logged in, we redirect them to the app
    if (req.auth?.user && path === "/") {
      return NextResponse.redirect(new URL(APP_DOMAIN, req.url))
    }

    // protect the app routes from being accessed under the base domain or www subdomain
    if (path.startsWith("/dashboard")) {
      const url = new URL(req.nextUrl.origin)
      url.pathname = "/"
      return NextResponse.redirect(url)
    }

    // public routes under the base domain or www subdomain
    return NextResponse.next()
  }

  // rest of the routes are site routes
  return SitesMiddleware(req)
})

export const config = {
  matcher: [
    /*
     * Match all paths except for:
     * 1. /api/ routes
     * 2. /_next/ (Next.js internals)
     * 3. /_proxy/ (special page for OG tags proxying)
     * 4. /_static, /_vercel (framework internals)
     * 5. Static assets: any path ending with a file extension (served from public/)
     */
    "/((?!api/|_next/|_proxy/|manifesto|_static|_vercel|.*\\.[a-zA-Z0-9]+$).*)",
  ],
}
