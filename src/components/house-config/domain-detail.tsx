// Presentational card for a single tenant domain (shortener or email):
// status badge, DNS records table with a per-row copy button, and the
// action buttons from the design's domain mockup. Pure/dumb on purpose —
// DomainsSection owns the mutations, confirmation dialog (with
// getHouseDomainUsages) and the "send instructions" dialog; this component
// only renders state and forwards clicks.
import { Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import type { DnsRecord, DomainStatus } from "@/lib/house-config";

export type DomainDetailDomain = {
  id: string;
  hostname: string;
  status: DomainStatus;
  is_default: boolean;
  dns_records: DnsRecord[];
  last_checked_at: string | null;
  last_error: string | null;
};

const STATUS_LABEL: Record<DomainStatus, string> = {
  pending: "Aguardando DNS",
  verified: "Verificado",
  failed: "Falhou",
};

const STATUS_BADGE_VARIANT: Record<DomainStatus, "secondary" | "default" | "destructive"> = {
  pending: "secondary",
  verified: "default",
  failed: "destructive",
};

function formatLastChecked(lastCheckedAt: string | null): string {
  if (!lastCheckedAt) return "Nunca verificado";
  return new Date(lastCheckedAt).toLocaleString("pt-BR");
}

export function DomainDetail({
  domain,
  canEdit,
  verifying,
  isDemo = false,
  onCopyRecord,
  onVerifyNow,
  onSendInstructions,
  onSetDefault,
  onRemove,
}: {
  domain: DomainDetailDomain;
  canEdit: boolean;
  verifying?: boolean;
  /** Demo tenants can view every action but never execute a write — same
   * `DemoDisabledTooltip` + disabled pattern as the rest of the house-config
   * write controls. */
  isDemo?: boolean;
  onCopyRecord?: (record: DnsRecord) => void;
  onVerifyNow?: () => void;
  onSendInstructions?: () => void;
  onSetDefault?: () => void;
  onRemove?: () => void;
}) {
  const canBeDefault = domain.status === "verified" && !domain.is_default;

  return (
    <div className="rounded-lg border border-border/40 bg-background/30 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-medium truncate">{domain.hostname}</p>
          <p className="text-xs text-muted-foreground">
            Última verificação: {formatLastChecked(domain.last_checked_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {domain.is_default && <Badge variant="outline">Padrão</Badge>}
          <Badge variant={STATUS_BADGE_VARIANT[domain.status]}>{STATUS_LABEL[domain.status]}</Badge>
        </div>
      </div>

      {domain.last_error && <p className="text-xs text-muted-foreground">{domain.last_error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tipo</TableHead>
            <TableHead>Nome</TableHead>
            <TableHead>Valor</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {domain.dns_records.map((record, index) => (
            <TableRow key={`${record.type}-${record.name}-${index}`}>
              <TableCell>{record.type}</TableCell>
              <TableCell className="font-mono">{record.name}</TableCell>
              <TableCell className="font-mono break-all">{record.value}</TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Copiar valor de ${record.name}`}
                  onClick={() => onCopyRecord?.(record)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <DemoDisabledTooltip active={isDemo}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onVerifyNow}
              disabled={isDemo || verifying}
            >
              {verifying ? "Verificando…" : "Verificar agora"}
            </Button>
          </DemoDisabledTooltip>
          <DemoDisabledTooltip active={isDemo}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSendInstructions}
              disabled={isDemo}
            >
              Enviar instruções por e-mail
            </Button>
          </DemoDisabledTooltip>
          <DemoDisabledTooltip active={isDemo}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSetDefault}
              disabled={isDemo || !canBeDefault}
            >
              Definir como padrão
            </Button>
          </DemoDisabledTooltip>
          <DemoDisabledTooltip active={isDemo}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={onRemove}
              disabled={isDemo}
            >
              Remover
            </Button>
          </DemoDisabledTooltip>
        </div>
      )}
    </div>
  );
}
