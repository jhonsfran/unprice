"use client"

import type { ButtonProps } from "@unprice/ui/button"
import { Button } from "@unprice/ui/button"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { cn } from "@unprice/ui/utils"
import { useFormStatus } from "react-dom"
import { ConfirmAction } from "./confirm-action"

interface SubmitButtonProps extends ButtonProps {
  isSubmitting?: boolean
  isDisabled?: boolean
  isLoading?: boolean
  label: string
  component?: "default" | "spinner"
  withConfirmation?: boolean
  confirmationMessage?: string
  onClick?: () => void
}

// Press feedback for the form's primary action: a 0.96 scale that returns on release.
const PRESS_CLASSES =
  "transition-[color,background-color,border-color,transform] duration-150 ease-out enabled:active:scale-[0.96]"

export const SubmitButton = ({
  variant = "primary",
  isSubmitting,
  isDisabled,
  label,
  onClick,
  className,
  isLoading,
  withConfirmation,
  confirmationMessage,
  ...props
}: SubmitButtonProps) => {
  const { pending } = useFormStatus()

  const isPending = pending || isSubmitting

  if (withConfirmation) {
    return (
      <ConfirmAction
        confirmAction={() => {
          onClick?.()
        }}
        message={confirmationMessage}
      >
        <Button
          variant={variant}
          type={onClick ? "button" : "submit"}
          disabled={isDisabled || pending}
          className={cn(PRESS_CLASSES, className)}
          {...props}
        >
          <span className="line-clamp-1">{label}</span>
          {(isPending || isLoading) && <LoadingAnimation className={cn("ml-2", className)} />}
        </Button>
      </ConfirmAction>
    )
  }

  return (
    <Button
      variant={variant}
      type={onClick ? "button" : "submit"}
      disabled={isDisabled || pending}
      className={cn(PRESS_CLASSES, className)}
      onClick={onClick}
      {...props}
    >
      <span className="line-clamp-1">{label}</span>
      {(isPending || isLoading) && <LoadingAnimation className={cn("ml-2", className)} />}
    </Button>
  )
}
