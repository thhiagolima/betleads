import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";

import { formatDateTime } from "@/components/integrations/meta/meta-format";
import { useSmsBalanceBanner } from "@/components/sms-balance-banner";
import type { BalanceStatus } from "@/lib/sms-balance";
import { cn } from "@/lib/utils";

/** Texto, cor e explicação do saldo no header (função pura para teste). */
export function balanceChip(status: BalanceStatus): {
  text: string;
  tone: "ok" | "low" | "empty" | "unknown";
  title: string;
} {
  if (status.balance == null || status.level === "unknown") {
    return {
      text: "sem leitura",
      tone: "unknown",
      title: status.lastReadAt
        ? `Saldo de SMS da Short Brasil sem leitura desde ${formatDateTime(status.lastReadAt)}.`
        : "Saldo de SMS da Short Brasil sem leitura nas últimas 24 horas.",
    };
  }
  const value = status.balance.toLocaleString("pt-BR");
  const read = status.balanceAt ? `, lido em ${formatDateTime(status.balanceAt)}` : "";
  return {
    text: value,
    tone: status.level === "empty" ? "empty" : status.level === "low" ? "low" : "ok",
    title:
      `Saldo de SMS na conta padrão da Short Brasil: ${value} SMS${read}. ` +
      `Lido a cada 15 minutos; avisa com ${status.threshold.toLocaleString("pt-BR")} SMS ou menos.`,
  };
}

const TONE: Record<ReturnType<typeof balanceChip>["tone"], string> = {
  ok: "border-border text-foreground/80",
  low: "border-warning/50 bg-warning/10 text-warning",
  empty: "border-danger/50 bg-danger/10 text-danger",
  unknown: "border-border text-muted-foreground",
};

/**
 * Saldo de SMS da Short Brasil no header, para o super admin e os usuários
 * escolhidos no admin (Canais). Some para os outros.
 */
export function SmsBalanceChip() {
  const { data } = useSmsBalanceBanner();
  if (!data) return null;
  const chip = balanceChip(data.status);
  const className = cn(
    "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs tabular-nums sm:px-3",
    TONE[chip.tone],
  );
  const content = (
    <>
      <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="hidden sm:inline">Saldo SMS:</span>
      <span className="font-medium">{chip.text}</span>
    </>
  );
  if (data.isSuperAdmin) {
    return (
      <Link to="/admin" hash="canais" title={chip.title} aria-label={chip.title} className={cn(className, "hover:bg-muted/40")}>
        {content}
      </Link>
    );
  }
  return (
    <span role="status" title={chip.title} aria-label={chip.title} className={className}>
      {content}
    </span>
  );
}
