"use client"

import { useTheme } from "next-themes"
import { useEffect } from "react"
import { type UserJotUser, useUserJot } from "~/hooks/use-userjot"

export function UserJotWrapper({ user }: { user: UserJotUser | null }) {
  const { setTheme, identify, isReady } = useUserJot()

  const { theme } = useTheme()

  useEffect(() => {
    if (isReady && user) {
      identify({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
      })
    }
  }, [user, identify, isReady])

  useEffect(() => {
    if (isReady) {
      setTheme(theme ?? "light")
    }
  }, [theme, setTheme, isReady])

  return null
}
