// The 11 super admin billing action dialogs (design section 6, items 1-8, 11, 13-14; brief:
// "Bloquear casa", "Estender prazo", "Dar dias grátis", "Desconto nesta fatura", "Desconto
// contínuo", "Dar baixa manual", "Cancelar fatura", "Trocar dia de vencimento", "Congelar
// plano", "Preço próprio", "Reenviar e-mail"). Reused as-is by both the "Faturamento" tab
// (admin.tsx) and the "Cobrança" section of a house (tenants.tsx) — ruling 3.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  adminApplyInvoiceDiscount,
  adminCancelInvoice,
  adminExtendInvoiceDue,
  adminGrantFreeDays,
  adminManualSettle,
  adminResendBillingEmail,
  adminSetContinuousDiscount,
  adminSetCustomPrice,
  adminSetCycleDay,
  adminSetFrozen,
  adminSetTenantBlock,
} from "@/lib/billing/billing-admin.functions";
import { ReasonActionDialog } from "./reason-dialog";

/** Called after any action settles successfully — the caller refetches the list, the dashboard
 * and the history (ruling 4). */
type OnDone = () => void;

function useBillingAction<TInput>(fn: (input: { data: TInput }) => Promise<unknown>) {
  const run = useServerFn(fn as never) as unknown as (input: { data: TInput }) => Promise<{
    message?: string;
  }>;
  return useMutation({
    mutationFn: (input: TInput) => run({ data: input }),
    onError: (error: Error) => toast.error(error.message),
  });
}

// ---------------------------------------------------------------------------
// 1. Bloquear/desbloquear casa
// ---------------------------------------------------------------------------

