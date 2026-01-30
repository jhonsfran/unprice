"use client"

import { useTheme } from "next-themes"
import { useEffect } from "react"
import { type UserJotUser, useUserJot } from "~/hooks/use-userjot"

export function UserJotWrapper({ user }: { user: UserJotUser | null }) {
  const { setTheme, identify, isReady } = useUserJot()
  const { theme } = useTheme()

  useEffect(() => {
    // Only identify if we are ready AND have a valid user object
    if (isReady && user) {
      identify(user)
    }
  }, [user, identify, isReady])

  useEffect(() => {
    if (isReady) {
      setTheme(theme ?? "light")
    }
  }, [theme, setTheme, isReady])

  return null
}
