import type { Database } from "@unprice/db"
import { eq } from "@unprice/db"
import { users } from "@unprice/db/schema"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"

type SetOnboardingCompletedDeps = {
  db: Database
  logger: Logger
}

type SetOnboardingCompletedInput = {
  userId: string
  onboardingCompleted: boolean
}

export async function setOnboardingCompleted(
  deps: SetOnboardingCompletedDeps,
  input: SetOnboardingCompletedInput
): Promise<Result<void, FetchError>> {
  const { userId, onboardingCompleted } = input

  const { err } = await wrapResult(
    deps.db
      .update(users)
      .set({
        onboardingCompleted,
        onboardingCompletedAt: new Date(),
      })
      .where(eq(users.id, userId)),
    (error) =>
      new FetchError({
        message: `error setting onboarding completed: ${error.message}`,
        retry: false,
      })
  )

  if (err) {
    deps.logger.error(err, {
      context: "error setting onboarding completed",
      userId,
    })
    return Err(err)
  }

  return Ok(undefined)
}
