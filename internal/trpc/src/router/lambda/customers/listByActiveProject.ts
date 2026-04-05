import { customerSelectSchema, searchParamsSchemaDataTable } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const listByActiveProject = protectedProjectProcedure
  .input(searchParamsSchemaDataTable)
  .output(
    z.object({
      customers: z.array(customerSelectSchema),
      pageCount: z.number(),
    })
  )
  .query(async (opts) => {
    const { page, page_size, search, from, to } = opts.input
    const { project } = opts.ctx
    const { customers } = opts.ctx.services

    try {
      const { err, val } = await customers.listCustomersByProject({
        projectId: project.id,
        page,
        pageSize: page_size,
        search: search ?? undefined,
        from: from ?? undefined,
        to: to ?? undefined,
      })

      if (err) {
        return { customers: [], pageCount: 0 }
      }

      return val
    } catch (err: unknown) {
      console.error(err)
      return { customers: [], pageCount: 0 }
    }
  })
