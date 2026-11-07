// Conta própria de provedor por casa: inputs (zod) e rótulos (client-safe:
// nada de servidor aqui). Spec: docs/superpowers/specs/
// 2026-11-07-conta-propria-provedor-design.md (6.1, 6.2, 7).
import { z } from "zod";
import { dbUuid } from "./zod-helpers";

/** Canais com conta própria (web push fica fora). */
export const OWN_PROVIDER_CHANNELS = ["sms", "email", "voice"] as const;
export type OwnProviderChannel = (typeof OWN_PROVIDER_CHANNELS)[number];

export type OwnProvider = "short_brasil" | "infobip";

/** Provedores que a casa pode escolher em cada canal. */
export const OWN_PROVIDERS_BY_CHANNEL: Record<OwnProviderChannel, readonly OwnProvider[]> = {
  sms: ["short_brasil", "infobip"],
  email: ["infobip"],
  voice: ["infobip"],
};

export const OWN_PROVIDER_CHANNEL_LABEL: Record<OwnProviderChannel, string> = {
  sms: "SMS",
  email: "E-mail",
  voice: "Voz",
};

export const OWN_PROVIDER_LABEL: Record<OwnProvider, string> = {
  short_brasil: "Short Brasil",
  infobip: "Infobip",
};

/** Assunto do e-mail aos outros admins da casa (cadastro, troca, ativação, remoção). */
export const OWN_PROVIDER_CHANGED_EMAIL_SUBJECT = "Conta de provedor alterada na sua casa";

const channel = z.enum(OWN_PROVIDER_CHANNELS);

const optionalText = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v ? v : undefined));

/** Senha da reautenticação: nunca aparada (espaços contam). */
const password = z.string().min(1, "Informe sua senha.").max(200);

// ---------------------------------------------------------------------------
// Super admin

export const setOwnProviderGrantInput = z.object({
  tenantId: dbUuid(),
  channel,
  allowed: z.boolean(),
  /** Taxa mensal em centavos, >= 0. */
  monthlyFeeCents: z.number().int().min(0).max(100_000_000),
});

export const resolveRevokedOwnProviderInput = z.object({
  tenantId: dbUuid(),
  channel,
  action: z.enum(["use_default", "keep_paused"]),
});

// ---------------------------------------------------------------------------
// Casa (admin da casa)

export const saveOwnProviderAccountInput = z.object({
  channel,
  provider: z.enum(["short_brasil", "infobip"]),
  label: z.string().trim().min(1, "Informe um nome para a conta.").max(80),
  /** Short Brasil de conta própria não aceita URL nenhuma: só os campos da Infobip. */
  config: z
    .object({
      base_url: optionalText,
      voice_from: optionalText,
      sms_from: optionalText,
    })
    .prefault({}),
  /** Só os campos sendo trocados; campo em branco/ausente mantém o valor gravado. */
  credentials: z
    .object({
      shortcode_token: optionalText,
      usuario: optionalText,
      chave: optionalText,
      api_key: optionalText,
    })
    .prefault({}),
  /** R$ por unidade do canal; ausente mantém o valor gravado. */
  ownUnitCost: z.number().min(0).max(1_000_000).nullable().optional(),
  password,
});
export type SaveOwnProviderAccountInput = z.input<typeof saveOwnProviderAccountInput>;

export const testOwnProviderAccountInput = z.object({
  channel,
  /** Short Brasil não tem endpoint só de leitura: o teste manda um SMS. */
  phone: z.string().trim().max(30).optional(),
});

export const activateOwnProviderInput = z.object({ channel, password });

export const deactivateOwnProviderInput = z.object({ channel });

export const removeOwnProviderAccountInput = z.object({ channel, password });

/** Mensagem exibida nas telas de SMS/e-mail/voz quando a conta própria da
 * casa recusa o envio (Task 13) — nunca o nome do provedor. */
export function ownProviderSendRefusedMessage(channel: OwnProviderChannel): string {
  return `Sua conta de ${OWN_PROVIDER_CHANNEL_LABEL[channel]} recusou o envio. Confira saldo e credenciais em Integrações → Canais.`;
}
