import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@unprice/ui/alert-dialog"

// TODO: support close first modal when open second modal
export function ConfirmAction({
  confirmAction,
  children,
  message,
  title,
  onOpenChange,
}: {
  confirmAction: () => void
  children: React.ReactNode
  message?: React.ReactNode
  title?: string
  /** Fires when the dialog opens or closes, so a caller can read state as of the opening. */
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title ?? "Are you absolutely sure?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {message
              ? message
              : "This action cannot be undone. This will permanently delete your data."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="button-default">Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirmAction}>Continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
