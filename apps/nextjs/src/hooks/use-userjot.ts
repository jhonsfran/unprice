import { useEffect, useState } from "react"

export interface UserJotUser {
  id: string
  email?: string
  firstName?: string
  lastName?: string
  avatar?: string
}

export function useUserJot() {
  const [isOpen, setIsOpen] = useState(false)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    const checkReady = () => {
      // @ts-ignore
      if (window.uj && typeof window.uj.getWidgetState === "function") {
        setIsReady(true)
        return true
      }
      return false
    }

    if (checkReady()) return

    const handleReady = () => setIsReady(true)
    window.addEventListener("uj:ready", handleReady)
    return () => window.removeEventListener("uj:ready", handleReady)
  }, [])

  const userJotOptions = {
    widget: true,
    theme: "auto",
    position: "right",
  }

  if (process.env.NODE_ENV === "development") {
    userJotOptions.position = "left"
  }

  // wait for the script to load and then initialize the userjot
  useEffect(() => {
    const interval = setInterval(() => {
      // @ts-ignore - window.uj is global from the script
      setIsOpen(window.uj?.getWidgetState()?.isOpen ?? false)
    }, 500)
    return () => clearInterval(interval)
  }, [])

  const show = (section?: "feedback" | "roadmap" | "updates") =>
    // biome-ignore lint/suspicious/noExplicitAny: window.uj is global from the script
    (window as any).uj?.showWidget({ section })

  const hide = () =>
    // biome-ignore lint/suspicious/noExplicitAny: window.uj is global from the script
    (window as any).uj?.hideWidget()

  const identify = (user: UserJotUser | null) =>
    // biome-ignore lint/suspicious/noExplicitAny: window.uj is global from the script
    (window as any).uj?.identify(user)

  const setTheme = (theme: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    if (typeof window !== "undefined" && (window as any).uj) {
      const valetTheme = theme === "system" ? "auto" : theme
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      ;(window as any).uj.setTheme(valetTheme)
    }
  }

  return { isOpen, isReady, show, hide, identify, setTheme }
}
