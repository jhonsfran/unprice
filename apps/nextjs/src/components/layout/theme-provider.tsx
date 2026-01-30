"use client"

import type { ToasterProps } from "@unprice/ui/sonner"
import Toaster from "@unprice/ui/sonner"
import { ThemeProvider as NextThemeProvider, useTheme } from "next-themes"

export const ThemeProvider = NextThemeProvider

export const ToasterProvider = () => {
  const { theme } = useTheme()

  return (
    <Toaster
      theme={theme as ToasterProps["theme"]}
      richColors
      closeButton
      position="bottom-left"
      className="pointer-events-auto"
    />
  )
}
