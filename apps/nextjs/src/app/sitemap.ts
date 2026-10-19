import { BASE_URL } from "@unprice/config"
import type { MetadataRoute } from "next"

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["/", "/budgets", "/pricing", "/manifesto"].map((route) => ({
    url: `${BASE_URL}${route}`,
    lastModified: new Date().toISOString(),
    changeFrequency: "monthly" as const,
    priority: 1.0,
  }))

  return [...routes]
}
