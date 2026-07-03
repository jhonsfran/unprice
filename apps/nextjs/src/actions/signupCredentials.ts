"use server"

import { createCredentialsUser } from "@unprice/auth/utils"
import { AUTH_ROUTES } from "@unprice/config"
import { checkCredentialsActionRateLimit } from "./authRateLimit"

// react-doctor-disable-next-line react-doctor/server-auth-actions
export async function signUpWithCredentials({
  email,
  password,
  confirmPassword,
  name,
}: {
  email: string
  password: string
  confirmPassword: string
  name: string
}) {
  const rateLimit = await checkCredentialsActionRateLimit({
    action: "credentials-signup",
    email,
  })

  if (rateLimit.limited) {
    return {
      success: false,
      message: rateLimit.message,
    }
  }

  try {
    const { err } = await createCredentialsUser({
      email,
      password,
      confirmPassword,
      name,
      emailVerified: null,
    })

    if (err) {
      return {
        success: false,
        message: err.message,
      }
    }

    return {
      success: true,
      message: "User created successfully",
      redirect: AUTH_ROUTES.SIGNIN,
    }
  } catch (error) {
    console.error(error)
    return {
      success: false,
      message: `Error creating user: ${error instanceof Error ? error.message : "Unknown error"}`,
    }
  }
}
