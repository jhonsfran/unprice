// source https://github.com/ARCADEGC/shadcnAddons/tree/main
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority"
import React from "react"
import { cn } from "./utils"

export type VariantKeyTypography =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "p"
  | "blockquote"
  | "table"
  | "list"
  | "code"
  | "large"
  | "normal"
  | "anchor"

type AffectsKey = "lead" | "small" | "muted" | "removePaddingMargin" | "contrast" | undefined

const typographyVariants = cva("", {
  variants: {
    variant: {
      // headings carry the page's key message: ink (step 12), not the
      // low-contrast text step the body runs on
      h1: "text-4xl font-primary font-extrabold text-background-textContrast tracking-tight lg:text-5xl",
      h2: "pb-2 text-3xl font-primary font-semibold text-background-textContrast tracking-tight first:mt-0",
      h3: "text-2xl font-primary font-semibold text-background-textContrast tracking-tight",
      h4: "text-xl font-secondary font-semibold text-background-textContrast tracking-tight",
      h5: "font-secondary font-semibold text-base text-background-textContrast leading-none tracking-tight",
      h6: "font-secondary tracking-tight text-background-textContrast leading-none text-md",
      p: "font-secondary leading-5 text-muted-foreground text-sm [&:not(:first-child)]:mt-6",

      blockquote: "mt-6 border-l-2 pl-6 italic",
      table:
        "w-full [&_td]:border [&_td]:px-4 [&_td]:py-2 [&_td]:text-left [&_td]:[&[align=center]]:text-center [&_td]:[&[align=right]]:text-right [&_th]:border [&_th]:px-4 [&_th]:py-2 [&_th]:text-left [&_th]:font-bold [&_th]:[&[align=center]]:text-center [&_th]:[&[align=right]]:text-right [&_tr]:m-0 [&_tr]:border-t [&_tr]:p-0 even:[&_tr]:bg-muted",
      list: "my-6 ml-6 list-disc [&>li]:mt-2",
      code: "font-mono relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold",
      large: "text-lg font-semibold",
      normal: "text-base font-normal",
      anchor: "font-medium text-primary underline underline-offset-4",
    },
    affects: {
      lead: "text-xl text-muted-foreground",
      small: "text-xs leading-none",
      muted: "text-sm text-muted-foreground",
      contrast: "text-background-textContrast",
      removePaddingMargin: "[&:not(:first-child)]:mt-0",
    },
  },
})

const variantToTag: Record<VariantKeyTypography, string> = {
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  p: "p",

  blockquote: "blockquote",
  table: "table",
  list: "ul",
  code: "code",
  large: "div",
  anchor: "a",
  normal: "div",
}

interface TypographyProps extends React.HTMLAttributes<HTMLElement> {
  variant?: VariantKeyTypography
  affects?: AffectsKey
  children: React.ReactNode
  className?: string
  asChild?: boolean
  disableSelect?: boolean
}

const Typography = React.forwardRef<HTMLElement, TypographyProps>(
  (
    {
      variant = "p",
      affects = undefined,
      children,
      className,
      asChild = false,
      disableSelect = false,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : variantToTag[variant]

    return (
      <Comp
        className={cn(
          typographyVariants({ variant, affects, className }),
          disableSelect ? "select-none" : ""
        )}
        ref={ref}
        {...props}
      >
        {children}
      </Comp>
    )
  }
)

Typography.displayName = "Typography"

export { Typography }
