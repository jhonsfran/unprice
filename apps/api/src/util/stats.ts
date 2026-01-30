import { EU_COUNTRY_CODES, type Stats } from "@unprice/analytics/utils"
import type { Context } from "hono"
import { UAParser } from "ua-parser-js"
import { isBot } from "ua-parser-js/helpers"

function capitalize(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1)
}

export const getStats = (c: Context): Stats => {
  const continent = c.req.raw?.cf?.continent as string
  const country = c.req.raw?.cf?.country as string
  const city = c.req.raw?.cf?.city as string
  const region = c.req.raw?.cf?.region as string
  const colo = c.req.raw?.cf?.colo as string
  const latitude = c.req.raw?.cf?.latitude as string
  const longitude = c.req.raw?.cf?.longitude as string

  const isEuCountry = (country && EU_COUNTRY_CODES.includes(country)) || false

  const ip =
    c.req.header("X-Forwarded-For") ??
    c.req.header("True-Client-IP") ??
    c.req.header("CF-Connecting-IP")
  const userAgent = c.req.header("User-Agent") || undefined
  const ua = new UAParser(userAgent).getResult()
  const unpriceRequestSource = c.req.header("Unprice-Request-Source") || "Unknown"

  return {
    ip:
      // only record IP if it's a valid IP and not from a EU country
      typeof ip === "string" && ip.trim().length > 0 && !isEuCountry ? ip : "Unknown",
    continent: continent || "Unknown",
    country: country || "Unknown",
    region: region || "Unknown",
    colo: colo || "UNK",
    city: city || "Unknown",
    latitude: latitude || "Unknown",
    longitude: longitude || "Unknown",
    device: capitalize(ua.device.type || "desktop"),
    device_vendor: ua.device.vendor || "Unknown",
    device_model: ua.device.model || "Unknown",
    browser: ua.browser.name || "Unknown",
    browser_version: ua.browser.version || "Unknown",
    engine: ua.engine.name || "Unknown",
    engine_version: ua.engine.version || "Unknown",
    os: ua.os.name || "Unknown",
    os_version: ua.os.version || "Unknown",
    cpu_architecture: ua.cpu?.architecture || "Unknown",
    ua: userAgent || "Unknown",
    bot: userAgent ? isBot(userAgent) : false,
    isEUCountry: isEuCountry,
    source: unpriceRequestSource || "Unknown",
  }
}
