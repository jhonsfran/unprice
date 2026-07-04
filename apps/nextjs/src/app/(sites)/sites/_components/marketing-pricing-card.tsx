"use client"

import { Check, HelpCircle } from "lucide-react"
import type * as React from "react"

import { Button } from "@unprice/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@unprice/ui/card"
import { Separator } from "@unprice/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import Cookies from "js-cookie"

export interface MarketingPricingPlan {
  name: string
  id: string
  flatPrice: string
  isEnterprisePlan: boolean
  contactEmail: string
  description: string
  features: string[]
  detailedFeatures: Record<
    string,
    {
      value: string | number | boolean
      title: string
      type: "flat" | "usage" | "tier" | "package"
      description?: string
      config?: Record<string, unknown>
    }
  >[]
  cta: string
  ctaLink: string
  currency: string
  billingPeriod: string
  version: string
}

export interface MarketingPricingCardProps extends React.HTMLAttributes<HTMLDivElement> {
  plan: MarketingPricingPlan
  isPopular: boolean
  isOnly: boolean
}

export function MarketingPricingCard({
  plan,
  isPopular,
  className,
  isOnly,
  ...props
}: MarketingPricingCardProps) {
  const currentPrice = plan.flatPrice

  return (
    <Card
      className={cn("flex flex-col", isPopular && "relative border-primary shadow-lg", className)}
      style={
        isPopular
          ? {
              boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
            }
          : {}
      }
      {...props}
    >
      {isPopular && (
        <div className="-top-4 absolute right-0 left-0 flex justify-center">
          <span className="rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground text-sm">
            Recommended
          </span>
        </div>
      )}
      <CardHeader className="space-y-2">
        <CardTitle>{plan.name}</CardTitle>
        <CardDescription className="mt-2 line-clamp-2">{plan.description}</CardDescription>
        <div className="mt-10">
          {plan.isEnterprisePlan ? (
            <div className="invisible flex items-baseline">
              <span className="font-bold text-3xl">{currentPrice}</span>
              <span className="ml-1 text-muted-foreground">/{plan.billingPeriod}</span>
            </div>
          ) : (
            <div className="flex items-baseline">
              <span className="font-bold text-3xl">{currentPrice}</span>
              <span className="ml-1 text-muted-foreground">/{plan.billingPeriod}</span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-grow">
        <ul className="space-y-2">
          {plan.detailedFeatures.map((detailedFeatureObj) => {
            const featureTitle = Object.keys(detailedFeatureObj)[0]
            const feature = detailedFeatureObj[featureTitle!]

            if (!feature) return null

            const config = feature.config as {
              tiers?: {
                firstUnit: number
                lastUnit: number | null
                unitPrice: { displayAmount: string }
                flatPrice: { displayAmount: string }
              }[]
              usageMode?: string
              price?: { displayAmount: string }
            } | null

            return (
              <li key={featureTitle} className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center">
                  <Check className="mr-2 h-4 w-4 flex-shrink-0 text-primary" />
                  <span className="truncate">{feature.value}</span>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="focus:outline-none">
                      <HelpCircle className="size-3.5 flex-shrink-0 cursor-help text-muted-foreground transition-colors hover:text-primary" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent align="end" side="right" className="max-w-[280px]">
                    <div className="space-y-2 p-1">
                      <Typography variant="h6" className="font-semibold text-sm">
                        {feature.title}
                      </Typography>
                      {feature.description && (
                        <Typography variant="p" className="text-muted-foreground text-xs">
                          {feature.description}
                        </Typography>
                      )}

                      <Separator className="my-2" />

                      <div className="space-y-1.5">
                        <div className="flex justify-between text-[10px] text-muted-foreground uppercase tracking-wider">
                          <span>Billing Detail</span>
                          <span className="font-medium">{feature.type}</span>
                        </div>

                        {config?.tiers && config.tiers.length > 0 && (
                          <div className="mt-2 overflow-hidden rounded border text-[10px]">
                            <table className="w-full border-collapse">
                              <thead className="bg-muted">
                                <tr>
                                  <th className="px-2 py-1 text-left">Units</th>
                                  <th className="px-2 py-1 text-right">Price</th>
                                </tr>
                              </thead>
                              <tbody>
                                {config.tiers.map((tier) => (
                                  <tr key={tier.firstUnit} className="border-t">
                                    <td className="px-2 py-1">
                                      {tier.firstUnit} - {tier.lastUnit ?? "∞"}
                                    </td>
                                    <td className="px-2 py-1 text-right">
                                      {tier.unitPrice.displayAmount}/unit
                                      {Number.parseFloat(tier.flatPrice.displayAmount) > 0 && (
                                        <div className="text-[8px] text-muted-foreground">
                                          +{tier.flatPrice.displayAmount} flat
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {feature.type === "usage" &&
                          config?.usageMode === "unit" &&
                          config?.price && (
                            <div className="flex justify-between text-[10px]">
                              <span>Price per unit</span>
                              <span className="font-medium">{config.price.displayAmount}</span>
                            </div>
                          )}
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </li>
            )
          })}
        </ul>
      </CardContent>
      <CardFooter className="flex flex-col gap-4">
        <div className="w-full space-y-2">
          <Typography
            variant="p"
            affects="removePaddingMargin"
            className="text-start text-xs italic"
          >
            {"* plus usage if applicable"} <br />
            {"* plus payment processing fees"}
          </Typography>
          <Separator />
        </div>
        <Button
          className={cn("w-full", {
            "bg-primary text-primary-foreground": isPopular || isOnly,
          })}
          variant={isPopular || isOnly ? "primary" : "default"}
          onClick={() => {
            const ctaLink = new URL(plan.ctaLink)
            const sessionId = Cookies.get("session-id")
            ctaLink.searchParams.set("sessionId", sessionId ?? "")

            // @ts-ignore
            window.Unprice.trackEvent("plan_click", {
              plan_version_id: plan.id,
            })

            // if enterprise we need email
            if (plan.isEnterprisePlan) {
              // open mailto: with the email with subject and body
              // TODO: change the copy to follow customer journey
              const subject = `Enterprise Plan Inquiry for ${plan.name}`
              const body = `I'm interested in the ${plan.name} (enterprise plan). Please contact me.`
              window.open(`mailto:${plan.contactEmail}?subject=${subject}&body=${body}`, "_blank")
            } else {
              window.open(ctaLink.toString(), "_blank")
            }
          }}
        >
          {plan.cta}
        </Button>
      </CardFooter>
    </Card>
  )
}
