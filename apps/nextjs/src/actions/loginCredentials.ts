"use server"

import { signIn } from "@unprice/auth/server"
import { APP_DOMAIN } from "@unprice/config"

// react-doctor-disable-next-line react-doctor/server-auth-actions
export async function loginWithCredentials({
  email,
  password,
  redirectTo,
}: { email: string; password: string; redirectTo?: string }) {
  try {
    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    })

    if (!res || res.error) {
      return {
        success: false,
        message: res.error?.message ?? "Invalid credentials",
      }
    }

    return {
      success: true,
      message: "Login successful",
      redirect: redirectTo ?? APP_DOMAIN,
    }
  } catch (error) {
    const err = error as Error & { cause: { err: Error } }

    return {
      success: false,
      message: err.cause.err.message ?? "Invalid credentials",
    }
  }
}
