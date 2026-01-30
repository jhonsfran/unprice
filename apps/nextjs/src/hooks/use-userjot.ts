"use client"

import { useCallback, useEffect, useState } from "react"

export interface UserJotUser {
  id: string
  email?: string
  firstName?: string
  lastName?: string
  avatar?: string
  signature?: string // Critical for the 401 error
}

declare global {
  interface Window {
    uj?: {
      init: (projectId: string) => void
      identify: (user: UserJotUser) => void
      showWidget: (options?: { section?: string }) => void
      hideWidget: () => void
      setTheme: (theme: string) => void
      getWidgetState: () => { isOpen: boolean }
    }
  }
}

export function useUserJot() {
  const [isOpen, setIsOpen] = useState(false)
  const [isReady, setIsReady] = useState(false)

  // Robust check for script readiness
  useEffect(() => {
    let intervalId: NodeJS.Timeout

    const check = () => {
      // Check if window.uj exists and has the critical identify method
      if (window.uj && typeof window.uj.identify === "function") {
        setIsReady(true)
        return true
      }
      return false
    }

    // Check immediately, then poll if not ready
    if (!check()) {
      intervalId = setInterval(() => {
        if (check()) clearInterval(intervalId)
      }, 100)
    }

    // Also listen for the official ready event
    const handleReady = () => {
      check()
      if (intervalId) clearInterval(intervalId)
    }

    window.addEventListener("uj:ready", handleReady)

    return () => {
      if (intervalId) clearInterval(intervalId)
      window.removeEventListener("uj:ready", handleReady)
    }
  }, [])

  // Poll for widget open/close state (optional, but good for UI sync)
  useEffect(() => {
    if (!isReady) return

    const interval = setInterval(() => {
      setIsOpen(window.uj?.getWidgetState()?.isOpen ?? false)
    }, 1000)

    return () => clearInterval(interval)
  }, [isReady])

  // Wrap methods in useCallback to prevent re-renders
  const show = useCallback(
    (section?: "feedback" | "roadmap" | "updates") => window.uj?.showWidget({ section }),
    []
  )

  const hide = useCallback(() => window.uj?.hideWidget(), [])

  const identify = useCallback((user: UserJotUser | null) => {
    if (user && window.uj) {
      // Debug log for production (remove once fixed)
      if (process.env.NODE_ENV === "production" && !user.signature) {
        console.error("UserJot Error: Missing signature for user", user.id)
      }
      window.uj.identify(user)
    }
  }, [])

  const setTheme = useCallback((theme: string) => {
    if (window.uj) {
      const val = theme === "system" ? "auto" : theme
      window.uj.setTheme(val)
    }
  }, [])

  return { isOpen, isReady, show, hide, identify, setTheme }
}
