"use client"

import * as React from "react"

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer"
import { cn } from "./utils"

const DESKTOP_QUERY = "(min-width: 768px)"

type ResponsiveDialogPresentation = "dialog" | "drawer"

const ResponsiveDialogContext = React.createContext<ResponsiveDialogPresentation | null>(null)

function subscribeToDesktopQuery(onStoreChange: () => void) {
  const mediaQuery = window.matchMedia(DESKTOP_QUERY)
  mediaQuery.addEventListener("change", onStoreChange)

  return () => mediaQuery.removeEventListener("change", onStoreChange)
}

function getDesktopSnapshot() {
  return window.matchMedia(DESKTOP_QUERY).matches
}

function getDesktopServerSnapshot() {
  return true
}

function useResponsiveDialogPresentation(): ResponsiveDialogPresentation {
  const isDesktop = React.useSyncExternalStore(
    subscribeToDesktopQuery,
    getDesktopSnapshot,
    getDesktopServerSnapshot
  )

  return isDesktop ? "dialog" : "drawer"
}

function useResponsiveDialogContext(componentName: string) {
  const presentation = React.useContext(ResponsiveDialogContext)

  if (!presentation) {
    throw new Error(`${componentName} must be used inside ResponsiveDialog`)
  }

  return presentation
}

type ResponsiveDialogProps = Pick<
  React.ComponentProps<typeof Dialog>,
  "children" | "defaultOpen" | "modal" | "onOpenChange" | "open"
>

function ResponsiveDialog(props: ResponsiveDialogProps) {
  const presentation = useResponsiveDialogPresentation()

  return (
    <ResponsiveDialogContext.Provider value={presentation}>
      {presentation === "dialog" ? <Dialog {...props} /> : <Drawer direction="bottom" {...props} />}
    </ResponsiveDialogContext.Provider>
  )
}

type ResponsiveDialogTriggerProps = React.ComponentPropsWithoutRef<typeof DialogTrigger>

const ResponsiveDialogTrigger = React.forwardRef<
  React.ElementRef<typeof DialogTrigger>,
  ResponsiveDialogTriggerProps
>((props, ref) => {
  const presentation = useResponsiveDialogContext("ResponsiveDialogTrigger")

  return presentation === "dialog" ? (
    <DialogTrigger ref={ref} {...props} />
  ) : (
    <DrawerTrigger ref={ref} {...props} />
  )
})
ResponsiveDialogTrigger.displayName = "ResponsiveDialogTrigger"

type ResponsiveDialogCloseProps = React.ComponentPropsWithoutRef<typeof DialogClose>

const ResponsiveDialogClose = React.forwardRef<
  React.ElementRef<typeof DialogClose>,
  ResponsiveDialogCloseProps
>((props, ref) => {
  const presentation = useResponsiveDialogContext("ResponsiveDialogClose")

  return presentation === "dialog" ? (
    <DialogClose ref={ref} {...props} />
  ) : (
    <DrawerClose ref={ref} {...props} />
  )
})
ResponsiveDialogClose.displayName = "ResponsiveDialogClose"

type ResponsiveDialogContentProps = React.ComponentPropsWithoutRef<typeof DialogContent>

function ResponsiveDialogContent({ className, ...props }: ResponsiveDialogContentProps) {
  const presentation = useResponsiveDialogContext("ResponsiveDialogContent")

  if (presentation === "dialog") {
    return <DialogContent className={className} {...props} />
  }

  return (
    <DrawerContent
      className={cn(
        "hide-scrollbar !max-h-[calc(100dvh-0.5rem)] w-full gap-4 overflow-y-auto overscroll-contain px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] text-left",
        className
      )}
      {...props}
    />
  )
}

type ResponsiveDialogHeaderProps = React.ComponentPropsWithoutRef<typeof DialogHeader>

function ResponsiveDialogHeader({ className, ...props }: ResponsiveDialogHeaderProps) {
  const presentation = useResponsiveDialogContext("ResponsiveDialogHeader")

  return presentation === "dialog" ? (
    <DialogHeader className={className} {...props} />
  ) : (
    <DrawerHeader className={cn("p-0 text-left", className)} {...props} />
  )
}

type ResponsiveDialogFooterProps = React.ComponentPropsWithoutRef<typeof DialogFooter>

function ResponsiveDialogFooter({ className, ...props }: ResponsiveDialogFooterProps) {
  const presentation = useResponsiveDialogContext("ResponsiveDialogFooter")

  return presentation === "dialog" ? (
    <DialogFooter className={className} {...props} />
  ) : (
    <DrawerFooter className={cn("p-0 pt-2", className)} {...props} />
  )
}

type ResponsiveDialogTitleProps = React.ComponentPropsWithoutRef<typeof DialogTitle>

function ResponsiveDialogTitle({ className, ...props }: ResponsiveDialogTitleProps) {
  const presentation = useResponsiveDialogContext("ResponsiveDialogTitle")

  return presentation === "dialog" ? (
    <DialogTitle className={className} {...props} />
  ) : (
    <DrawerTitle className={cn("text-lg leading-none tracking-tight", className)} {...props} />
  )
}

type ResponsiveDialogDescriptionProps = React.ComponentPropsWithoutRef<typeof DialogDescription>

function ResponsiveDialogDescription({ className, ...props }: ResponsiveDialogDescriptionProps) {
  const presentation = useResponsiveDialogContext("ResponsiveDialogDescription")

  return presentation === "dialog" ? (
    <DialogDescription className={className} {...props} />
  ) : (
    <DrawerDescription className={className} {...props} />
  )
}

export {
  ResponsiveDialog,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
}
