import { COOKIES_APP } from "@unprice/config"
import { newId } from "@unprice/db/utils"
import Cookies from "js-cookie"

const cookieOptions = {
  path: "/",
  sameSite: "lax",
  expires: 1,
  secure: process.env.NODE_ENV === "production",
} satisfies Cookies.CookieAttributes

export function getOrCreateConversionId(sessionId?: string): string {
  if (sessionId) return sessionId

  return Cookies.get(COOKIES_APP.SESSION) ?? newId("session")
}

export function persistConversionId(id: string): void {
  Cookies.set(COOKIES_APP.SESSION, id, cookieOptions)
}
