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

  // if the user is not a member of the workspace redirect to root path to be handled by the middleware again
  if (!isUserMemberWorkspace) {
    url.pathname = "/"
    const response = NextResponse.redirect(url)

    // clear the cookies
    response.cookies.set(COOKIES_APP.PROJECT, "")
    response.cookies.set(COOKIES_APP.WORKSPACE, "")

    return response
  }

  const cookieWorkspace = req.cookies.get(COOKIES_APP.WORKSPACE)?.value
  const shouldSetWorkspaceCookie =
    currentWorkspaceSlug !== cookieWorkspace && isSlug(currentWorkspaceSlug)

  if (shouldSetWorkspaceCookie) {
    req.cookies.set(COOKIES_APP.WORKSPACE, currentWorkspaceSlug)
  }

  const currentProjectSlug = decodeURIComponent(path.split("/")[2] ?? "")
  const cookieProject = req.cookies.get(COOKIES_APP.PROJECT)?.value
  const shouldSetProjectCookie = currentProjectSlug !== cookieProject && isSlug(currentProjectSlug)

  if (shouldSetProjectCookie) {
    req.cookies.set(COOKIES_APP.PROJECT, currentProjectSlug)
  }

  const response = NextResponse.rewrite(
    new URL(`/dashboard${fullPath === "/" ? "" : fullPath}`, req.url),
    { request: { headers: req.headers } }
  )

  if (shouldSetWorkspaceCookie) {
    response.cookies.set(COOKIES_APP.WORKSPACE, currentWorkspaceSlug, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    })
  }

  if (shouldSetProjectCookie) {
    response.cookies.set(COOKIES_APP.PROJECT, currentProjectSlug, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    })
  }

  return response
}
