import { type ParserReturn, type RegionCloudflare, regionsCloudflare } from "./cf-regions"

export function parseCfRay(header: string): ParserReturn<RegionCloudflare> {
  const regex = /\b([A-Z]{3})\b/g
  const arr = header.match(regex)

  if (!arr || !Array.isArray(arr) || arr.length === 0) {
    return { status: "failed", error: "Couldn't parse the header." }
  }

  const region = regionsCloudflare[arr[0]]

  if (region) return { status: "success", data: region }

  return {
    status: "failed",
    error: `It seems like the data center '${arr[0]}' (iata) is not listed.`,
  }
}
