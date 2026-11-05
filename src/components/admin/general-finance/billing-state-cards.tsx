// Task 4 — "Financeiro geral" tab (super admin): one card per billing-state
// bucket (Task 2's `BUCKET_LABELS`), clickable to filter the house table
// below. A second click on the active bucket clears the filter.
import { BUCKET_LABELS, type BillingBucket } from "@/lib/billing/billing-state-summary";
import { formatCentsBRL } from "@/components/billing/admin/billing-admin-ui";
import { cn } from "@/lib/utils";

const BUCKET_ORDER: BillingBucket[] = [
  "ok",
  "due_soon",
  "overdue",
  "locked",
  "awaiting_first_payment",
  "frozen",
  "exempt",
];

export function BillingStateCards({
  counts,
  owedCents,
  selectedBucket,
  onSelectBucket,
}: {
  counts: Record<BillingBucket, number>;
  owedCents: number;
  selectedBucket: BillingBucket | null;
  onSelectBucket: (bucket: BillingBucket) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {BUCKET_ORDER.map((bucket) => {
          const active = selectedBucket === bucket;
          return (
            <button
              key={bucket}
              type="button"
              onClick={() => onSelectBucket(bucket)}
              aria-pressed={active}
              className={cn(
                "flex flex-col items-start rounded-xl border p-3 text-left transition-colors",
                active ? "border-primary bg-primary/10" : "border-border bg-card/80 hover:bg-card",
              )}
            >
              <span className="text-label text-muted-foreground">{BUCKET_LABELS[bucket]}</span>
              <span className="text-xl font-semibold tabular-nums">{counts[bucket]}</span>
            </button>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground">Em aberto: {formatCentsBRL(owedCents)}</p>
    </div>
  );
}
