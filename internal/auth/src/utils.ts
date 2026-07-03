import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import * as utils from "@unprice/db/utils"
import type { User } from "@unprice/db/validators"
import { BaseError, Err, Ok, type Result, SchemaError } from "@unprice/error"
import { db } from "./db"
import { hashPassword } from "./password"

const CREDENTIALS_SIGNUP_ERROR = "Unable to create account with these credentials"

export class UnPriceAuthError extends BaseError {
  public readonly retry = false
  public readonly name = UnPriceAuthError.name

  constructor({ message }: { message: string }) {
    super({
      message: `${message}`,
    })
  }
}

type CreateProviderUserInput = {
  email: string
  name: string
  emailVerified: Date | null
  image?: string
}

type CreateCredentialsUserInput = CreateProviderUserInput & {
  password: string
  confirmPassword: string
}

async function acceptPendingInvite(user: User) {
  const inviteUser = await db.query.invites.findFirst({
    where: (invite, { eq, and, isNull }) =>
      and(eq(invite.email, user.email), isNull(invite.acceptedAt)),
  })

  if (!inviteUser) {
    return
  }

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

export async function createUserFromProvider({
  email,
  name,
  image,
  emailVerified,
}: CreateProviderUserInput): Promise<Result<User, UnPriceAuthError | SchemaError>> {
  try {
    const user = await db
      .insert(schema.users)
      .values({
        email,
        name,
        image,
        password: null,
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
          emailVerified,
        },
      })
      .returning()
      .then((user) => user[0] ?? null)

    if (!user) {
      return Err(new UnPriceAuthError({ message: `Error creating user for ${email}` }))
    }

    await acceptPendingInvite(user)

    return Ok(user)
  } catch (error) {
    const err = error as Error
    return Err(new UnPriceAuthError({ message: err.message ?? "Unknown error" }))
  }
}

export async function createCredentialsUser({
  email,
  password,
  confirmPassword,
  name,
  image,
  emailVerified,
}: CreateCredentialsUserInput): Promise<Result<User, UnPriceAuthError | SchemaError>> {
  if (password !== confirmPassword) {
    return Err(new SchemaError({ message: "Passwords do not match" }))
  }

  const hashedPassword = await hashPassword(password)

  try {
    const user = await db
      .insert(schema.users)
      .values({
        email,
        name,
        image,
        password: hashedPassword,
        id: utils.newId("user"),
        emailVerified,
      })
      .onConflictDoNothing({ target: schema.users.email })
      .returning()
      .then((user) => user[0] ?? null)

    if (!user) {
      return Err(new UnPriceAuthError({ message: CREDENTIALS_SIGNUP_ERROR }))
    }

    await acceptPendingInvite(user)

    return Ok(user)
  } catch {
    return Err(new UnPriceAuthError({ message: CREDENTIALS_SIGNUP_ERROR }))
  }
}
