// Super admin management of the Pix gateways (Admin → Faturamento → "Gateways
// de pagamento"): credentials of Upper and SpacePay stored encrypted in
// `payment_gateway_accounts`, and which one receives NEW charges
// (`payment_gateway_settings`). Env vars stay the fallback (the loader in
// payment-gateway-config.server.ts reads both).
//
// Credentials are write-only: only masked hints leave the server, a blank
// secret on save means "keep the stored one", and audit rows carry the names
// of the fields that changed, never their values.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditAdminAction } from "@/lib/admin-audit.server";
import { assertSuperAdmin } from "@/lib/provider-governance.server";

import {
  deletePaymentGatewayCredentials,
  describePaymentGateways,
  getActivePixProvider,
  getSpacePayConfig,
  getUpperConfig,
  savePaymentGatewayCredentials,
  setActivePixProvider,
  type SpacePayConfig,
  type UpperConfig,
} from "./payment-gateway-config.server";
import {
  testSpacePayConnection,
  testUpperConnection,
  type GatewayTestResult,
} from "./payment-gateway-test.server";
import type { PixProvider } from "./pix-gateway-error";

type AdminContext = { userId: string };

export const PAYMENT_GATEWAY_LABEL: Record<PixProvider, string> = {
  upper: "Upper",
  spacepay: "SpacePay",
};

export const SPACEPAY_CALLBACK_SECRET_MIN = 32;

// ---------------------------------------------------------------------------
// Document / field validation

/** CPF check digits (11 digits, not all equal). */
export function isValidCpf(value: string): boolean {
  const d = value.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(d[9]) && digit(10) === Number(d[10]);
}

/** CNPJ check digits (14 digits, not all equal). */
export function isValidCnpj(value: string): boolean {
  const d = value.replace(/\D/g, "");
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const digit = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + Number(d[i]) * w, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return digit(12) === Number(d[12]) && digit(13) === Number(d[13]);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Blank / whitespace-only → undefined ("keep the stored value"). */
const optionalText = (max = 2000) =>
  z
    .string()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v && v.trim() ? v.trim() : undefined));

const apiBaseField = optionalText(500).refine(
  (v) => v === undefined || isHttpsUrl(v),
  "A URL da API precisa começar com https://.",
);

const upperCredentialsInput = z.object({
  apiKey: optionalText(),
  webhookSecret: optionalText(),
  apiBase: apiBaseField,
});

const spacePayCredentialsInput = z.object({
  gatewayToken: optionalText(4000),
  casinoToken: optionalText(4000),
  callbackSecret: optionalText(500).refine(
    (v) => v === undefined || v.length >= SPACEPAY_CALLBACK_SECRET_MIN,
    `O segredo do callback precisa ter ao menos ${SPACEPAY_CALLBACK_SECRET_MIN} caracteres.`,
  ),
  apiBase: apiBaseField,
  payer: z
    .object({
      name: optionalText(200),
      document: optionalText(30).refine(
        (v) => v === undefined || isValidCpf(v) || isValidCnpj(v),
        "Documento do pagador inválido (informe um CPF ou CNPJ válido).",
      ),
      email: optionalText(200).refine(
        (v) => v === undefined || z.string().email().safeParse(v).success,
        "E-mail do pagador inválido.",
      ),
      phone: optionalText(30).refine(
        (v) => v === undefined || /^\d{10,13}$/.test(v.replace(/\D/g, "")),
        "Telefone do pagador inválido (10 a 13 dígitos, com DDD).",
      ),
    })
    .optional()
    .default({ name: undefined, document: undefined, email: undefined, phone: undefined }),
});

const UPPER_CLEARABLE = ["webhookSecret", "apiBase"] as const;
const SPACEPAY_CLEARABLE = ["casinoToken", "apiBase"] as const;

const providerInput = z.enum(["upper", "spacepay"]);

