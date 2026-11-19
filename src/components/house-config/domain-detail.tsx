// Presentational card for a single tenant domain (shortener or email):
// status badge, DNS records list with copy buttons for each name and value, and the
// action buttons from the design's domain mockup. Pure/dumb on purpose —
// DomainsSection owns the mutations, confirmation dialog (with
// getHouseDomainUsages) and the "send instructions" dialog; this component
// only renders state and forwards clicks (copying a DNS name/value is local).
import { Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "sonner";
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

/** Why "Definir como padrão" is disabled while the domain isn't verified
 * yet — shown both as a `DemoDisabledTooltip`-style hover/focus tooltip
 * (real `Portal`, same pattern as the demo-blocked tooltip) and as a
 * screen-reader-only reason linked via `aria-describedby`, so the control's
 * disabled reason doesn't depend on hover/focus for either sighted or
 * assistive-tech users, and is checkable in a static (non-jsdom) render. */
const NOT_VERIFIED_REASON_TEXT = "Disponível depois que o domínio for verificado";

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

/** Text after "Próxima verificação automática:" for a domain not verified
 * yet: "em instantes" when the scheduled time has already passed (the cron
 * picks it up on its next run), only the time when it's later today, and the
 * date plus the time when it's another day. */
export function formatNextAutoCheck(next: Date, now: Date): string {
  if (next.getTime() <= now.getTime()) return "em instantes";
  const time = next.toLocaleTimeString("pt-BR");
  if (next.toDateString() === now.toDateString()) return time;
  return `${next.toLocaleDateString("pt-BR")} às ${time}`;
}

const DNS_GRID =
  "sm:grid sm:grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1.4fr)_5.5rem] sm:items-center sm:gap-3";

async function copyDnsText(text: string, what: string) {
  if (await copyToClipboard(text)) toast.success(`${what} copiado`);
  else toast.error("Não foi possível copiar. Selecione o texto e copie à mão.");
}

/** A DNS name or value: monospace, wraps anywhere, with its own copy button. */
function DnsField({
  label,
  text,
  copyLabel,
  anchorAttrs,
}: {
  label: string;
  text: string;
  copyLabel: string;
  anchorAttrs?: { "data-tour": string };
}) {
  return (
    <div className="min-w-0">
      <span className="block text-meta text-muted-foreground sm:hidden">{label}</span>
      <div className="flex items-start gap-1">
        <span className="min-w-0 flex-1 break-all pt-2 font-mono text-meta sm:pt-0 sm:self-center sm:text-sm">
          {text}
        </span>
        <IconButton
          type="button"
          label={copyLabel}
          icon={<Copy className="h-4 w-4" />}
          className="shrink-0 sm:size-8"
          onClick={() => void copyDnsText(text, label)}
          {...anchorAttrs}
        />
      </div>
    </div>
  );
}

export function DomainDetail({
  domain,
  canEdit,
  verifying,
  isDemo = false,
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
  onVerifyNow?: () => void;
  onSendInstructions?: () => void;
  onSetDefault?: () => void;
  onRemove?: () => void;
}) {
  const canBeDefault = domain.status === "verified" && !domain.is_default;
  // When the domain isn't verified (and the tenant isn't demo — the demo
  // tooltip takes precedence over this reason), "Definir como padrão" is
  // disabled because there's nothing to promote yet.
  const notVerifiedYet = !isDemo && domain.status !== "verified";
  const setDefaultReasonId = `domain-${domain.id}-set-default-reason`;
  const nextCheckAt = nextDomainCheckAt(
    {
      status: domain.status,
      created_at: domain.created_at,
      last_checked_at: domain.last_checked_at,
    },
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
          : `Próxima verificação automática: ${formatNextAutoCheck(nextCheckAt, new Date())}`}
      </p>

      {/* One list for both layouts: a card per record on a phone (Nome and
          Valor stacked, each with its own copy button) and a table-like grid
          from sm up. A single tree keeps every tour anchor unique. */}
      <div className="rounded-md border border-border/40" {...tourAnchor("casa.dominio.dns-table")}>
        <div
          aria-hidden="true"
          className={`hidden border-b border-border/40 px-3 py-2 text-meta font-medium text-muted-foreground ${DNS_GRID}`}
        >
          <span>Tipo</span>
          <span>Nome</span>
          <span>Valor</span>
          <span>Situação</span>
        </div>
        <ul className="divide-y divide-border/40">
          {domain.dns_records.map((record, index) => (
            <li
              key={`${record.type}-${record.name}-${index}`}
              className={`space-y-2 px-3 py-3 text-sm sm:space-y-0 sm:py-2 ${DNS_GRID}`}
            >
              <div className="flex items-center justify-between gap-2 sm:contents">
                <span className="font-medium sm:font-normal">{record.type}</span>
                <span className="text-meta text-muted-foreground sm:hidden">
                  {dnsRecordStatusLabel(record.verified)}
                </span>
              </div>
              <DnsField
                label="Nome"
                text={record.name}
                copyLabel={`Copiar nome de ${record.name}`}
              />
              <DnsField
                label="Valor"
                text={record.value}
                copyLabel={`Copiar valor de ${record.name}`}
                anchorAttrs={index === 0 ? tourAnchor("casa.dominio.copy") : undefined}
              />
              <span className="hidden sm:block">{dnsRecordStatusLabel(record.verified)}</span>
            </li>
          ))}
        </ul>
      </div>

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
            <DemoDisabledTooltip active={notVerifiedYet} text={NOT_VERIFIED_REASON_TEXT}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSetDefault}
                disabled={isDemo || !canBeDefault}
                aria-describedby={notVerifiedYet ? setDefaultReasonId : undefined}
                {...tourAnchor("casa.dominio.set-default")}
              >
                Definir como padrão
              </Button>
            </DemoDisabledTooltip>
          </DemoDisabledTooltip>
          {notVerifiedYet && (
            <span id={setDefaultReasonId} className="sr-only">
              {NOT_VERIFIED_REASON_TEXT}
            </span>
          )}
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
