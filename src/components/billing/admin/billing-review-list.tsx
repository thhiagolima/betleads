// PG6-03 fix wave: Pix charges waiting for review (needs_review, not credited,
// not resolved yet) with the "Resolver" action. Resolving only records the
// outcome (credited manually / refunded outside the system); it never credits.
import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  adminListReviewCharges,
  adminResolveChargeReview,
} from "@/lib/billing/billing-health.functions";
import {
  REVIEW_OUTCOME_LABELS,
  REVIEW_OUTCOMES,
  type ReviewOutcome,
} from "@/lib/billing/charge-review";
import { brl } from "@/lib/format";

import { ReasonActionDialog } from "./reason-dialog";

const BILLING_REVIEW_QUERY_KEY = ["admin", "billing", "review-charges"];

type ReviewItem = Awaited<ReturnType<typeof adminListReviewCharges>>[number];

function ResolveReviewDialog({ item, onResolved }: { item: ReviewItem; onResolved: () => void }) {
  const [outcome, setOutcome] = useState<ReviewOutcome | "">("");
  const groupId = useId();
  const resolveFn = useServerFn(adminResolveChargeReview);
  const mut = useMutation({
    mutationFn: (reason: string) => resolveFn({ data: { chargeId: item.id, outcome, reason } }),
    onSuccess: () => {
      toast.success("Revisão resolvida.");
      onResolved();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <ReasonActionDialog
      triggerLabel="Resolver"
      title="Resolver revisão"
      description="Registra o que foi feito com este Pix. Não credita nada: se o dinheiro deve entrar, faça antes pelo Ajustar saldo ou pela baixa manual."
      extraFieldsValid={outcome !== ""}
      pending={mut.isPending}
      onOpenChange={(open) => {
        if (!open) setOutcome("");
      }}
      onSubmit={async (reason) => {
        await mut.mutateAsync(reason);
      }}
    >
      <div className="space-y-2">
        <Label id={groupId}>Resultado</Label>
        <RadioGroup
          aria-labelledby={groupId}
          value={outcome}
          onValueChange={(value) => setOutcome(value as ReviewOutcome)}
        >
          {REVIEW_OUTCOMES.map((value) => (
            <div key={value} className="flex items-center gap-2">
              <RadioGroupItem value={value} id={`${groupId}-${value}`} />
              <Label htmlFor={`${groupId}-${value}`} className="font-normal">
                {REVIEW_OUTCOME_LABELS[value]}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>
    </ReasonActionDialog>
  );
}

export function BillingReviewList({ onResolved }: { onResolved?: () => void }) {
  const queryClient = useQueryClient();
  const listFn = useServerFn(adminListReviewCharges);
  const { data, isLoading, isError } = useQuery({
    queryKey: BILLING_REVIEW_QUERY_KEY,
    queryFn: () => listFn() as Promise<ReviewItem[]>,
  });

  if (isLoading) return <div className="h-10 animate-pulse rounded-md bg-muted" />;
  if (isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Não foi possível carregar as cobranças em revisão.
      </p>
    );
  }
  if (!data || data.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Cobranças aguardando revisão</p>
      <ul className="space-y-2">
        {data.map((item) => (
          <li
            key={item.id}
            className="flex flex-col gap-2 rounded-md border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate">
                {item.tenantName ?? "Casa"} ·{" "}
                {item.kind === "invoice" ? "Mensalidade" : "Recarga de créditos"}
              </p>
              <p className="text-xs text-muted-foreground">
                Cobrado {brl(item.amountCents / 100)} · pago{" "}
                {item.paidAmountCents == null
                  ? "valor desconhecido"
                  : brl(item.paidAmountCents / 100)}
                {item.paidAt ? ` em ${new Date(item.paidAt).toLocaleString("pt-BR")}` : ""}
              </p>
              <p className="font-mono text-xs text-muted-foreground">{item.externalId}</p>
            </div>
            <ResolveReviewDialog
              item={item}
              onResolved={() => {
                void queryClient.invalidateQueries({ queryKey: BILLING_REVIEW_QUERY_KEY });
                onResolved?.();
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