export const adminSavePaymentGatewayInput = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("upper"),
    credentials: upperCredentialsInput,
    /** Optional fields to erase from the stored row (blank alone keeps them). */
    clearFields: z.array(z.enum(UPPER_CLEARABLE)).optional().default([]),
  }),
  z.object({
    provider: z.literal("spacepay"),
    credentials: spacePayCredentialsInput,
    clearFields: z.array(z.enum(SPACEPAY_CLEARABLE)).optional().default([]),
  }),
]);

export const adminTestPaymentGatewayInput = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("upper"), credentials: upperCredentialsInput.optional() }),
  z.object({ provider: z.literal("spacepay"), credentials: spacePayCredentialsInput.optional() }),
]);

export const adminSetActivePixProviderInput = z.object({ provider: providerInput });
export const adminDeletePaymentGatewayInput = z.object({ provider: providerInput });

type SaveInput = z.output<typeof adminSavePaymentGatewayInput>;
type TestInput = z.output<typeof adminTestPaymentGatewayInput>;
type UpperInput = z.output<typeof upperCredentialsInput>;
type SpacePayInput = z.output<typeof spacePayCredentialsInput>;

// ---------------------------------------------------------------------------
// Merge with what is stored (blank = keep)

/** Stored DB credentials only: env values are never copied into the row. */
async function storedUpper(): Promise<UpperConfig | null> {
  const loaded = await getUpperConfig();
  return loaded.source === "database" ? loaded.config : null;
}

async function storedSpacePay(): Promise<SpacePayConfig | null> {
  const loaded = await getSpacePayConfig();
  return loaded.source === "database" ? loaded.config : null;
}

function mergeUpper(
  input: UpperInput,
  stored: UpperConfig | null,
  clear: readonly string[] = [],
): { apiKey: string | null; webhookSecret: string | null; apiBase: string | null } {
  const pick = (key: "webhookSecret" | "apiBase") =>
    input[key] ?? (clear.includes(key) ? null : (stored?.[key] ?? null));
  return {
    apiKey: input.apiKey ?? stored?.apiKey ?? null,
    webhookSecret: pick("webhookSecret"),
    apiBase: pick("apiBase"),
  };
}

function mergeSpacePay(input: SpacePayInput, stored: SpacePayConfig | null, clear: readonly string[] = []) {
  const pick = (key: "casinoToken" | "apiBase") =>
    input[key] ?? (clear.includes(key) ? null : (stored?.[key] ?? null));
  const payer = input.payer ?? {};
  return {
    gatewayToken: input.gatewayToken ?? stored?.gatewayToken ?? null,
    casinoToken: pick("casinoToken"),
    callbackSecret: input.callbackSecret ?? stored?.callbackSecret ?? null,
    apiBase: pick("apiBase"),
    payer: {
      name: payer.name ?? stored?.payer.name ?? null,
      document: payer.document?.replace(/\D/g, "") ?? stored?.payer.document ?? null,
      email: payer.email ?? stored?.payer.email ?? null,
      phone: payer.phone?.replace(/\D/g, "") ?? stored?.payer.phone ?? null,
    },
  };
}

