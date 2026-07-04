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
  return (
    <PlanVersionFeatureListItem
      feature={props.feature}
      withCalculator={props.withCalculator}
      withQuantity={props.withQuantity}
      onQuantityChange={props.onQuantityChange}
      hideCheckIcon={props.noCheckIcon}
      hideTitle={props.noTitle}
      className={props.className}
    />
  )
}
