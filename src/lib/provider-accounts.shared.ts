// Inputs and labels of the provider-accounts admin (client-safe: no server imports).
import { z } from "zod";
import { dbUuid } from "@/lib/zod-helpers";

export const PROVIDER_CHANNELS = ["sms", "email", "voice"] as const;
export type ProviderChannelName = (typeof PROVIDER_CHANNELS)[number];

export const PROVIDER_CHANNEL_LABEL: Record<ProviderChannelName, string> = {
  sms: "SMS",
  email: "E-mail",
  voice: "Voz",
};

export const PROVIDER_LABEL = { short_brasil: "Short Brasil", infobip: "Infobip" } as const;

/** Channels each provider can serve. */
export const SUPPORTED_CHANNELS: Record<
  "short_brasil" | "infobip",
  readonly ProviderChannelName[]
> = {
  short_brasil: ["sms"],
  infobip: ["sms", "email", "voice"],
};

const optionalText = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v ? v : undefined));

export const saveProviderAccountInput = z.object({
  id: dbUuid().optional(),
  provider: z.enum(["short_brasil", "infobip"]),
  label: z.string().trim().min(1, "Informe um nome para a conta.").max(80),
  channels: z.array(z.enum(PROVIDER_CHANNELS)).min(1, "Escolha pelo menos um canal."),
  config: z
    .object({
      base_url: optionalText,
      voice_from: optionalText,
      shortcode_url: optionalText,
      single_url: optionalText,
      bulk_url: optionalText,
      sms_from: optionalText,
    })
    .prefault({}),
  /** Only the fields being set; an empty/absent field keeps the stored value. */
  credentials: z
    .object({
      shortcode_token: optionalText,
      usuario: optionalText,
      chave: optionalText,
      api_key: optionalText,
    })
    .prefault({}),
});
export type SaveProviderAccountInput = z.input<typeof saveProviderAccountInput>;

export const setProviderAccountStatusInput = z.object({
  id: dbUuid(),
  status: z.enum(["active", "disabled"]),
});

export const testProviderAccountInput = z.object({
  id: dbUuid(),
  /** Short Brasil has no read-only endpoint: the test sends one SMS here. */
  phone: z.string().trim().max(30).optional(),
});

export const setTenantChannelProviderInput = z.object({
  tenantId: dbUuid(),
  channel: z.enum(PROVIDER_CHANNELS),
  /** null = back to the platform account. */
  accountId: dbUuid().nullable(),
});
