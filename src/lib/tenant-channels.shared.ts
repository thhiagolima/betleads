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
 * Passos de canal desligado em `incoming` que não existem idênticos em
 * `stored` (jornada antiga com passo de canal desligado continua salvável
 * sem mudar o passo; só passos novos/alterados do canal são recusados).
 *
 * Identidade: quando o passo armazenado e o de entrada têm `id`, casam por
 * `id` e são idênticos só se o `step_type`/`config` também baterem (um
 * `id` igual com conteúdo diferente conta como alterado). Sem `id` dos dois
 * lados, casam por `step_type` + `JSON.stringify(config)` como multiconjunto
 * (uma entrada é consumida por correspondência, não reusada).
 */
export function newDisabledChannelSteps(
  stored: StepLike[],
  incoming: StepLike[],
  disabled: Set<ProviderChannel>,
): StepLike[] {
  const storedById = new Map<string, StepLike>();
  const storedByKey = new Map<string, number>();
  for (const step of stored) {
    if (step.id) {
      storedById.set(step.id, step);
    } else {
      const key = `${step.step_type}:${JSON.stringify(step.config)}`;
      storedByKey.set(key, (storedByKey.get(key) ?? 0) + 1);
    }
  }

  const result: StepLike[] = [];
  for (const step of incoming) {
    const channel = STEP_TYPE_CHANNEL[step.step_type];
    if (!channel || !disabled.has(channel)) continue;

    if (step.id && storedById.has(step.id)) {
      const match = storedById.get(step.id)!;
      const identical =
        match.step_type === step.step_type &&
        JSON.stringify(match.config) === JSON.stringify(step.config);
      if (identical) {
        storedById.delete(step.id);
        continue;
      }
      result.push(step);
      continue;
    }

    const key = `${step.step_type}:${JSON.stringify(step.config)}`;
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