export function BlockTenantAction({
  tenantId,
  blocked,
  onDone,
}: {
  tenantId: string;
  blocked: boolean;
  onDone: OnDone;
}) {
  const mut = useBillingAction(adminSetTenantBlock);
  return (
    <ReasonActionDialog
      triggerLabel={blocked ? "Desbloquear casa" : "Bloquear casa"}
      triggerVariant={blocked ? "outline" : "destructive"}
      title={blocked ? "Desbloquear casa" : "Bloquear casa"}
      description="Bloqueio imediato, independente de fatura. O desbloqueio é manual."
      pending={mut.isPending}
      onSubmit={async (reason) => {
        await mut.mutateAsync({ tenantId, blocked: !blocked, reason });
        toast.success(blocked ? "Casa desbloqueada." : "Casa bloqueada.");
        onDone();
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// 2. Estender prazo (uma fatura em aberto)
// ---------------------------------------------------------------------------

export function ExtendInvoiceDueAction({
  invoiceId,
  onDone,
}: {
  invoiceId: string | null;
  onDone: OnDone;
}) {
  const [days, setDays] = useState("5");
  const mut = useBillingAction(adminExtendInvoiceDue);
  const daysValue = Number(days);
  const valid = Number.isInteger(daysValue) && daysValue >= 1 && daysValue <= 31;
  return (
    <ReasonActionDialog
      triggerLabel="Estender prazo"
      title="Estender prazo da fatura"
      description="Muda o vencimento desta fatura (+N dias). O ciclo seguinte não muda."
      disabledTrigger={!invoiceId}
      extraFieldsValid={valid}
      pending={mut.isPending}
      onSubmit={async (reason) => {
        if (!invoiceId) return;
        await mut.mutateAsync({ invoiceId, days: daysValue, reason });
        toast.success("Prazo estendido.");
        onDone();
      }}
    >
      <div className="space-y-2">
        <Label>Dias a mais</Label>
        <Input type="number" min={1} max={31} value={days} onChange={(e) => setDays(e.target.value)} />
      </div>
    </ReasonActionDialog>
  );
}

// ---------------------------------------------------------------------------
// 3. Dar dias grátis
// ---------------------------------------------------------------------------

export function GrantFreeDaysAction({ tenantId, onDone }: { tenantId: string; onDone: OnDone }) {
  const [days, setDays] = useState("7");
  const mut = useBillingAction(adminGrantFreeDays);
  const daysValue = Number(days);
  const valid = Number.isInteger(daysValue) && daysValue >= 1 && daysValue <= 365;
  return (
    <ReasonActionDialog
      triggerLabel="Dar dias grátis"
      title="Dar dias grátis"
      description="Estende o período pago atual em N dias sem cobrar. O ciclo inteiro anda junto."
      extraFieldsValid={valid}
      pending={mut.isPending}
      onSubmit={async (reason) => {
        await mut.mutateAsync({ tenantId, days: daysValue, reason });
        toast.success("Dias grátis concedidos.");
        onDone();
      }}
    >
      <div className="space-y-2">
        <Label>Dias grátis</Label>
        <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
      </div>
    </ReasonActionDialog>
  );
}

// ---------------------------------------------------------------------------
// 4. Desconto nesta fatura (pontual)
// ---------------------------------------------------------------------------

export function ApplyInvoiceDiscountAction({
  invoiceId,
  onDone,
}: {
  invoiceId: string | null;
  onDone: OnDone;
}) {
  const [kind, setKind] = useState<"percent" | "fixed">("percent");
  const [value, setValue] = useState("");
  const mut = useBillingAction(adminApplyInvoiceDiscount);
  const valueNumber = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(valueNumber) && valueNumber >= 0;
  return (
    <ReasonActionDialog
      triggerLabel="Desconto nesta fatura"
      title="Desconto pontual nesta fatura"
      description="R$ ou % só nesta fatura em aberto. Cancela o Pix já gerado, se houver."
      disabledTrigger={!invoiceId}
      extraFieldsValid={valid}
      pending={mut.isPending}
      onSubmit={async (reason) => {
        if (!invoiceId) return;
        await mut.mutateAsync({
          invoiceId,
          kind,
          value: kind === "fixed" ? Math.round(valueNumber * 100) : valueNumber,
          reason,
        });
        toast.success("Desconto aplicado.");
        onDone();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label>Tipo</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as "percent" | "fixed")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="percent">Percentual (%)</SelectItem>
              <SelectItem value="fixed">Valor fixo (R$)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{kind === "percent" ? "Percentual" : "Valor (R$)"}</Label>
          <Input type="number" min={0} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
      </div>
    </ReasonActionDialog>
  );
}

// ---------------------------------------------------------------------------
// 5. Desconto contínuo
// ---------------------------------------------------------------------------

export function SetContinuousDiscountAction({
  tenantId,
  onDone,
}: {
  tenantId: string;
  onDone: OnDone;
}) {
  const [kind, setKind] = useState<"percent" | "fixed" | "none">("percent");
  const [value, setValue] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const mut = useBillingAction(adminSetContinuousDiscount);
  const valueNumber = Number(value);
  const valid = kind === "none" || (value.trim() !== "" && Number.isFinite(valueNumber) && valueNumber >= 0);
  return (
    <ReasonActionDialog
      triggerLabel="Desconto contínuo"
      title="Desconto contínuo"
      description="Aplica a toda fatura gerada da casa, com início e fim opcional. Use 'Nenhum' para remover."
      extraFieldsValid={valid}
      pending={mut.isPending}
      onSubmit={async (reason) => {
        await mut.mutateAsync({
          tenantId,
          kind: kind === "none" ? null : kind,
          value: kind === "none" ? null : kind === "fixed" ? Math.round(valueNumber * 100) : valueNumber,
          startsOn: startsOn.trim() === "" ? null : startsOn,
          endsOn: endsOn.trim() === "" ? null : endsOn,
          reason,
        });
        toast.success("Desconto contínuo atualizado.");
        onDone();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label>Tipo</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nenhum (remover)</SelectItem>
              <SelectItem value="percent">Percentual (%)</SelectItem>
              <SelectItem value="fixed">Valor fixo (R$)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {kind !== "none" && (
          <div className="space-y-2">
            <Label>{kind === "percent" ? "Percentual" : "Valor (R$)"}</Label>
            <Input type="number" min={0} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
        )}
      </div>
      {kind !== "none" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <Label>Início (opcional)</Label>
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Fim (opcional)</Label>
            <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </div>
        </div>
      )}
    </ReasonActionDialog>
  );
}

// ---------------------------------------------------------------------------
// 6. Dar baixa manual
// ---------------------------------------------------------------------------

export function ManualSettleAction({
  invoiceId,
  onDone,
}: {
  invoiceId: string | null;
  onDone: OnDone;
}) {
  const [paidAmount, setPaidAmount] = useState("");
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState("");
  const mut = useBillingAction(adminManualSettle);
  const valid = note.trim().length >= 1 && receipt.trim().length >= 1;
  return (
    <ReasonActionDialog
      triggerLabel="Dar baixa manual"
      title="Dar baixa manual"
      description="Marca a fatura como paga fora do Pix. Libera a casa como um pagamento normal."
      disabledTrigger={!invoiceId}
      extraFieldsValid={valid}
      pending={mut.isPending}
      onSubmit={async (reason) => {
        if (!invoiceId) return;
        await mut.mutateAsync({
          invoiceId,
          paidAmountCents: paidAmount.trim() === "" ? null : Math.round(Number(paidAmount) * 100),
          note,
          receipt,
          reason,
        });
        toast.success("Baixa manual registrada.");
        onDone();
      }}
    >
      <div className="space-y-2">
        <Label>Valor recebido (R$, opcional — padrão é o valor da fatura)</Label>
        <Input type="number" min={0} step="0.01" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>Nota</Label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex: Pago via TED" />
      </div>
      <div className="space-y-2">
        <Label>Comprovante (arquivo ou texto)</Label>
        <Textarea value={receipt} onChange={(e) => setReceipt(e.target.value)} rows={2} />
      </div>
    </ReasonActionDialog>
  );
}

// ---------------------------------------------------------------------------
// 7. Cancelar fatura
// ---------------------------------------------------------------------------

export function CancelInvoiceAction({
  invoiceId,
  onDone,
}: {
  invoiceId: string | null;
  onDone: OnDone;
}) {
  const mut = useBillingAction(adminCancelInvoice);
  return (
    <ReasonActionDialog
      triggerLabel="Cancelar fatura"
      triggerVariant="destructive"
      title="Cancelar fatura"
      description="Fatura em aberto gerada por engano. Cancela o Pix na Upper, se houver."
      disabledTrigger={!invoiceId}
      pending={mut.isPending}
      onSubmit={async (reason) => {
        if (!invoiceId) return;
        const result = await mut.mutateAsync({ invoiceId, reason });
        toast.success(result.message ?? "Fatura cancelada.");
        onDone();
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// 8. Trocar dia de vencimento
// ---------------------------------------------------------------------------

export function SetCycleDayAction({ tenantId, onDone }: { tenantId: string; onDone: OnDone }) {
  const [nextDueDate, setNextDueDate] = useState("");
  const mut = useBillingAction(adminSetCycleDay);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(nextDueDate);
  return (
    <ReasonActionDialog
      triggerLabel="Trocar dia de vencimento"
      title="Trocar dia de vencimento"
      description="Muda o dia do ciclo a partir da próxima fatura, sem pró-rata. A fatura em aberto, se houver, mantém a data."
      extraFieldsValid={valid}
      pending={mut.isPending}
      onSubmit={async (reason) => {
        await mut.mutateAsync({ tenantId, nextDueDate, reason });
        toast.success("Dia do ciclo alterado.");
        onDone();
      }}
    >
      <div className="space-y-2">
        <Label>Próximo vencimento</Label>
        <Input type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} />
      </div>
    </ReasonActionDialog>
  );
}

// ---------------------------------------------------------------------------
// 13. Congelar/descongelar plano
// ---------------------------------------------------------------------------

export function SetFrozenAction({
  tenantId,
  frozen,
  onDone,
}: {
  tenantId: string;
  frozen: boolean;
  onDone: OnDone;
}) {
  const mut = useBillingAction(adminSetFrozen);
  return (
    <ReasonActionDialog
      triggerLabel={frozen ? "Descongelar plano" : "Congelar plano"}
      triggerVariant={frozen ? "outline" : "destructive"}
      title={frozen ? "Descongelar plano" : "Congelar plano"}
      description={
        frozen
          ? "O ciclo recomeça a partir de hoje, com fatura vencendo hoje."
          : "Pausa a cobrança: não gera faturas novas e bloqueia a casa."
      }
      pending={mut.isPending}
      onSubmit={async (reason) => {
        await mut.mutateAsync({ tenantId, frozen: !frozen, reason });
        toast.success(frozen ? "Plano descongelado." : "Plano congelado.");
        onDone();
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// 14. Preço próprio (valor do plano por casa)
// ---------------------------------------------------------------------------

export function SetCustomPriceAction({
  tenantId,
  currentPriceCents,
  onDone,
}: {
  tenantId: string;
  currentPriceCents: number | null;
  onDone: OnDone;
}) {
  const [price, setPrice] = useState(
    currentPriceCents != null ? String(currentPriceCents / 100) : "",
  );
  const mut = useBillingAction(adminSetCustomPrice);
  // Minimum of the Pix (global constraint): a non-null custom price must be >= R$ 100,00.
  const priceNumber = Number(price);
  const valid = price.trim() === "" || (Number.isFinite(priceNumber) && priceNumber >= 100);
  return (
    <ReasonActionDialog
      triggerLabel="Preço próprio"
      title="Preço próprio da mensalidade"
      description="Substitui os R$ 4.000,00 para esta casa. Deixe vazio para voltar ao preço padrão."
      extraFieldsValid={valid}
      pending={mut.isPending}
      onSubmit={async (reason) => {
        await mut.mutateAsync({
          tenantId,
          priceCents: price.trim() === "" ? null : Math.round(priceNumber * 100),
          reason,
        });
        toast.success("Preço da mensalidade atualizado.");
        onDone();
      }}
    >
      <div className="space-y-2">
        <Label>Preço mensal (R$, mínimo 100,00 — vazio volta ao padrão)</Label>
        <Input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
      </div>
    </ReasonActionDialog>
  );
}

// ---------------------------------------------------------------------------
// 11. Reenviar e-mail
// ---------------------------------------------------------------------------

export function ResendBillingEmailAction({
  invoiceId,
  onDone,
}: {
  invoiceId: string | null;
  onDone: OnDone;
}) {
  const mut = useBillingAction(adminResendBillingEmail);
  return (
    <ReasonActionDialog
      triggerLabel="Reenviar e-mail"
      title="Reenviar e-mail de cobrança"
      description="Reenvia o último e-mail de cobrança da fatura em aberto."
      disabledTrigger={!invoiceId}
      pending={mut.isPending}
      onSubmit={async (reason) => {
        if (!invoiceId) return;
        await mut.mutateAsync({ invoiceId, reason });
        toast.success("E-mail reenviado.");
        onDone();
      }}
    />
  );
}
