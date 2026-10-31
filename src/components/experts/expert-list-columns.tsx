// Células das colunas de campanhas na lista de experts (Área do Expert §8):
// Envio (Livre / Com aprovação + pendentes), Teto (R$ ou "Sem teto") e Uso
// do mês (barra uso × teto).
import { Link } from "@tanstack/react-router";

import { Badge } from "@/components/ui/badge";
import { ExpertUsageBar } from "@/components/experts/expert-campaigns-admin";
import type { ExpertEnvioModo } from "@/lib/experts-admin.functions";
import { brl } from "@/lib/format";

const ENVIO_MODO_LABEL: Record<ExpertEnvioModo, string> = {
  livre: "Livre",
  aprovacao: "Com aprovação",
};

export function ExpertEnvioCell({
  expertId,
  envioModo,
  pendentes,
}: {
  expertId: string;
  envioModo: ExpertEnvioModo;
  pendentes: number;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="whitespace-nowrap text-sm">{ENVIO_MODO_LABEL[envioModo]}</span>
      {pendentes > 0 && (
        <Link
          to="/rendimento/equipe/$expertId"
          params={{ expertId }}
          search={{ aba: "campanhas" }}
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge className="whitespace-nowrap border-transparent bg-warning/15 text-warning shadow-none hover:bg-warning/25">
            {pendentes === 1 ? "1 pendente" : `${pendentes} pendentes`}
          </Badge>
        </Link>
      )}
    </div>
  );
}

export function ExpertTetoCell({ teto }: { teto: number | null }) {
  if (teto === null) return <span className="text-sm text-muted-foreground">Sem teto</span>;
  if (teto <= 0)
    return (
      <span className="whitespace-nowrap text-sm">
        {brl(0)} <span className="text-xs text-destructive">(bloqueado)</span>
      </span>
    );
  return <span className="whitespace-nowrap text-sm tabular-nums">{brl(teto)}</span>;
}

export function ExpertUsageCell({
  usage,
}: {
  usage: { teto: number | null; usado: number } | null;
}) {
  if (!usage) return <span className="text-xs text-muted-foreground">—</span>;
  return <ExpertUsageBar usage={usage} compact />;
}
