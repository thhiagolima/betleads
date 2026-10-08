import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { orchestrate } from "./orchestrator.server";
import { brtDayStart } from "./tz";
import { resolveOperationalTenantId } from "./tenant-access.server";
import { assertSuperAdmin } from "./provider-governance.server";

export const simulateActivation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    return orchestrate({ mode: "simulate", tenantId });
  });

export const executeActivation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    return orchestrate({ mode: "execute", tenantId });
  });

export const getAutomationSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { data } = await supabaseAdmin
      .from("automation_settings")
      .select("*")
      .eq("tenant_id", tenantId)
      .limit(1)
      .maybeSingle();
    return { settings: data };
  });

export const setPaused = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ paused: z.boolean() }).parse(i))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { data: s } = await supabaseAdmin
      .from("automation_settings")
      .select("id")
      .eq("tenant_id", tenantId)
      .limit(1)
      .maybeSingle();
    if (!s) return { ok: false };
    await supabaseAdmin.from("automation_settings").update({ paused: data.paused }).eq("id", s.id);
    return { ok: true };
  });

const CHANNEL_PAUSE_FIELDS = [
  "sms_paused",
  "email_paused",
  "call_paused",
  "whatsapp_paused",
] as const;

export const setChannelPaused = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        channel: z.enum(["sms", "email", "call", "whatsapp"]),
        paused: z.boolean(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { data: s } = await supabaseAdmin
      .from("automation_settings")
      .select("id")
      .eq("tenant_id", tenantId)
      .limit(1)
      .maybeSingle();
    if (!s) return { ok: false };
    const patch =
      data.channel === "sms"
        ? { sms_paused: data.paused }
        : data.channel === "email"
          ? { email_paused: data.paused }
          : data.channel === "call"
            ? { call_paused: data.paused }
            : { whatsapp_paused: data.paused };
    await supabaseAdmin.from("automation_settings").update(patch).eq("id", s.id);
    return { ok: true };
  });

export const updateLimits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        sms_daily_limit: z.number().int().min(0).max(100000).optional(),
        email_daily_limit: z.number().int().min(0).max(100000).optional(),
        call_daily_limit: z.number().int().min(0).max(100000).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { data: s } = await supabaseAdmin
      .from("automation_settings")
      .select("id")
      .eq("tenant_id", tenantId)
      .limit(1)
      .maybeSingle();
    if (!s) return { ok: false };
    await supabaseAdmin.from("automation_settings").update(data).eq("id", s.id);
    return { ok: true };
  });

export const getActivationStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    // "Hoje" = dia do calendário em Brasília (mesmo fuso da janela de envio).
    const iso = brtDayStart().toISOString();
    const [
      { data: lastRun },
      sms,
      email,
      call,
      wa,
      smsPending,
      emailPending,
      callPending,
      waPending,
    ] = await Promise.all([
      supabaseAdmin
        .from("activation_runs")
        .select("id, mode, status, totals, started_at, finished_at, error")
        .eq("tenant_id", tenantId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("sms_send_logs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("created_at", iso)
        .eq("status", "sent"),
      supabaseAdmin
        .from("email_send_logs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("created_at", iso),
      supabaseAdmin
        .from("call_history")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("created_at", iso),
      supabaseAdmin
        .from("flow_logs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("created_at", iso)
        .eq("event", "sent"),
      supabaseAdmin
        .from("sms_flow_leads")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "running"]),
      supabaseAdmin
        .from("email_flow_leads")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "running"]),
      supabaseAdmin
        .from("call_flow_progress")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["active", "waiting"]),
      supabaseAdmin
        .from("flow_leads")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "running"]),
    ]);
    return {
      lastRun,
      sentToday: {
        sms: sms.count ?? 0,
        email: email.count ?? 0,
        call: call.count ?? 0,
        whatsapp: wa.count ?? 0,
      },
      pending: {
        sms: smsPending.count ?? 0,
        email: emailPending.count ?? 0,
        call: callPending.count ?? 0,
        whatsapp: waPending.count ?? 0,
      },
    };
  });

