import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveOperationalTenantId } from "./tenant-access.server";
import { normalizeConsentSubject, syncLegacySuppression } from "./consent.server";
import { neutralizeCsvFormula } from "@/lib/csv-safe";

const inputSchema = z.object({
  channel: z.enum(["sms", "email", "voice"]),
  subject: z.string().min(3).max(255),
  status: z.enum(["granted", "revoked"]),
  legalBasis: z.string().max(120).optional(),
  reason: z.string().min(1).max(255),
  source: z.string().max(80).default("operator"),
});

// Quantas linhas a tela mostra por vez. O total real vem de `count: "exact"`.
export const CONSENT_LIST_LIMIT = 1000;
// Teto de segurança da exportação (a lista não tem limite de 1.000).
export const CONSENT_EXPORT_MAX = 100_000;
const CONSENT_EXPORT_PAGE = 1000;

/**
 * Converte o texto digitado na busca em padrão de `ilike` sobre `subject`.
 * Telefones são gravados só com dígitos (normalizeConsentSubject), então um
 * termo sem letras nem "@" vira só dígitos ("(11) 99999" -> "1199999").
 * Escapa os curingas do LIKE para o termo ser literal.
 */
export function consentSearchPattern(raw: string | null | undefined): string | null {
  const term = (raw ?? "").trim().toLowerCase();
  if (!term) return null;
  const looksLikeText = /[a-z@]/i.test(term);
  const value = looksLikeText ? term : term.replace(/\D/g, "");
  if (!value) return null;
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const listInput = z
  .object({ search: z.string().max(255).nullish() })
  .optional()
  .default({});

export const listChannelConsents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => listInput.parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const pattern = consentSearchPattern(data.search);
    let consents = (context.supabase as any)
      .from("channel_consents")
      .select("*", { count: "exact" })
      .eq("tenant_id", tenantId);
    if (pattern) consents = consents.ilike("subject", pattern);
    const [
      { data: rows, error, count },
      { data: audit, error: auditError },
      { data: voicePolicy, error: policyError },
    ] = await Promise.all([
      consents.order("updated_at", { ascending: false }).limit(CONSENT_LIST_LIMIT),
      (context.supabase as any)
        .from("channel_consent_audit")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(100),
      (context.supabase as any)
        .from("voice_contact_policies")
        .select("enabled,cooldown_hours,rolling_24h_limit")
        .eq("tenant_id", tenantId)
        .maybeSingle(),
    ]);
    if (error || auditError || policyError)
      throw new Error(error?.message ?? auditError?.message ?? policyError?.message);
    return {
      items: rows ?? [],
      total: typeof count === "number" ? count : (rows ?? []).length,
      audit: audit ?? [],
      voicePolicy: voicePolicy ?? { enabled: true, cooldown_hours: 24, rolling_24h_limit: 1 },
    };
  });

const EXPORT_COLUMNS = [
  "channel",
  "subject",
  "status",
  "reason",
  "legal_basis",
  "source",
  "updated_at",
] as const;

export function consentRowsToCsv(rows: Array<Record<string, unknown>>): string {
  return [
    EXPORT_COLUMNS.join(","),
    ...rows.map((r) =>
      EXPORT_COLUMNS.map((col) => `"${neutralizeCsvFormula(r[col]).replaceAll('"', '""')}"`).join(
        ",",
      ),
    ),
  ].join("\n");
}

/**
 * Exportação completa da base de consentimentos da casa (sem o recorte da
 * tela), paginada de 1.000 em 1.000 até CONSENT_EXPORT_MAX. Aceita a mesma
 * busca da tela. Ordem estável por id para a paginação não pular linhas.
 */
