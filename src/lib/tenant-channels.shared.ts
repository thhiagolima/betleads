// Defaults and labels for per-house channel state (client-safe: no server
// imports). Design: docs/superpowers/specs/
// 2026-11-05-contas-padrao-canais-por-casa-design.md.
import { z } from "zod";
import { dbUuid } from "./zod-helpers";
import { PROVIDER_CHANNEL_LABEL, PROVIDER_CHANNELS, type ProviderChannelName } from "./provider-accounts.shared";

/** Client-safe alias of provider-accounts.server's ProviderChannel. */
export type ProviderChannel = ProviderChannelName;

/** A casa sem linha em tenant_channels usa este padrão. */
export const DEFAULT_ENABLED_CHANNELS: Record<ProviderChannel, boolean> = {
  sms: true,
  email: true,
  voice: true,
  webpush: false,
};

export function CHANNEL_DISABLED_MESSAGE(channel: ProviderChannel): string {
  return `O canal ${PROVIDER_CHANNEL_LABEL[channel]} está desabilitado para esta casa.`;
}

/**
 * `email_campaigns.blocked_reason` of a campaign paused because the house's
 * e-mail channel was turned off — a raw code, not meant for display (unlike
 * SMS's `SMS_CAMPAIGN_CHANNEL_DISABLED_MESSAGE`, already a full sentence).
 * Client-safe home for it (`email.functions.ts` isn't) so the UI can map it
 * to a readable sentence without pulling server-only code into the bundle.
 */
export const EMAIL_CAMPAIGN_CHANNEL_DISABLED_REASON = "channel_disabled";

/** step type -> canal que ele consome (para checar antes de reservar crédito). */
export const STEP_TYPE_CHANNEL: Partial<Record<string, ProviderChannel>> = {
  sms: "sms",
  email: "email",
  voice: "voice",
};

/** Item de cobrança (`src/lib/format.ts` BillingItem) -> canal correspondente. */
export const BILLING_ITEM_CHANNEL: Record<"sms" | "voice_30s" | "email" | "webpush", ProviderChannel> = {
  sms: "sms",
  voice_30s: "voice",
  email: "email",
  webpush: "webpush",
};

/** Formato mínimo de um passo de jornada usado para o diff de canal (Task 7). */
export type StepLike = {
  id?: string | null;
  step_type: string;
  config: Record<string, unknown>;
};

/**
 * JSON com as chaves dos objetos ordenadas (recursivo): o jsonb do Postgres
 * reordena as chaves, então `JSON.stringify` puro não serve para comparar o
 * config armazenado com o que chega do editor. Arrays mantêm a ordem.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? "undefined";
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function stepContentKey(step: StepLike): string {
  return `${step.step_type}:${stableStringify(step.config)}`;
}

/**
 * Passos de canal desligado em `incoming` que não existem idênticos em
 * `stored` (jornada antiga com passo de canal desligado continua salvável
 * sem mudar o passo; só passos novos/alterados do canal são recusados).
 *
 * Identidade só por conteúdo (`step_type` + config com chaves ordenadas),
 * ignorando `id`: os passos armazenados vêm do banco com id, os de entrada
 * chegam do editor sem id (e rascunho/publicada têm ids diferentes). O
 * casamento é por multiconjunto — cada passo armazenado casa com no máximo
 * um de entrada.
 */
export function newDisabledChannelSteps(
  stored: StepLike[],
  incoming: StepLike[],
  disabled: Set<ProviderChannel>,
): StepLike[] {
  const storedByKey = new Map<string, number>();
  for (const step of stored) {
    const key = stepContentKey(step);
    storedByKey.set(key, (storedByKey.get(key) ?? 0) + 1);
  }

  const result: StepLike[] = [];
  for (const step of incoming) {
    const channel = STEP_TYPE_CHANNEL[step.step_type];
    if (!channel || !disabled.has(channel)) continue;
    const key = stepContentKey(step);
    const count = storedByKey.get(key) ?? 0;
    if (count > 0) {
      storedByKey.set(key, count - 1);
      continue;
    }
    result.push(step);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Admin: ligar/desligar canal da casa (Task 5).

export const setTenantChannelInput = z.object({
  tenantId: dbUuid(),
  channel: z.enum(PROVIDER_CHANNELS),
  enabled: z.boolean(),
});

export const tenantChannelImpactInput = z.object({
  tenantId: dbUuid(),
  channel: z.enum(PROVIDER_CHANNELS),
});
