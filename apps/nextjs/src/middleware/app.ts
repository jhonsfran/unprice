import { RequestCookies, ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies"
import { NextResponse } from "next/server"

import type { NextAuthRequest } from "@unprice/auth"

import {
  APP_AUTH_ROUTES,
  APP_NON_WORKSPACE_ROUTES,
  AUTH_ROUTES,
  COOKIES_APP,
} from "@unprice/config"
import { isSlug } from "@unprice/db/utils"
import { parse } from "~/lib/domains"
import { getWorkspacesUser } from "~/lib/session"
import { getSafeNextPath } from "~/lib/signup-funnel"

/**
 * Copy cookies from the Set-Cookie header of the response to the Cookie header of the request,
 * so that it will appear to SSR/RSC as if the user already has the new cookies.
 */
function applySetCookie(req: NextAuthRequest, res: NextResponse) {
  // 1. Parse Set-Cookie header from the response
  const setCookies = new ResponseCookies(res.headers)

  // 2. Construct updated Cookie header for the request
  const newReqHeaders = new Headers(req.headers)
  const newReqCookies = new RequestCookies(newReqHeaders)
  setCookies.getAll().forEach((cookie) => newReqCookies.set(cookie))

  // 3. Set up the “request header overrides” (see https://github.com/vercel/next.js/pull/41380)
  //    on a dummy response
  // NextResponse.next will set x-middleware-override-headers / x-middleware-request-* headers
  const dummyRes = NextResponse.next({ request: { headers: newReqHeaders } })

  // 4. Copy the “request header overrides” headers from our dummy response to the real response
  dummyRes.headers.forEach((value, key) => {
    if (key === "x-middleware-override-headers" || key.startsWith("x-middleware-request-")) {
      res.headers.set(key, value)
    }
  })
}

export default function AppMiddleware(req: NextAuthRequest) {
  const url = new URL(req.nextUrl.origin)
  const { path, key: currentWorkspaceSlug, fullPath } = parse(req)
  const isLoggedIn = !!req.auth?.user
  const { user, userBelongsToWorkspace } = getWorkspacesUser(req.auth)
  const isAppAuthRoute = APP_AUTH_ROUTES.has(path)
  const isApiRoute = path.startsWith("/api")
  const isNonWorkspaceRoute = APP_NON_WORKSPACE_ROUTES.has(path)

  // use next param to redirect to the workspace
  const next = getSafeNextPath(req.nextUrl.searchParams.get("next"))

  // API routes we don't need to check if the user is logged in
  if (isApiRoute || isAppAuthRoute) {
    return NextResponse.next()
  }

  if (!isLoggedIn || !user) {
    // User is not signed in redirect to sign in
    return NextResponse.redirect(
      new URL(
        `${AUTH_ROUTES.SIGNIN}${fullPath === "/" ? "" : `?next=${encodeURIComponent(fullPath)}`}`,
        req.url
      )
    )
  }

  // if the route is not a workspace route
  if (isNonWorkspaceRoute) {
    return NextResponse.rewrite(new URL(`/dashboard${fullPath === "/" ? "" : fullPath}`, req.url))
  }

  // if the next param is set, redirect to the next url
  if (next) {
    return NextResponse.redirect(new URL(next, req.url))
  }

  // if not workspace in path check cookies or jwt
  if (!currentWorkspaceSlug) {
    // get default workspace from user
    const redirectWorkspaceSlug = user.workspaces[0]?.slug

    // there is a cookie/jwt claim for the workspace redirect
    if (redirectWorkspaceSlug && redirectWorkspaceSlug !== "") {
      url.pathname = `/${redirectWorkspaceSlug}`
      return NextResponse.redirect(url)
    }

    // if not workspace in path and no workspace in cookies or jwt, redirect to onboarding
    return NextResponse.redirect(new URL("/new", req.url))
  }

  // check jwt claim for the workspace
  const isUserMemberWorkspace = userBelongsToWorkspace(currentWorkspaceSlug)

  const response = NextResponse.rewrite(
    new URL(`/dashboard${fullPath === "/" ? "" : fullPath}`, req.url)
  )

  // if the user is not a member of the workspace redirect to root path to be handled by the middleware again
  if (!isUserMemberWorkspace) {
    url.pathname = "/"

    // clear the cookies
    response.cookies.set(COOKIES_APP.PROJECT, "")
    response.cookies.set(COOKIES_APP.WORKSPACE, "")

    // Apply those cookies to the request
    applySetCookie(req, response)

    return NextResponse.redirect(url)
  }

  // we use this cookies to forward them to the API on RSC calls
  // client calls are handled by the UpdateClientCookie component
  const cookieWorkspace = req.cookies.get(COOKIES_APP.WORKSPACE)?.value

  if (currentWorkspaceSlug !== cookieWorkspace && isSlug(currentWorkspaceSlug)) {
    // set cookies if the user has access to the workspace
    response.cookies.set(COOKIES_APP.WORKSPACE, currentWorkspaceSlug, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    })
  }

  const currentProjectSlug = decodeURIComponent(path.split("/")[2] ?? "")

  // check if the current project slug is a valid slug
  const cookieProject = req.cookies.get(COOKIES_APP.PROJECT)?.value

  if (currentProjectSlug !== cookieProject && isSlug(currentProjectSlug)) {
    // cookie for calling the api
    response.cookies.set(COOKIES_APP.PROJECT, currentProjectSlug, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    })
  }

  // Apply those cookies to the request
  applySetCookie(req, response)

  return response
}
