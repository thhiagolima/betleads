// Server function: agrega dados em tempo real para a Dashboard do WhatsApp.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { readResetAtAdmin } from "@/lib/dashboard-settings.functions";

export type WhatsappDashboard = {
  totals_today: {
    sent: number;
    delivered: number;
    failed: number;
    received: number;
    delivery_rate: number;
  };
  last_hour: { sent: number };
  conversions_today: { count: number; rate: number };
  hot_leads: number;
  sessions: {
    total: number;
    active: number;
    queue_pending: number;
    items: Array<{
      id: string;
      name: string;
      status: string;
      messages_sent_today: number;
      daily_limit: number;
      health_score: number | null;
    }>;
  };
  flows_performance: Array<{
    flow_id: string;
    name: string;
    sent_today: number;
    failed_today: number;
  }>;
  by_hour: Array<{ hour: string; sent: number }>; // 24 buckets, oldest first
  generated_at: string;
  period: { from: string; to: string };
};

function startOfDayLocalISO(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
}

function endOfDayLocalISO(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.toISOString();
}

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

const RangeSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .optional()
  .default({});

export const getWhatsappDashboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => RangeSchema.parse(input ?? {}))
  .handler(async ({ context, data }): Promise<WhatsappDashboard> => {
    const { supabase } = context;
    const todayRef = new Date();
    const fromDate = data?.from ? parseLocalDate(data.from) : todayRef;
    const toDate = data?.to ? parseLocalDate(data.to) : todayRef;
    const periodStartISO0 = startOfDayLocalISO(fromDate);
    const periodEndISO = endOfDayLocalISO(toDate);
    const resetAt = await readResetAtAdmin();
    const max = (a: string, b: string) => (a > b ? a : b);
    const todayISO = max(periodStartISO0, resetAt);
    const lastHourISO = max(new Date(Date.now() - 60 * 60 * 1000).toISOString(), resetAt);
    const last24hISO = max(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), resetAt);
    const last72hISO = max(new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(), resetAt);

    // Mensagens no período (apenas campos necessários)
    const { data: msgsToday } = await supabase
      .from("whatsapp_messages")
      .select("id,from_me,status,created_at,chat_id,session_id")
      .gte("created_at", todayISO)
      .lte("created_at", periodEndISO)
      .limit(10000);

    const msgs = msgsToday ?? [];
    const outbound = msgs.filter((m: any) => m.from_me === true);
    const inbound = msgs.filter((m: any) => m.from_me === false);
    const delivered = outbound.filter((m: any) =>
      ["delivered", "read", "received", "DELIVERY_ACK", "READ"].includes(String(m.status ?? "")),
    ).length;
    const failed = outbound.filter((m: any) =>
      ["failed", "error", "ERROR"].includes(String(m.status ?? "")),
    ).length;
    const sentLastHour = outbound.filter((m: any) => m.created_at >= lastHourISO).length;

    // 24 buckets horários
    const buckets: Array<{ hour: string; sent: number }> = [];
    const nowHour = new Date();
    nowHour.setMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) {
      const start = new Date(nowHour.getTime() - i * 60 * 60 * 1000);
      buckets.push({ hour: start.toISOString(), sent: 0 });
    }
    // contar mensagens nas últimas 24h (incluindo as de hoje + dia anterior recentes)
    const { data: msgs24 } = await supabase
      .from("whatsapp_messages")
      .select("created_at,from_me")
      .gte("created_at", last24hISO)
      .eq("from_me", true)
      .limit(20000);
    for (const m of msgs24 ?? []) {
      const t = new Date(m.created_at as string).getTime();
      const idx = 23 - Math.floor((nowHour.getTime() + 60 * 60 * 1000 - t) / (60 * 60 * 1000));
      if (idx >= 0 && idx < 24) buckets[idx].sent += 1;
    }

    // Sessões
    const { data: sessRows } = await supabase
      .from("whatsapp_sessions")
      .select("id,name,status,messages_sent_today,daily_limit,health_score,queue_pending,is_active");
    const sessions = sessRows ?? [];
    const activeSessions = sessions.filter((s: any) => s.status === "connected").length;
    const queuePending = sessions.reduce((a: number, s: any) => a + (s.queue_pending ?? 0), 0);

    // Se o período começa após o início do dia real (reset hoje OU range
    // diferente de "hoje"), recalcula messages_sent_today por sessão
    // contando outbound em whatsapp_messages dentro do período.
    const realTodayStart0 = startOfDayLocalISO(new Date());
    const sessSentSinceReset = new Map<string, number>();
    if (todayISO !== realTodayStart0) {
      for (const m of msgs) {
        if (!m.from_me) continue;
        const sid = (m as any).session_id as string | null;
        if (!sid) continue;
        sessSentSinceReset.set(sid, (sessSentSinceReset.get(sid) ?? 0) + 1);
      }
    }

    // Hot leads = chats com unread_count>0 nas últimas 24h
    const { count: hotLeadsCount } = await supabase
      .from("whatsapp_chats")
      .select("id", { count: "exact", head: true })
      .gt("unread_count", 0)
      .gte("last_message_at", last24hISO);

    // Performance por fluxo (via flow_logs)
    const { data: flowLogsToday } = await supabase
      .from("flow_logs")
      .select("flow_id,event,created_at")
      .gte("created_at", todayISO)
      .lte("created_at", periodEndISO)
      .in("event", ["sent", "failed"])
      .limit(20000);
    const flowAgg = new Map<string, { sent: number; failed: number }>();
    for (const l of flowLogsToday ?? []) {
      if (!l.flow_id) continue;
      const cur = flowAgg.get(l.flow_id as string) ?? { sent: 0, failed: 0 };
      if (l.event === "sent") cur.sent += 1;
      else if (l.event === "failed") cur.failed += 1;
      flowAgg.set(l.flow_id as string, cur);
    }
    let flowsPerformance: WhatsappDashboard["flows_performance"] = [];
    if (flowAgg.size > 0) {
      const ids = Array.from(flowAgg.keys());
      const { data: flowRows } = await supabase
        .from("flows")
        .select("id,name")
        .in("id", ids);
      flowsPerformance = (flowRows ?? []).map((f: any) => ({
        flow_id: f.id,
        name: f.name ?? "Fluxo",
        sent_today: flowAgg.get(f.id)?.sent ?? 0,
        failed_today: flowAgg.get(f.id)?.failed ?? 0,
      }));
      flowsPerformance.sort((a, b) => b.sent_today - a.sent_today);
    }

    // Conversões: depósitos no período cujo player teve chat WhatsApp nas últimas 72h
    let conversionsCount = 0;
    try {
      const { data: chatsRecent } = await supabase
        .from("whatsapp_chats")
        .select("phone")
        .gte("last_message_at", last72hISO)
        .limit(10000);
      const phones = Array.from(
        new Set(
          (chatsRecent ?? [])
            .map((c: any) => (c.phone ? String(c.phone).replace(/\D/g, "") : null))
            .filter(Boolean) as string[],
        ),
      );
      if (phones.length > 0) {
        const { data: playerRows } = await supabase
          .from("players")
          .select("id,telefone")
          .in("telefone", phones.slice(0, 1000));
        const playerIds = (playerRows ?? []).map((p: any) => p.id);
        if (playerIds.length > 0) {
          const { count } = await supabase
            .from("deposits")
            .select("id", { count: "exact", head: true })
            .gte("created_at", todayISO)
            .lte("created_at", periodEndISO)
            .in("player_id", playerIds);
          conversionsCount = count ?? 0;
        }
      }
    } catch {
      conversionsCount = 0;
    }

    const sentTotal = outbound.length;
    const deliveryRate = sentTotal > 0 ? (delivered / sentTotal) * 100 : 0;
    const conversionRate = sentTotal > 0 ? (conversionsCount / sentTotal) * 100 : 0;

    return {
      totals_today: {
        sent: sentTotal,
        delivered,
        failed,
        received: inbound.length,
        delivery_rate: Number(deliveryRate.toFixed(1)),
      },
      last_hour: { sent: sentLastHour },
      conversions_today: { count: conversionsCount, rate: Number(conversionRate.toFixed(1)) },
      hot_leads: hotLeadsCount ?? 0,
      sessions: {
        total: sessions.length,
        active: activeSessions,
        queue_pending: queuePending,
        items: sessions.map((s: any) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          messages_sent_today: sessSentSinceReset.size > 0
            ? (sessSentSinceReset.get(s.id) ?? 0)
            : (s.messages_sent_today ?? 0),
          daily_limit: s.daily_limit ?? 0,
          health_score: s.health_score ?? null,
        })),
      },
      flows_performance: flowsPerformance,
      by_hour: buckets,
      generated_at: new Date().toISOString(),
      period: { from: periodStartISO0, to: periodEndISO },
    };
  });