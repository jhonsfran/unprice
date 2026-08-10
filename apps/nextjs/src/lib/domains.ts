import type { NextAuthRequest } from "@unprice/auth"
import { BASE_DOMAIN, RESTRICTED_SUBDOMAINS } from "@unprice/config"
import { ipAddress } from "@vercel/functions"
import type { NextRequest } from "next/server"
import { userAgent } from "next/server"
import { IP_BOTS, IP_RANGES_BOTS, UA_BOTS } from "./bots-list"
import { isIpInRange } from "./is-ip-in-range"

// validate the subdomain from the host and return it
// if the host is a custom domain, return the full domain
// if the subdomain is restricted or invalid, return null
// TODO: replace this with https://github.com/vercel/platforms/blob/main/middleware.ts#L4
export const getValidSubdomain = (host?: string | null) => {
  if (!host || host === "vercel.app" || host.endsWith(".vercel.app")) {
    return null
  }

  let subdomain: string | null = null

  if (host.includes(".")) {
    const candidate = host.split(".")[0]
    if (candidate && !RESTRICTED_SUBDOMAINS.has(candidate)) {
      // Valid candidate
      subdomain = candidate
    }
  }

  // In case the host is a custom domain
  if (host && !host?.includes(BASE_DOMAIN)) {
    subdomain = host
  }

  return subdomain
}

export const parse = (req: NextAuthRequest | NextRequest) => {
  let domain = req.headers.get("host")!
  domain = domain.replace("www.", "") // remove www. from domain

  // if (domain === "app.localhost:3000" || domain.endsWith(".vercel.app")) {
  //   // for local development and preview URLs
  //   domain = APP_BASE_DOMAIN
  // }

  const subdomain = domain.split(".")[0] === domain ? null : domain.split(".")[0]
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  const ip =
    req.headers.get("x-real-ip")?.trim() ||
    req.headers.get("cf-connecting-ip")?.trim() ||
    forwardedFor ||
    "127.0.0.1"
  const path = req.nextUrl.pathname

  // fullPath is the full URL path (along with search params)
  const searchParams = req.nextUrl.searchParams.toString()
  const fullPath = `${path}${searchParams.length > 0 ? `?${searchParams}` : ""}`

  // Here, we are using decodeURIComponent to handle foreign languages like Hebrew
  const key = decodeURIComponent(path.split("/")[1] ?? "") // key is the first part of the path
  const fullKey = decodeURIComponent(path.slice(1)) // fullKey is the full path without the first slash

  return { domain, path, fullPath, key, fullKey, subdomain, ip }
}

export const detectBot = (req: NextRequest) => {
  const url = req.nextUrl
  if (url.searchParams.get("bot")) return true

  // Check ua
  const ua = userAgent(req)

  if (ua.ua) {
    /* Note:
     * - bot is for most bots & crawlers
     * - facebookexternalhit is for Facebook crawler
     * - MetaInspector is for https://metatags.io/
     */
    return /bot|facebookexternalhit|google|baidu|bing|msn|duckduckbot|teoma|slurp|yandex|MetaInspector/i.test(
      ua.ua
    )
  }

  if (ua) {
    return ua.isBot || UA_BOTS.some((bot) => new RegExp(bot, "i").test(ua.ua))
  }

  // Check ip
  const ip = ipAddress(req)

  if (!ip) {
    return false
  }

  // Check exact IP matches
  if (IP_BOTS.includes(ip)) {
    return true
  }

  // Check CIDR ranges
  return IP_RANGES_BOTS.some((range) => isIpInRange(ip, range))
}

// courtesy of ChatGPT: https://sharegpt.com/c/pUYXtRs
export const validDomainRegex = new RegExp(
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/
)

export const getSubdomain = (name: string, apexName: string) => {
  if (name === apexName) return null
  return name.slice(0, name.length - apexName.length - 1)
}

export const getApexDomain = (url: string) => {
  let domain = ""
  try {
    domain = new URL(url).hostname
  } catch (_e) {
    return ""
  }
  const parts = domain.split(".")
  if (parts.length > 2) {
    // if it's a subdomain (e.g. dub.vercel.app), return the last 2 parts
    return parts.slice(-2).join(".")
  }
  // if it's a normal domain (e.g. dub.sh), we return the domain
  return domain
}

export const isValidUrl = (url: string) => {
  try {
    new URL(url)
    return true
  } catch (_e) {
    return false
  }
}

export const getDomainWithoutWWW = (url: string) => {
  if (isValidUrl(url)) {
    return new URL(url).hostname.replace(/^www\./, "")
  }
  try {
    if (url.includes(".") && !url.includes(" ")) {
      return new URL(`https://${url}`).hostname.replace(/^www\./, "")
    }
  } catch (_e) {
    return null
  }
}
