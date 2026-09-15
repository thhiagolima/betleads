// Server functions para a UI ler/editar a janela de envio e ver pendentes.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const TimeSchema = z
  .string()
  .regex(/^\d{1,2}:\d{2}$/u, "Formato HH:MM");

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return Math.max(0, Math.min(24 * 60, h * 60 + m));
}

function fromMinutes(min: number): string {
  const h = Math.floor(min / 60).toString().padStart(2, "0");
  const m = (min % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

export const getSendWindowStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { getSendWindow, isWithinWindow, nextAllowedAt, invalidateSendWindowCache } =
      await import("./send-window.server");
    invalidateSendWindowCache();
    const settings = await getSendWindow(true);
    const now = new Date();
    const within = isWithinWindow(settings, now);
    const nextAt = within ? null : nextAllowedAt(settings, now).toISOString();

    // Pendentes fora da janela: leads de email/call cujo next_run_at é depois
    // do "fim da janela atual" (heurística: dentro das próximas 24h mas fora
    // do horário permitido). Para simplicidade contamos tudo agendado pra >= agora
    // mas com flag de fora-da-janela.
    const inOneDayIso = new Date(now.getTime() + 26 * 3600_000).toISOString();
    const [emailLeads, callProgress, scheduledCampaigns] = await Promise.all([
      supabase
        .from("email_flow_leads")
        .select("id,next_run_at", { count: "exact", head: false })
        .in("status", ["pending", "running"])
        .lte("next_run_at", inOneDayIso),
      supabase
        .from("call_flow_progress")
        .select("id,next_run_at", { count: "exact", head: false })
        .eq("status", "active")
        .lte("next_run_at", inOneDayIso),
      supabase
        .from("email_campaigns")
        .select("id,scheduled_at", { count: "exact", head: false })
        .eq("status", "agendada")
        .lte("scheduled_at", inOneDayIso),
    ]);

    const { isWithinWindow: w } = await import("./send-window.server");
    function countOutside(rows: Array<{ next_run_at?: string | null; scheduled_at?: string | null }> | null) {
      let outside = 0;
      let tomorrow = 0;
      for (const r of rows ?? []) {
        const ts = r.next_run_at ?? r.scheduled_at ?? null;
        if (!ts) continue;
        const d = new Date(ts);
        if (!w(settings, d)) {
          outside++;
          if (d.getTime() > now.getTime()) tomorrow++;
        }
      }
      return { outside, tomorrow };
    }

    const e = countOutside(emailLeads.data as any);
    const c = countOutside(callProgress.data as any);
    const cp = countOutside(scheduledCampaigns.data as any);

    // última execução = mais recente envio nos canais (email + sms)
    const [lastEmail, lastSms] = await Promise.all([
      supabase
        .from("email_send_logs")
        .select("sent_at,created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("sms_send_logs")
        .select("created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const candidates: number[] = [];
    const pushTs = (v: string | null | undefined) => {
      if (v) candidates.push(new Date(v).getTime());
    };
    pushTs(lastEmail.data?.sent_at ?? lastEmail.data?.created_at);
    pushTs(lastSms.data?.created_at);
    const lastRunAt = candidates.length ? new Date(Math.max(...candidates)).toISOString() : null;

    return {
      settings: {
        start: fromMinutes(settings.start_minute),
        end: fromMinutes(settings.end_minute),
        timezone: settings.timezone,
        weekdays: settings.weekdays,
        enabled: settings.enabled,
      },
      within_window: within,
      next_allowed_at: nextAt,
      pending: {
        outside_total: e.outside + c.outside + cp.outside,
        tomorrow_total: e.tomorrow + c.tomorrow + cp.tomorrow,
        by_channel: {
          email_flows: e,
          calls: c,
          email_campaigns: cp,
        },
      },
      last_run_at: lastRunAt,
    };
  });

const UpdateSchema = z.object({
  start: TimeSchema,
  end: TimeSchema,
  timezone: z.string().min(1).max(64),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  enabled: z.boolean(),
});

export const updateSendWindow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => UpdateSchema.parse(d))
  .handler(async ({ data, context }) => {
    const start_minute = toMinutes(data.start);
    const end_minute = toMinutes(data.end);
    if (start_minute >= end_minute) {
      throw new Error("O horário inicial deve ser menor que o final.");
    }
    const { error } = await context.supabase
      .from("send_window_settings")
      .update({
        start_minute,
        end_minute,
        timezone: data.timezone,
        weekdays: data.weekdays,
        enabled: data.enabled,
      })
      .eq("singleton", true);
    if (error) throw new Error(error.message);
    const { invalidateSendWindowCache } = await import("./send-window.server");
    invalidateSendWindowCache();
    return { ok: true };
  });