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
