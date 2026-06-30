import { Skeleton } from "@unprice/ui/skeleton"
import {
  EvidenceFrame,
  EvidenceMetricStrip,
  EvidenceMetricTile,
  EvidenceSection,
} from "~/components/analytics/evidence-panel"

const INGESTION_SUMMARY_METRICS = ["Success", "Processed", "Rejected", "Failed", "Attention"]
const INGESTION_SUMMARY_SKELETON_BADGES = (
  <>
    <Skeleton className="h-5 w-20" />
    <Skeleton className="h-5 w-20" />
  </>
)
const INGESTION_SUMMARY_SKELETON_ACTIONS = <Skeleton className="h-4 w-48" />
const INGESTION_SUMMARY_SKELETON_VALUE = <Skeleton className="h-7 w-16" />
const INGESTION_SUMMARY_SKELETON_HELPER = <Skeleton className="h-3 w-24" />
const INGESTION_SUMMARY_SKELETON_ICON = <Skeleton className="size-4 rounded-full" />

export function IngestionEventsSummarySkeleton({ windowLabel }: { windowLabel: string }) {
  return (
    <>
      <EvidenceSection
        title="Ingestion health"
        description={`Events ${windowLabel}. Rejections are business denials; failures need recovery.`}
        badges={INGESTION_SUMMARY_SKELETON_BADGES}
        actions={INGESTION_SUMMARY_SKELETON_ACTIONS}
      >
        <EvidenceMetricStrip className="md:grid-cols-5">
          {INGESTION_SUMMARY_METRICS.map((label) => (
            <EvidenceMetricTile
              key={label}
              label={label}
              value={INGESTION_SUMMARY_SKELETON_VALUE}
              helper={INGESTION_SUMMARY_SKELETON_HELPER}
              icon={INGESTION_SUMMARY_SKELETON_ICON}
            />
          ))}
        </EvidenceMetricStrip>
        <IngestionActionSlotSkeleton />
      </EvidenceSection>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <EvidenceSection
          title="Request path"
          description="Processed, rejected, and failed ingestion events by second."
          contentClassName="mt-3"
          titleClassName="text-base"
        >
          <EvidenceFrame>
            <Skeleton className="h-full w-full rounded-none" />
          </EvidenceFrame>
        </EvidenceSection>
        <EvidenceSection
          title="Top rejection reasons"
          description="Business denials grouped by reason, event, and source."
          contentClassName="mt-3"
          titleClassName="text-base"
        >
          <EvidenceFrame className="flex flex-col gap-3 p-3">
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-full rounded-md" />
          </EvidenceFrame>
        </EvidenceSection>
      </div>
    </>
  )
}

function IngestionActionSlotSkeleton() {
  return (
    <div aria-hidden="true" className="rounded-md border border-border/60 bg-card/40 px-3 py-2">
      <Skeleton className="h-5 w-full max-w-xl" />
    </div>
  )
}
