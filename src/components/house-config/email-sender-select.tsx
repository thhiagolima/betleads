// E-mail sender picker for the campaign composer and the journey editor's
// e-mail step. `value: null` means "padrão da casa" — the tenant's current
// default verified sender — so a saved draft keeps following the default
// even if it changes later. When no sender has a verified domain yet,
// `senders` is empty: callers show `EMAIL_BLOCKED_WARNING` and disable the
// send/schedule action (the server rejects the send anyway with
// EMAIL_DOMAIN_NOT_VERIFIED).
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type EmailSenderOption = { id: string; label: string; isDefault: boolean };

export const EMAIL_BLOCKED_WARNING =
  "Configure e verifique um domínio de e-mail da casa para enviar e-mails.";

export function EmailSenderSelect({
  senders,
  value,
  onChange,
  disabled,
}: {
  senders: EmailSenderOption[];
  /** `null` = "padrão da casa" (the tenant's default verified sender). */
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const defaultSender = senders.find((s) => s.isDefault) ?? senders[0];
  const defaultLabel = defaultSender
    ? `Padrão da casa (${defaultSender.label})`
    : "Padrão da casa";

  return (
    <Select
      value={value ?? "__default"}
      onValueChange={(next) => onChange(next === "__default" ? null : next)}
      disabled={disabled || senders.length === 0}
    >
      <SelectTrigger aria-label="Remetente de e-mail">
        <SelectValue placeholder={defaultLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__default">{defaultLabel}</SelectItem>
        {senders.map((sender) => (
          <SelectItem key={sender.id} value={sender.id}>
            {sender.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
