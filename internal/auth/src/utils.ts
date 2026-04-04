import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import * as utils from "@unprice/db/utils"
import type { User } from "@unprice/db/validators"
import { BaseError, Err, Ok, type Result, SchemaError } from "@unprice/error"
import { db } from "./db"
import { hashPassword } from "./password"

export class UnPriceAuthError extends BaseError {
  public readonly retry = false
  public readonly name = UnPriceAuthError.name

  constructor({ message }: { message: string }) {
    super({
      message: `${message}`,
    })
  }
}

export async function createUser({
  email,
  password,
  confirmPassword,
  name,
  image,
  emailVerified,
}: {
  email: string
  password?: string
  confirmPassword?: string
  name: string
  emailVerified: Date | null
  image?: string
}): Promise<Result<User, UnPriceAuthError | SchemaError>> {
  if (password !== confirmPassword) {
    return Err(new SchemaError({ message: "Passwords do not match" }))
  }

  const hashedPassword = password ? await hashPassword(password) : null

  try {
    const user = await db
      .insert(schema.users)
      .values({
        email,
        name,
        image,
        password: hashedPassword,
        // use our own id generator
        id: utils.newId("user"),
        // only true if we use auth providers like github, google, etc
        emailVerified,
      })
      .onConflictDoUpdate({
        target: [schema.users.email],
        set: {
          name,
          image,
          password: hashedPassword,
          emailVerified,
        },
      })
      .returning()
      .then((user) => user[0] ?? null)

    if (!user) {
      return Err(new UnPriceAuthError({ message: `Error creating user for ${email}` }))
    }

    // check if the user has an invite
    const inviteUser = await db.query.invites.findFirst({
      where: (invite, { eq, and, isNull }) =>
        and(eq(invite.email, user.email), isNull(invite.acceptedAt)),
    })

    if (inviteUser) {
      // add the user as a member of the workspace
      await db
        .insert(schema.members)
        .values({
          userId: user.id,
          workspaceId: inviteUser.workspaceId,
          role: inviteUser.role,
        })
        .onConflictDoNothing()

      // update the invite as accepted
      await db
        .update(schema.invites)
        .set({
          acceptedAt: Date.now(),
        })
        .where(
          and(
            eq(schema.invites.email, inviteUser.email),
            eq(schema.invites.workspaceId, inviteUser.workspaceId)
          )
        )
    }

    return Ok(user)
  } catch (error) {
    const err = error as Error
    return Err(new UnPriceAuthError({ message: err.message ?? "Unknown error" }))
  }
}
