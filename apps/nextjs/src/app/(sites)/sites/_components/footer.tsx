import { cn } from "@unprice/ui/utils"

export default function FooterSites(props: { className?: string; domain: string }) {
  return (
    <footer
      className={cn(
        "z-30 mx-auto flex h-16 w-full items-center justify-between gap-4 border-t bg-background-bgSubtle px-6 md:flex-row md:py-0",
        props.className
      )}
    >
      <div className="flex items-center gap-4 md:flex-row md:gap-2 md:px-0">
        <p className="text-sm leading-5">
          &copy; {new Date().getFullYear()} {props.domain}
        </p>
      </div>
    </footer>
  )
}
