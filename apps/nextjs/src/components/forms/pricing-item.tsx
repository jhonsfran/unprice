import { PlanVersionFeatureListItem } from "~/components/billing/plan-version-feature-list"

export function PricingItem(props: {
  feature: Parameters<typeof PlanVersionFeatureListItem>[0]["feature"]
  withCalculator?: boolean
  withQuantity?: boolean
  onQuantityChange?: (quantity: number) => void
  noCheckIcon?: boolean
  noTitle?: boolean
  className?: string
}) {
  const mode = props.withCalculator
    ? props.withQuantity
      ? { showCalculator: true, showQuantity: true }
      : props.noCheckIcon
        ? { showCalculator: true, showCheckIcon: false }
        : { showCalculator: true }
    : props.noTitle
      ? { showTitle: false }
      : undefined

  return (
    <PlanVersionFeatureListItem
      feature={props.feature}
      displayOptions={mode}
      onQuantityChange={props.onQuantityChange}
      className={props.className}
    />
  )
}
