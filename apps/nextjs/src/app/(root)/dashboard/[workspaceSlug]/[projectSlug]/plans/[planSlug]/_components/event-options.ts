import { slugify } from "@unprice/db/utils"
import type { Event } from "@unprice/db/validators"

type ListedEvent = Pick<Event, "name" | "slug" | "availableProperties">

/** `eventSlugSchema` without zod: what the SDK accepts as an event slug. */
const EVENT_SLUG = /^[a-z0-9._-]{1,64}$/

/** Case-insensitive substring match over what the picker shows: name, slug, and properties. */
export function eventMatches(query: string, event: ListedEvent): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [event.name, event.slug, ...(event.availableProperties ?? [])].some((text) =>
    text.toLowerCase().includes(needle)
  )
}

/**
 * The event the picker offers to create from what was typed: its name as typed, its slug derived,
 * and the item's label. Nothing when nothing fits was typed, or when an event already carries that
 * name or slug, since picking it is the right move.
 */
export function eventCreateOption(
  query: string,
  events: readonly ListedEvent[]
): { name: string; slug: string; label: string } | null {
  const name = query.trim()
  if (!name || name.length > 64) return null
  const slug = slugify(name)
  if (!EVENT_SLUG.test(slug)) return null
  const lower = name.toLowerCase()
  if (events.some((event) => event.slug === slug || event.name.toLowerCase() === lower)) return null
  return { name, slug, label: `Create event “${name}” (slug ${slug})` }
}