/** Names (never values) of the fields that differ between two credential objects. */
function changedFields(before: unknown, after: unknown, prefix = ""): string[] {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const out: string[] = [];
  for (const key of keys) {
    const va = a[key];
    const vb = b[key];
    if ((va && typeof va === "object") || (vb && typeof vb === "object")) {
      out.push(...changedFields(va, vb, `${prefix}${key}.`));
    } else if ((va ?? null) !== (vb ?? null)) {
      out.push(`${prefix}${key}`);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Bodies (exported for unit tests)

export async function adminListPaymentGatewaysFor(context: AdminContext) {
  await assertSuperAdmin(context.userId);
  return describePaymentGateways();
}

export async function adminSavePaymentGatewayFor(
  context: AdminContext,
  raw: unknown,
): Promise<{ ok: true; changed: string[] }> {
  await assertSuperAdmin(context.userId);
  const data: SaveInput = adminSavePaymentGatewayInput.parse(raw);

  let before: UpperConfig | SpacePayConfig | null;
  let next: UpperConfig | SpacePayConfig;
  if (data.provider === "upper") {
    const stored = await storedUpper();
    before = stored;
    const merged = mergeUpper(data.credentials, stored, data.clearFields);
    if (!merged.apiKey) throw new Error("Informe a API key da Upper.");
    next = { apiKey: merged.apiKey, webhookSecret: merged.webhookSecret, apiBase: merged.apiBase };
  } else {
    const stored = await storedSpacePay();
    before = stored;
    const m = mergeSpacePay(data.credentials, stored, data.clearFields);
    if (!m.gatewayToken) throw new Error("Informe o token do gateway SpacePay.");
    if (!m.callbackSecret) {
      throw new Error(
        `Informe o segredo do callback (ao menos ${SPACEPAY_CALLBACK_SECRET_MIN} caracteres).`,
      );
    }
    if (!m.payer.name) throw new Error("Informe o nome do pagador.");
    if (!m.payer.document) throw new Error("Informe o CPF ou CNPJ do pagador.");
    if (!m.payer.email) throw new Error("Informe o e-mail do pagador.");
    if (!m.payer.phone) throw new Error("Informe o telefone do pagador.");
    next = {
      gatewayToken: m.gatewayToken,
      casinoToken: m.casinoToken,
      callbackSecret: m.callbackSecret,
      apiBase: m.apiBase,
      payer: {
        name: m.payer.name,
        document: m.payer.document,
        email: m.payer.email,
        phone: m.payer.phone,
      },
    };
  }

  const changed = changedFields(before, next);
  await savePaymentGatewayCredentials(data.provider, next, context.userId);
  await auditAdminAction({
    actorUserId: context.userId,
    action: before ? "payment_gateway.update" : "payment_gateway.create",
    // Never the credentials: only which fields were (re)written.
    before: before ? { provider: data.provider, stored: true } : null,
    after: { provider: data.provider, fields_changed: changed },
  });
  return { ok: true, changed };
}

export async function adminTestPaymentGatewayFor(
  context: AdminContext,
  raw: unknown,
): Promise<GatewayTestResult> {
  await assertSuperAdmin(context.userId);
  const data: TestInput = adminTestPaymentGatewayInput.parse(raw);
  const candidate = data.credentials !== undefined;

  let result: GatewayTestResult;
  if (data.provider === "upper") {
    const loaded = await getUpperConfig();
    const creds = data.credentials
      ? mergeUpper(data.credentials, loaded.source === "database" ? loaded.config : null)
      : loaded.config;
    result = creds?.apiKey
      ? await testUpperConnection({ apiKey: creds.apiKey, apiBase: creds.apiBase ?? null })
      : { ok: false, message: "Upper sem API key configurada." };
  } else {
    const loaded = await getSpacePayConfig();
    const creds = data.credentials
      ? mergeSpacePay(data.credentials, loaded.source === "database" ? loaded.config : null)
      : loaded.config;
    result = creds?.gatewayToken
      ? await testSpacePayConnection({
          gatewayToken: creds.gatewayToken,
          casinoToken: creds.casinoToken ?? null,
          apiBase: creds.apiBase ?? null,
        })
      : { ok: false, message: "SpacePay sem token do gateway configurado." };
  }

  await auditAdminAction({
    actorUserId: context.userId,
    action: "payment_gateway.test",
    after: { provider: data.provider, candidate, ok: result.ok, message: result.message.slice(0, 300) },
  });
  return result;
}

export async function adminSetActivePixProviderFor(
  context: AdminContext,
  raw: unknown,
): Promise<{ ok: true; activeProvider: PixProvider }> {
  await assertSuperAdmin(context.userId);
  const { provider } = adminSetActivePixProviderInput.parse(raw);
  const loaded = provider === "upper" ? await getUpperConfig() : await getSpacePayConfig();
  if (loaded.source === "none" || !loaded.config) {
    throw new Error(
      `${PAYMENT_GATEWAY_LABEL[provider]} não tem credenciais configuradas. Salve as credenciais antes de usá-la.`,
    );
  }
  const before = await getActivePixProvider();
  await setActivePixProvider(provider, context.userId);
  await auditAdminAction({
    actorUserId: context.userId,
    action: "payment_gateway.set_active",
    before: { active_provider: before },
    after: { active_provider: provider, credentials_source: loaded.source },
  });
  return { ok: true, activeProvider: provider };
}

/** Whether the env vars alone configure `provider` (same required set as the loader). */
function envHasFallback(provider: PixProvider): boolean {
  const has = (name: string) => Boolean(process.env[name]?.trim());
  if (provider === "upper") return has("UPPER_API_KEY");
  return [
    "SPACEPAY_GATEWAY_TOKEN",
    "SPACEPAY_CALLBACK_SECRET",
    "SPACEPAY_PAYER_NAME",
    "SPACEPAY_PAYER_DOCUMENT",
    "SPACEPAY_PAYER_EMAIL",
    "SPACEPAY_PAYER_PHONE",
  ].every(has);
}

async function openChargesOn(provider: PixProvider): Promise<number> {
  const { count, error } = await (supabaseAdmin as any) // eslint-disable-line @typescript-eslint/no-explicit-any
    .from("payment_charges")
    .select("id", { count: "exact", head: true })
    .eq("provider", provider)
    .in("status", ["PENDING", "ACTIVE"]);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function adminDeletePaymentGatewayFor(
  context: AdminContext,
  raw: unknown,
): Promise<{ ok: true }> {
  await assertSuperAdmin(context.userId);
  const { provider } = adminDeletePaymentGatewayInput.parse(raw);
  const label = PAYMENT_GATEWAY_LABEL[provider];
  const loaded = provider === "upper" ? await getUpperConfig() : await getSpacePayConfig();
  if (loaded.source !== "database") {
    throw new Error(`${label} não tem credenciais salvas no banco.`);
  }
  if (!envHasFallback(provider) && (await getActivePixProvider()) === provider) {
    throw new Error(
      `${label} é o gateway das novas cobranças e não há variáveis de ambiente para substituir. Troque o gateway ativo antes de remover.`,
    );
  }
  // Even with an env fallback: the open charges' callback/webhook may be
  // signed with the secret stored in this row, and a rejected SpacePay
  // callback rolls the payment back on their side.
  const open = await openChargesOn(provider);
  if (open > 0) {
    throw new Error(
      `Há ${open} cobrança(s) Pix em aberto na ${label}. O aviso de pagamento delas depende das credenciais salvas; espere elas vencerem antes de remover.`,
    );
  }
  await deletePaymentGatewayCredentials(provider);
  await auditAdminAction({
    actorUserId: context.userId,
    action: "payment_gateway.delete",
    before: { provider, stored: true },
    after: { provider, env_fallback: envHasFallback(provider) },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Server functions

export const adminListPaymentGateways = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => adminListPaymentGatewaysFor(context as AdminContext));

export const adminSavePaymentGateway = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminSavePaymentGatewayInput.parse(data))
  .handler(async ({ data, context }) => adminSavePaymentGatewayFor(context as AdminContext, data));

export const adminTestPaymentGateway = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminTestPaymentGatewayInput.parse(data))
  .handler(async ({ data, context }) => adminTestPaymentGatewayFor(context as AdminContext, data));

export const adminSetActivePixProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminSetActivePixProviderInput.parse(data))
  .handler(async ({ data, context }) => adminSetActivePixProviderFor(context as AdminContext, data));

export const adminDeletePaymentGateway = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => adminDeletePaymentGatewayInput.parse(data))
  .handler(async ({ data, context }) => adminDeletePaymentGatewayFor(context as AdminContext, data));
