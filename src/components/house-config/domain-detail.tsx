// Presentational card for a single tenant domain (shortener or email):
// status badge, DNS records table with a per-row copy button, and the
// action buttons from the design's domain mockup. Pure/dumb on purpose —
// DomainsSection owns the mutations, confirmation dialog (with
// getHouseDomainUsages) and the "send instructions" dialog; this component
// only renders state and forwards clicks.
import type { ReactNode } from "react";
import { Copy } from "lucide-react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
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
import { tourAnchor } from "@/help/anchor";
import { nextDomainCheckAt, type DnsRecord, type DomainStatus } from "@/lib/house-config";

export type DomainDetailDomain = {
  id: string;
  hostname: string;
  status: DomainStatus;
  is_default: boolean;
  dns_records: DnsRecord[];
  created_at: string;
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

/** pt-BR label for a single DNS record's verification state: `true` is
 * "ok", `false` is "pendente" (checked, still not matching), `null` is "—"
 * (not checked yet). */
function dnsRecordStatusLabel(verified: boolean | null): string {
  if (verified === true) return "ok";
  if (verified === false) return "pendente";
  return "—";
}

/**
 * Explains, via a tooltip, why "Definir como padrão" is disabled because the
 * domain isn't verified yet — same focusable-wrapper-span pattern as
 * `DemoDisabledTooltip`, but rendered WITHOUT `TooltipPrimitive.Portal` and
 * with `forceMount`: a portaled node never appears in `renderToStaticMarkup`
 * output (React portals need a real DOM target), so it couldn't be covered
 * by the component test otherwise. `data-[state=closed]:invisible` keeps it
 * out of sight (and out of the way of pointer events) until hovered/focused.
 */
function NotVerifiedTooltip({ show, children }: { show: boolean; children: ReactNode }) {
  if (!show) return <>{children}</>;

  return (
    <TooltipPrimitive.Provider delayDuration={150}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <span tabIndex={0} className="inline-flex">
            {children}
          </span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Content
          forceMount
          sideOffset={4}
          className="z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground data-[state=closed]:invisible data-[state=closed]:opacity-0 animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          Disponível depois que o domínio for verificado
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
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
  const nextCheckAt = nextDomainCheckAt(
    { status: domain.status, created_at: domain.created_at, last_checked_at: domain.last_checked_at },
    new Date(),
  );

  return (
    <div
      className="rounded-lg border border-border/40 bg-background/30 p-4 space-y-4"
      {...tourAnchor("casa.dominio.card")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-medium truncate">{domain.hostname}</p>
          <p className="text-xs text-muted-foreground">
            Última verificação: {formatLastChecked(domain.last_checked_at)}
          </p>
        </div>
        <div className="flex items-center gap-2" {...tourAnchor("casa.dominio.status")}>
          {domain.is_default && <Badge variant="outline">Padrão</Badge>}
          <Badge variant={STATUS_BADGE_VARIANT[domain.status]}>{STATUS_LABEL[domain.status]}</Badge>
        </div>
      </div>

      {domain.last_error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {domain.last_error}
        </div>
      )}

      <p className="text-xs text-muted-foreground" {...tourAnchor("casa.dominio.next-check")}>
        {domain.status === "verified"
          ? `Próxima checagem: ${nextCheckAt.toLocaleDateString("pt-BR")}`
          : `Próxima verificação automática: ${nextCheckAt.toLocaleTimeString("pt-BR")}`}
      </p>

      <Table {...tourAnchor("casa.dominio.dns-table")}>
        <TableHeader>
          <TableRow>
            <TableHead>Tipo</TableHead>
            <TableHead>Nome</TableHead>
            <TableHead>Valor</TableHead>
            <TableHead>Situação</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {domain.dns_records.map((record, index) => (
            <TableRow key={`${record.type}-${record.name}-${index}`}>
              <TableCell>{record.type}</TableCell>
              <TableCell className="font-mono">{record.name}</TableCell>
              <TableCell className="font-mono break-all">{record.value}</TableCell>
              <TableCell>{dnsRecordStatusLabel(record.verified)}</TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Copiar valor de ${record.name}`}
                  onClick={() => onCopyRecord?.(record)}
                  {...(index === 0 ? tourAnchor("casa.dominio.copy") : {})}
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
              {...tourAnchor("casa.dominio.verify")}
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
              {...tourAnchor("casa.dominio.send-instructions")}
            >
              Enviar instruções por e-mail
            </Button>
          </DemoDisabledTooltip>
          <DemoDisabledTooltip active={isDemo}>
            <NotVerifiedTooltip show={!isDemo && domain.status !== "verified"}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSetDefault}
                disabled={isDemo || !canBeDefault}
                {...tourAnchor("casa.dominio.set-default")}
              >
                Definir como padrão
              </Button>
            </NotVerifiedTooltip>
          </DemoDisabledTooltip>
          <DemoDisabledTooltip active={isDemo}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={onRemove}
              disabled={isDemo}
              {...tourAnchor("casa.dominio.remove")}
            >
              Remover
            </Button>
          </DemoDisabledTooltip>
        </div>
      )}
    </div>
  );
}