/** Resumo operacional das automações legadas de SMS e e-mail. */
export const listAutomationJourneys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const [smsFlows, emailFlows] = await Promise.all([
      supabaseAdmin
        .from("sms_flows")
        .select("id, name, trigger_name, is_active, updated_at")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false }),
      supabaseAdmin
        .from("email_flows")
        .select("id, name, trigger_type, active, updated_at")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false }),
    ]);

    const smsIds = (smsFlows.data ?? []).map((flow) => flow.id);
    const emailIds = (emailFlows.data ?? []).map((flow) => flow.id);
    const [smsLeads, smsLogs, emailLeads, emailLogs] = await Promise.all([
      smsIds.length
        ? supabaseAdmin
            .from("sms_flow_leads")
            .select("flow_id, status")
            .eq("tenant_id", tenantId)
            .in("flow_id", smsIds)
        : Promise.resolve({ data: [] as Array<{ flow_id: string; status: string }> }),
      smsIds.length
        ? supabaseAdmin
            .from("sms_send_logs")
            .select("flow_id, status")
            .eq("tenant_id", tenantId)
            .in("flow_id", smsIds)
        : Promise.resolve({ data: [] as Array<{ flow_id: string | null; status: string | null }> }),
      emailIds.length
        ? supabaseAdmin
            .from("email_flow_leads")
            .select("flow_id, status")
            .eq("tenant_id", tenantId)
            .in("flow_id", emailIds)
        : Promise.resolve({ data: [] as Array<{ flow_id: string; status: string }> }),
      emailIds.length
        ? supabaseAdmin
            .from("email_send_logs")
            .select("flow_id, status")
            .eq("tenant_id", tenantId)
            .in("flow_id", emailIds)
        : Promise.resolve({ data: [] as Array<{ flow_id: string | null; status: string | null }> }),
    ]);

    type Counters = { queued: number; sent: number; failed: number; exited: number };
    const empty = (): Counters => ({ queued: 0, sent: 0, failed: 0, exited: 0 });
    const leadCounters = (rows: Array<{ flow_id: string; status: string }> | null) => {
      const counters = new Map<string, Counters>();
      for (const row of rows ?? []) {
        const counter = counters.get(row.flow_id) ?? empty();
        if (["pending", "running", "cooldown"].includes(row.status)) counter.queued++;
        if (row.status === "exited") counter.exited++;
        if (row.status === "failed") counter.failed++;
        counters.set(row.flow_id, counter);
      }
      return counters;
    };
    const addSendCounters = (
      counters: Map<string, Counters>,
      rows: Array<{ flow_id: string | null; status: string | null }> | null,
    ) => {
      for (const row of rows ?? []) {
        if (!row.flow_id) continue;
        const counter = counters.get(row.flow_id) ?? empty();
        const status = (row.status ?? "").toLowerCase();
        if (["sent", "delivered", "success"].includes(status)) counter.sent++;
        if (["failed", "error"].includes(status)) counter.failed++;
        counters.set(row.flow_id, counter);
      }
    };
    const smsCounters = leadCounters(smsLeads.data);
    const emailCounters = leadCounters(emailLeads.data);
    addSendCounters(smsCounters, smsLogs.data);
    addSendCounters(emailCounters, emailLogs.data);

    return {
      journeys: [
        ...(smsFlows.data ?? []).map((flow) => ({
          id: flow.id,
          channel: "sms" as const,
          name: flow.name,
          trigger: flow.trigger_name ?? "manual",
          active: flow.is_active,
          updated_at: flow.updated_at,
          counters: smsCounters.get(flow.id) ?? empty(),
        })),
        ...(emailFlows.data ?? []).map((flow) => ({
          id: flow.id,
          channel: "email" as const,
          name: flow.name,
          trigger: flow.trigger_type,
          active: flow.active,
          updated_at: flow.updated_at,
          counters: emailCounters.get(flow.id) ?? empty(),
        })),
      ],
    };
  });

