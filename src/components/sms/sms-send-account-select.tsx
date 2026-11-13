// "Enviar por": the SMS account a house send goes out through. The house only
// sees the names the super admin gave its accounts (never vendor nor internal
// label); `null` is always "Padrão da casa". House-only: the expert never picks.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listSmsSendAccounts } from "@/lib/sms.functions";

export type SmsSendAccountChoice = { id: string | null; name: string; available: boolean };

/** Select value of "Padrão da casa" (sent as `providerAccountId: null`). */
const DEFAULT_VALUE = "default";

export const SMS_SEND_ACCOUNT_QUERY_KEY = ["sms-send-accounts"] as const;

/**
 * Loads the house's SMS send choices. `showChoice` is false while there is only
 * the default, so the screen stays as it was for a house without extra accounts.
 */
export function useSmsSendAccounts(selectedId: string | null, enabled: boolean) {
  const listFn = useServerFn(listSmsSendAccounts);
  const query = useQuery({
    queryKey: SMS_SEND_ACCOUNT_QUERY_KEY,
    queryFn: () => listFn(),
    enabled,
    staleTime: 60_000,
  });
  const choices: SmsSendAccountChoice[] = query.data?.choices ?? [];
  const showChoice = enabled && choices.length > 1;
  const selected = showChoice ? (choices.find((item) => item.id === selectedId) ?? null) : null;
  return {
    choices,
    showChoice,
    /** What to send as `providerAccountId`: null = "Padrão da casa". */
    providerAccountId: showChoice ? selectedId : null,
    /** Name of the picked account, only when the house has a choice to make. */
    selectedName: selected?.name ?? null,
    /** A picked extra account that went unavailable blocks the send; the default never does here. */
    error:
      selected?.id && !selected.available
        ? "A conta de envio escolhida está indisponível. Escolha outra em “Enviar por”."
        : null,
  };
}

export function SmsSendAccountSelect({
  id,
  choices,
  value,
  onChange,
  invalid,
}: {
  id: string;
  choices: SmsSendAccountChoice[];
  value: string | null;
  onChange: (value: string | null) => void;
  invalid?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Enviar por</Label>
      <Select
        value={value ?? DEFAULT_VALUE}
        onValueChange={(next) => onChange(next === DEFAULT_VALUE ? null : next)}
      >
        <SelectTrigger id={id} aria-invalid={invalid || undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((item) => {
            const unavailable = item.id !== null && !item.available;
            return (
              <SelectItem
                key={item.id ?? DEFAULT_VALUE}
                value={item.id ?? DEFAULT_VALUE}
                // Keep a picked account that went unavailable visible in its own select.
                disabled={unavailable && item.id !== value}
              >
                {unavailable ? `${item.name} (indisponível)` : item.name}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
