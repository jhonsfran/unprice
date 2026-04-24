import { type Database, and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { Event } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"

export class EventService {
  private readonly db: Database
  private readonly logger: Logger

  constructor({
    db,
    logger,
  }: {
    db: Database
    logger: Logger
  }) {
    this.db = db
    this.logger = logger
  }

  public async createEvent({
    projectId,
    name,
    slug,
    availableProperties,
  }: {
    projectId: string
    name: Event["name"]
    slug: Event["slug"]
    availableProperties?: Event["availableProperties"]
  }): Promise<Result<Event, FetchError>> {
    const { val, err } = await wrapResult(
      this.db
        .insert(schema.events)
        .values({
          id: newId("event"),
          projectId,
          name,
          slug,
          availableProperties: availableProperties?.length ? availableProperties : null,
        })
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error creating event: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error creating event",
        projectId,
        slug,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "error creating event",
          retry: false,
        })
      )
    }

    return Ok(val as Event)
  }

  public async listEventsByProject({
    projectId,
  }: {
    projectId: string
  }): Promise<Result<Event[], FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.events.findMany({
        where: (event, { eq }) => eq(event.projectId, projectId),
        orderBy: (event, { asc, desc }) => [asc(event.name), desc(event.updatedAtM)],
      }),
      (error) =>
        new FetchError({
          message: `error listing events by project: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error listing events by project",
        projectId,
      })
      return Err(err)
    }

    return Ok(val as Event[])
  }

  public async updateEvent({
    projectId,
    id,
    name,
    availableProperties,
    hasAvailableProperties,
  }: {
    projectId: string
    id: string
    name?: Event["name"]
    availableProperties?: Event["availableProperties"]
    hasAvailableProperties: boolean
  }): Promise<Result<{ state: "not_found" } | { state: "ok"; event: Event }, FetchError>> {
    const { val: existingEvent, err: existingEventErr } = await wrapResult(
      this.db.query.events.findFirst({
        where: (event, { eq, and }) => and(eq(event.id, id), eq(event.projectId, projectId)),
      }),
      (error) =>
        new FetchError({
          message: `error getting event by id: ${error.message}`,
          retry: false,
        })
    )

    if (existingEventErr) {
      this.logger.error(existingEventErr, {
        context: "error getting event by id",
        projectId,
        eventId: id,
      })
      return Err(existingEventErr)
    }

    if (!existingEvent?.id) {
      return Ok({
        state: "not_found",
      })
    }

    const nextAvailableProperties = hasAvailableProperties
      ? Array.from(
          new Set([...(existingEvent.availableProperties ?? []), ...(availableProperties ?? [])])
        )
      : undefined

    const { val, err } = await wrapResult(
      this.db
        .update(schema.events)
        .set({
          ...(name && { name }),
          ...(hasAvailableProperties && {
            availableProperties: nextAvailableProperties?.length ? nextAvailableProperties : null,
          }),
          updatedAtM: Date.now(),
        })
        .where(and(eq(schema.events.id, id), eq(schema.events.projectId, projectId)))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error updating event: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error(err, {
        context: "error updating event",
        projectId,
        eventId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "error updating event",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      event: val as Event,
    })
  }
}