export const listRecentRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { data } = await supabaseAdmin
      .from("activation_runs")
      .select("id, mode, status, totals, started_at, finished_at, error")
      .eq("tenant_id", tenantId)
      .order("started_at", { ascending: false })
      .limit(20);
    return { runs: data ?? [] };
  });

/** Resumo de prontidão da fila para a janela 06:00–22:00 BRT. */
export const getQueueReadiness = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const [
      smsPending,
      emailPending,
      callPending,
      waPending,
      lastRun,
      recentErrors,
      settings,
      sendWindow,
    ] = await Promise.all([
      supabaseAdmin
        .from("sms_flow_leads")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "running"]),
      supabaseAdmin
        .from("email_flow_leads")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "running"]),
      supabaseAdmin
        .from("call_flow_progress")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["active", "waiting"]),
      supabaseAdmin
        .from("flow_leads")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "running", "cooldown"]),
      supabaseAdmin
        .from("activation_runs")
        .select("id, mode, status, started_at, finished_at, error")
        .eq("tenant_id", tenantId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("activation_runs")
        .select("id, mode, started_at, error")
        .eq("tenant_id", tenantId)
        .not("error", "is", null)
        .order("started_at", { ascending: false })
        .limit(5),
      supabaseAdmin
        .from("automation_settings")
        .select("paused")
        .eq("tenant_id", tenantId)
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("send_window_settings")
        .select("start_minute, end_minute, timezone, enabled, weekdays")
        .eq("tenant_id", tenantId)
        .eq("singleton", true)
        .maybeSingle(),
    ]);

    const pending = {
      sms: smsPending.count ?? 0,
      email: emailPending.count ?? 0,
      call: callPending.count ?? 0,
      whatsapp: waPending.count ?? 0,
    };
    const totalPending = pending.sms + pending.email + pending.call + pending.whatsapp;

    // Próxima execução: dispatchers rodam a cada 1 min, orquestrador a cada 5 min.
    // Se já estiver dentro da janela, é "no próximo minuto". Caso contrário, calcula 06:00 BRT.
    const sw = sendWindow.data;
    const startMin = sw?.start_minute ?? 360;
    const endMin = sw?.end_minute ?? 1320;
    const tz = sw?.timezone ?? "America/Sao_Paulo";

    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
    const localMin = (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10);
    const insideWindow = localMin >= startMin && localMin < endMin;

    let nextRunAt: string;
    if (insideWindow) {
      // próxima execução: próximo minuto cheio
      const next = new Date(now);
      next.setSeconds(0, 0);
      next.setMinutes(next.getMinutes() + 1);
      nextRunAt = next.toISOString();
    } else {
      // próximo 06:00 no fuso BRT (offset fixo -03:00)
      const diff = startMin - localMin;
      const next = new Date(now.getTime() + (diff > 0 ? diff : diff + 1440) * 60_000);
      next.setSeconds(0, 0);
      nextRunAt = next.toISOString();
    }

    return {
      paused: !!settings.data?.paused,
      pending,
      totalPending,
      window: {
        start_minute: startMin,
        end_minute: endMin,
        timezone: tz,
        enabled: sw?.enabled ?? true,
      },
      insideWindow,
      nextRunAt,
      lastRun: lastRun.data ?? null,
      recentErrors: recentErrors.data ?? [],
      cronJobs: [
        { name: "Dispatchers (SMS/Email/Ligações/WhatsApp)", schedule: "a cada 1 min" },
        { name: "Orquestrador (ativação de leads)", schedule: "a cada 5 min" },
        { name: "Avaliação de gatilhos", schedule: "a cada 5 min" },
      ],
    };
  });
