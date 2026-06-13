"use server"

import { getSession } from "@unprice/auth/server-rsc"
import { revalidatePath, revalidateTag } from "next/cache"
import { redirect } from "next/navigation"

export async function revalidateAppPath(path: string, type: "layout" | "page") {
  const session = await getSession()
  if (!session?.user) redirect("/auth/signin")
  revalidatePath(path, type)
}

export async function revalidatePageDomain(domain: string) {
  const session = await getSession()
  if (!session?.user) redirect("/auth/signin")
  revalidateTag(`${domain}:page-data`)
  // Also revalidate the page path to clear Next.js route cache
  revalidatePath(`/sites/${domain}`, "page")
}
