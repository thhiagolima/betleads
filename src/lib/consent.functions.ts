import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveOperationalTenantId } from "./tenant-access.server";
import { normalizeConsentSubject, syncLegacySuppression } from "./consent.server";

const inputSchema = z.object({
  channel: z.enum(["sms", "email", "voice"]),
  subject: z.string().min(3).max(255),
  status: z.enum(["granted", "revoked"]),
  legalBasis: z.string().max(120).optional(),
  reason: z.string().min(1).max(255),
  source: z.string().max(80).default("operator"),
});

export const listChannelConsents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const [
      { data, error },
      { data: audit, error: auditError },
      { data: voicePolicy, error: policyError },
    ] = await Promise.all([
      (context.supabase as any)
        .from("channel_consents")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false })
        .limit(1000),
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
      items: data ?? [],
      audit: audit ?? [],
      voicePolicy: voicePolicy ?? { enabled: true, cooldown_hours: 24, rolling_24h_limit: 1 },
    };
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
    const { data: previous } = await db
      .from("channel_consents")
      .select("id,status")
      .eq("tenant_id", tenantId)
      .eq("channel", data.channel)
      .eq("subject", subject)
      .maybeSingle();
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
    await (supabaseAdmin as any).from("channel_consent_audit").insert({
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
    await (supabaseAdmin as any).from("channel_consent_audit").insert(
      data.rows.map((row) => ({
        tenant_id: tenantId,
        channel: row.channel,
        subject: normalizeConsentSubject(row.channel, row.subject),
        new_status: row.status,
        reason: row.reason,
        source: `import:${row.source}`,
      })),
    );
    return { imported };
  });
