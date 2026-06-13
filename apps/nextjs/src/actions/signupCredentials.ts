"use server"

import { createUser } from "@unprice/auth/utils"
import { AUTH_ROUTES } from "@unprice/config"

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
  try {
    const { err } = await createUser({
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
