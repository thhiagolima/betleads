import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import type { MetaAccount } from "@/components/integrations/meta-summary";
import { cn } from "@/lib/utils";

export type Tone = "ok" | "attention" | "error" | "none";

const TONE_CLASS: Record<Tone, string> = {
  ok: "border-success/30 bg-success/10 text-success",
  attention: "border-warning/30 bg-warning/10 text-warning",
  error: "border-danger/30 bg-danger/10 text-danger",
  none: "border-border/60 text-muted-foreground",
};

const TONE_ICON = {
  ok: CheckCircle2,
  attention: AlertTriangle,
  error: XCircle,
  none: CircleDashed,
} as const;

/** Status sempre com texto e ícone (não só cor), MB3-10. */
export function ToneBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 whitespace-nowrap text-meta font-medium", TONE_CLASS[tone], className)}
    >
      <Icon aria-hidden className="h-3 w-3" />
      {children}
    </Badge>
  );
}

const SYNC_LABEL: Record<MetaAccount["sync_status"], string> = {
  healthy: "dados atualizados",
  syncing: "sincronizando",
  queued: "aguardando",
  error: "erro",
  warning: "atenção",
  never: "sem leitura",
};

const SYNC_TONE: Record<MetaAccount["sync_status"], Tone> = {
  healthy: "ok",
  syncing: "none",
  queued: "none",
  error: "error",
  warning: "attention",
  never: "none",
};

export function SyncStatusBadge({ status }: { status: MetaAccount["sync_status"] }) {
  if (status === "syncing") {
    return (
      <Badge
        variant="outline"
        className="gap-1 whitespace-nowrap border-info/30 bg-info/10 text-meta font-medium text-info"
      >
        <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
        {SYNC_LABEL.syncing}
      </Badge>
    );
  }
  return <ToneBadge tone={SYNC_TONE[status]}>{SYNC_LABEL[status]}</ToneBadge>;
}
