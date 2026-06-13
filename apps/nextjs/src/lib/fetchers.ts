"use server"

import { getSession } from "@unprice/auth/server-rsc"
import type { PlanVersionApi } from "@unprice/db/validators"
import { unstable_cache } from "next/cache"
import { redirect } from "next/navigation"
import { cache } from "react"
import { db } from "./db"
import { unprice } from "./unprice"

async function fetchPageData(domain: string) {
  const page = await db.query.pages.findFirst({
    where: (page, { eq, or }) => or(eq(page.customDomain, domain), eq(page.subdomain, domain)),
    with: {
      project: true,
    },
  })

  if (!page?.id) return null

  return page
}

export const getPageData = cache(async (domain: string, skipCache = false) => {
  if (skipCache) {
    // Skip cache and fetch directly from DB (useful for preview mode)
    return fetchPageData(domain)
  }

  const getCachedPage = unstable_cache(async () => fetchPageData(domain), [domain], {
    tags: [`${domain}:page-data`],
  })

  return getCachedPage()
})

async function fetchPlansData(planVersionIds: string[]) {
  if (planVersionIds.length === 0) return []

  const plansUnpriceResponse = await unprice.plans.listVersions({
    planVersionIds,
  })

  if (plansUnpriceResponse.result) {
    // cast because of potential type mismatch in local dev vs dist
    const result = plansUnpriceResponse.result as unknown as {
      planVersions: PlanVersionApi[]
    }
    return result.planVersions
  }

  return []
}

export const getPlansData = cache(
  async (domain: string, planVersionIds: string[], skipCache = false) => {
    if (skipCache) {
      return fetchPlansData(planVersionIds)
    }

    const idsHash = planVersionIds.sort().join(",")
    const getCachedPlans = unstable_cache(
      async () => fetchPlansData(planVersionIds),
      [`${domain}:plans`, idsHash],
      {
        tags: [`${domain}:page-data`],
      }
    )

    return getCachedPlans()
  }
)

export async function getAllPublishedDomains() {
  const session = await getSession()
  if (!session?.user) redirect("/auth/signin")

  const publishedPages = await db.query.pages.findMany({
    where: (page, { eq }) => eq(page.published, true),
    columns: {
      subdomain: true,
      customDomain: true,
    },
  })

  const domains = new Set<string>()
  for (const page of publishedPages) {
    if (page.subdomain) domains.add(page.subdomain)
    if (page.customDomain) domains.add(page.customDomain)
  }

  return Array.from(domains)
}