export const exportChannelConsents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => listInput.parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const pattern = consentSearchPattern(data.search);
    const rows: Array<Record<string, unknown>> = [];
    let truncated = false;
    for (let offset = 0; ; offset += CONSENT_EXPORT_PAGE) {
      if (offset >= CONSENT_EXPORT_MAX) {
        truncated = true;
        break;
      }
      let q = (context.supabase as any)
        .from("channel_consents")
        .select(EXPORT_COLUMNS.join(","))
        .eq("tenant_id", tenantId);
      if (pattern) q = q.ilike("subject", pattern);
      const { data: page, error } = await q
        .order("id", { ascending: true })
        .range(offset, offset + CONSENT_EXPORT_PAGE - 1);
      if (error) throw new Error(error.message);
      const got = (page ?? []) as Array<Record<string, unknown>>;
      rows.push(...got);
      if (got.length < CONSENT_EXPORT_PAGE) break;
    }
    return { csv: consentRowsToCsv(rows), rows: rows.length, truncated };
  });

export const saveVoiceContactPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z
      .object({
        enabled: z.boolean(),
        cooldownHours: z.number().int().min(0).max(720),
        rolling24hLimit: z.number().int().min(1).max(100),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { error } = await (context.supabase as any).from("voice_contact_policies").upsert(
      {
        tenant_id: tenantId,
        enabled: data.enabled,
        cooldown_hours: data.cooldownHours,
        rolling_24h_limit: data.rolling24hLimit,
      },
      { onConflict: "tenant_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const saveChannelConsent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => inputSchema.parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const subject = normalizeConsentSubject(data.channel, data.subject);
    const db = context.supabase as any;
    const { data: previous, error: previousError } = await db
      .from("channel_consents")
      .select("id,status")
      .eq("tenant_id", tenantId)
      .eq("channel", data.channel)
      .eq("subject", subject)
      .maybeSingle();
    if (previousError) throw new Error(previousError.message);
    const { data: saved, error } = await db
      .from("channel_consents")
      .upsert(
        {
          tenant_id: tenantId,
          channel: data.channel,
          subject,
          status: data.status,
          legal_basis: data.legalBasis ?? null,
          reason: data.reason,
          source: data.source,
          occurred_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,channel,subject" },
      )
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await syncLegacySuppression(
      tenantId,
      data.channel,
      subject,
      data.status,
      data.reason,
      data.source,
    );
    const { data: user } = await context.supabase.auth.getUser();
    const { error: auditError } = await (supabaseAdmin as any)
      .from("channel_consent_audit")
      .insert({
        tenant_id: tenantId,
        consent_id: saved.id,
        channel: data.channel,
        subject,
        previous_status: previous?.status ?? null,
        new_status: data.status,
        reason: data.reason,
        source: data.source,
        actor_user_id: user.user?.id ?? null,
      });
    if (auditError) throw new Error(`Falha ao auditar consentimento: ${auditError.message}`);
    return { id: saved.id };
  });

export const importChannelConsents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({ rows: z.array(inputSchema).min(1).max(5000) }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    let imported = 0;
    for (const row of data.rows) {
      const subject = normalizeConsentSubject(row.channel, row.subject);
      const { error } = await (context.supabase as any).from("channel_consents").upsert(
        {
          tenant_id: tenantId,
          channel: row.channel,
          subject,
          status: row.status,
          legal_basis: row.legalBasis ?? null,
          reason: row.reason,
          source: row.source,
          occurred_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,channel,subject" },
      );
      if (error) throw new Error(error.message);
      await syncLegacySuppression(
        tenantId,
        row.channel,
        subject,
        row.status,
        row.reason,
        row.source,
      );
      imported++;
    }
    const { error: auditError } = await (supabaseAdmin as any).from("channel_consent_audit").insert(
      data.rows.map((row) => ({
        tenant_id: tenantId,
        channel: row.channel,
        subject: normalizeConsentSubject(row.channel, row.subject),
        new_status: row.status,
        reason: row.reason,
        source: `import:${row.source}`,
      })),
    );
    if (auditError) throw new Error(`Falha ao auditar importacao: ${auditError.message}`);
    return { imported };
  });
