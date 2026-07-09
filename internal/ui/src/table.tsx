import * as React from "react"

import { type VariantProps, cva } from "class-variance-authority"
import { cn } from "./utils"

const tableVariants = cva(cn("w-full caption-bottom text-sm"), {
  variants: {
    variant: {
      classic:
        "[&_td]:border [&_td]:px-4 [&_td]:py-2 [&_td]:text-left [&_td]:[&[align=center]]:text-center [&_td]:[&[align=right]]:text-right [&_th]:border [&_th]:px-4 [&_th]:py-2 [&_th]:text-left [&_th]:font-bold [&_th]:[&[align=center]]:text-center [&_th]:[&[align=right]]:text-right [&_tr]:m-0 [&_tr]:border-t [&_tr]:p-0 even:[&_tr]:bg-background-bg",
      default: "",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

export interface TableProps
  extends React.HTMLAttributes<HTMLTableElement>,
    VariantProps<typeof tableVariants> {}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, variant, ...props }, ref) => (
    <div className="hide-scrollbar relative w-full overflow-auto">
      <table ref={ref} className={cn(tableVariants({ variant }), className)} {...props} />
    </div>
  )
)
Table.displayName = "Table"

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
))
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
))
TableBody.displayName = "TableBody"

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn("bg-primary font-medium text-primary-foreground", className)}
    {...props}
  />
))
TableFooter.displayName = "TableFooter"

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & { disabled?: boolean }
>(({ className, disabled, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "border-b bg-background transition-colors hover:bg-background-bgHover data-[state=selected]:bg-muted",
      disabled && "pointer-events-none text-muted-foreground opacity-80",
      className
    )}
    {...props}
  />
))
TableRow.displayName = "TableRow"

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      // the outer columns carry the table's gutter so content never sits
      // flush against the frame
      "h-12 px-2 text-left align-middle font-medium text-muted-foreground first:pl-4 last:pr-4 [&:has([role=checkbox])]:text-center [&>[role=checkbox]]:translate-y-[2px]",
      className
    )}
    {...props}
  />
))
TableHead.displayName = "TableHead"

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "h-12 p-2 align-middle first:pl-4 last:pr-4 [&:has([role=checkbox])]:text-center [&>[role=checkbox]]:translate-y-[2px]",
      className
    )}
    {...props}
  />
))
TableCell.displayName = "TableCell"

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-4 text-muted-foreground text-sm", className)} {...props} />
))
TableCaption.displayName = "TableCaption"

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow }
