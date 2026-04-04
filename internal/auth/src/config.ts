import Credentials from "@auth/core/providers/credentials"
import GitHub from "@auth/core/providers/github"
import Google from "@auth/core/providers/google"
import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { createWorkspacesByUserQuery } from "@unprice/db/queries"
import * as schema from "@unprice/db/schema"
import type { NextAuthConfig } from "next-auth"
import { cookies } from "next/headers"
import { db } from "./db"
import { env } from "./env"
import { authLogger } from "./logger"
import { verifyPassword } from "./password"
import { createUser } from "./utils"

const useSecureCookies = env.APP_ENV === "production"

export const authConfig: NextAuthConfig = {
  trustHost: Boolean(env.APP_ENV) || env.NODE_ENV === "development",
  logger: authLogger,
  redirectProxyUrl: env.AUTH_REDIRECT_PROXY_URL,
  session: {
    strategy: "jwt",
    updateAge: 24 * 60 * 60, // 24 hours for update session
    maxAge: 2592000, // 30 days for expiration
  },
  useSecureCookies,
  pages: {
    signIn: "/auth/signin",
    signOut: "/auth/signout",
    error: "/auth/error",
    verifyRequest: "/auth/verify-request",
    newUser: "/auth/new-user",
  },
  events: {
    // signIn: async ({ user }) => {
    //   const cookieStore = cookies()
    //   const sessionId = cookieStore.get(COOKIES_APP.SESSION)?.value
    //   if (sessionId) {
    //     await analytics.ingestEvents({
    //       action: "sign_in",
    //       version: "1",
    //       session_id: sessionId,
    //       timestamp: new Date().toISOString(),
    //       payload: {
    //         user_id: user.id ?? "",
    //       },
    //     })
    //   }
    // },
    // createUser: async ({ user }) => {
    //   // send email to user
    // },
  },
  debug: process.env.NODE_ENV === "development",
  adapter: {
    // @ts-expect-error - Type mismatch between DrizzleAdapter and the database connection
    ...DrizzleAdapter(db.$primary, {
      usersTable: schema.users,
      accountsTable: schema.accounts,
      sessionsTable: schema.sessions,
      verificationTokensTable: schema.verificationTokens,
    }),

    // override the default create user
    async createUser(data) {
      const { val, err } = await createUser({
        email: data.email,
        name: data.name ?? "",
        emailVerified: data.emailVerified,
        image: data.image ?? undefined,
      })

      if (err) {
        authLogger.error(err)
        throw err
      }

      return val
    },
  },
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_CLIENT_ID,
      clientSecret: process.env.AUTH_GITHUB_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    Google({
      clientId: process.env.AUTH_GOOGLE_CLIENT_ID,
      clientSecret: process.env.AUTH_GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        if (!credentials?.email || !credentials.password) {
          throw new Error("Invalid credentials")
        }

        // check if the user exists
        const user = await db.query.users.findFirst({
          where: (users, { eq }) => eq(users.email, credentials.email as string),
        })

        if (!user || !user.password) {
          throw new Error("Invalid credentials")
        }

        const validPassword = await verifyPassword(credentials.password as string, user.password)

        if (!validPassword) {
          throw new Error("Invalid credentials")
        }

        return user
      },
    }),
  ],
  callbacks: {
    signIn: async ({ account }) => {
      if (account?.provider) {
        cookies().set("last-login-method", account.provider, {
          path: "/",
          maxAge: 31536000, // 1 year
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
        })
      }
      return true
    },
    // authorized({ auth }) {
    //   return !!auth?.user // this ensures there is a logged in user for -every- request
    // },
    session: async (opts) => {
      const { session, token } = opts

      if (token.sub && session.user) {
        session.user.id = token.sub

        // We fetch the workspaces directly from the database in the session callback
        // This keeps the session cookie tiny (only the user ID) while keeping the full session object consistent
        // Next.js memoizes auth() calls, so this only pings the database once per request
        const userWithWorkspaces = await createWorkspacesByUserQuery(db).execute({
          userId: token.sub,
        })

        session.user.workspaces =
          userWithWorkspaces?.members
            .filter((member) => member.workspace.enabled)
            .map((member) => ({
              id: member.workspace.id,
              slug: member.workspace.slug,
              role: member.role,
              isPersonal: member.workspace.isPersonal,
              enabled: member.workspace.enabled,
              unPriceCustomerId: member.workspace.unPriceCustomerId,
              isInternal: member.workspace.isInternal,
              isMain: member.workspace.isMain,
            })) ?? []

        session.user.onboardingCompleted = userWithWorkspaces?.onboardingCompleted ?? false
      }

      return session
    },
    jwt: async (opts) => {
      const token = opts.token
      const userId = token.sub

      if (userId) {
        token.id = userId
      }

      return token
    },
  },
} satisfies NextAuthConfig
