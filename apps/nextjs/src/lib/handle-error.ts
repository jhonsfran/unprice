import { isRedirectError } from "next/dist/client/components/redirect-error"
import { z } from "zod"
import { fromZodIssue } from "zod-validation-error"

export function getErrorMessage(err: unknown) {
  const unknownError = "The request could not be completed. Please try again."

  if (err instanceof z.ZodError) {
    const errors = err.issues.map((issue) => {
      return fromZodIssue(issue).toString()
    })
    return errors.join("\n")
  }
  if (err instanceof Error) {
    return err.message
  }
  if (isRedirectError(err)) {
    throw err
  }
  return unknownError
}
