// Shortener domain picker for the campaign composer and the journey editor's
// SMS/e-mail steps. `value: null` means "padrão da casa" — the tenant's
// current default verified domain (or the CRM's shortener, if none is
// verified) — so a saved draft keeps following the default even if it
// changes later. Shows the Global Constraints fallback warning whenever
// there's no verified domain to shorten links with.
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ShortDomainOption = { id: string; hostname: string; isDefault: boolean };

export const SHORTENER_FALLBACK_WARNING =
  "Seu domínio personalizado ainda não foi verificado — os links estão saindo pelo encurtador padrão do CRM.";

export function ShortDomainSelect({
  domains,
  value,
  onChange,
  disabled,
}: {
  domains: ShortDomainOption[];
  /** `null` = "padrão da casa" (the tenant's default verified domain). */
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const defaultDomain = domains.find((d) => d.isDefault) ?? domains[0];
  const defaultLabel = defaultDomain
    ? `Padrão da casa (${defaultDomain.hostname})`
    : "Padrão da casa (encurtador do CRM)";

  return (
    <Select
      value={value ?? "__default"}
      onValueChange={(next) => onChange(next === "__default" ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger aria-label="Domínio do encurtador">
        <SelectValue placeholder={defaultLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__default">{defaultLabel}</SelectItem>
        {domains.map((domain) => (
          <SelectItem key={domain.id} value={domain.id}>
            {domain.hostname}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
