import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { detectAlerts, playerScore, retentionScore, riskScore, conversionScore } from "./player-rules";
import { lastActivityMs } from "./player-activity";

type DbRow = Record<string, any>;

type Input = {
  playerId: string;
};

export type PlayerDetail = {
  player: DbRow;
  metrics: {
    saldo_total: number;
    lucro: number;
    last_activity_at: string | null;
    days_since_activity: number | null;
    deposit_count: number;
    withdrawal_count: number;
    cashback_count: number;
    sms_sent: number;
    sms_delivered: number;
    sms_clicked: number;
    score: number;
    retention_score: number;
    risk_score: number;
    conversion_score: number;
  };
  attribution: DbRow | null;
  alerts: ReturnType<typeof detectAlerts>;
  deposits: DbRow[];
  withdrawals: DbRow[];
  cashbacks: DbRow[];
  smsLogs: DbRow[];
  sessions: DbRow[];
  events: DbRow[];
  followups: DbRow[];
  timeline: Array<{
    id: string;
    type: string;
    label: string;
    description: string | null;
    amount: number | null;
    status: string | null;
    at: string;
  }>;
  media: {
    source: string | null;
    campaign: string | null;
    creative: string | null;
    ad_id: string | null;
    spend_estimate: number | null;
    spend_basis: "ad" | "campaign" | null;
    impressions: number | null;
    clicks: number | null;
    result: number | null;
  };
};

export const getPlayerDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Input) => data)
  .handler(async ({ data, context }): Promise<PlayerDetail> => {
    const supabase = context.supabase as any;
    const { playerId } = data;
    if (!playerId) throw new Error("Player nao informado.");

    const { data: player, error: playerError } = await supabase
      .from("players")
      .select("*")
      .eq("id", playerId)
      .single();

    if (playerError) throw new Error(playerError.message);
    if (!player) throw new Error("Player nao encontrado.");

    const tenantId = player.tenant_id as string;
    const since90 = new Date(Date.now() - 90 * 86400000).toISOString();

    const [
      depositsRes,
      withdrawalsRes,
      cashbacksRes,
      smsLogsRes,
      sessionsRes,
      eventsRes,
      followupsRes,
      attributionsRes,
      mediaRes,
    ] = await Promise.all([
      supabase
        .from("deposits")
        .select("id, created_at, valor, status, metodo, external_id")
        .eq("tenant_id", tenantId)
        .eq("player_id", playerId)
        .order("created_at", { ascending: false })
        .limit(80),
      supabase
        .from("withdrawals")
        .select("id, created_at, valor, status, metodo, external_id")
        .eq("tenant_id", tenantId)
        .eq("player_id", playerId)
        .order("created_at", { ascending: false })
        .limit(80),
      supabase
        .from("cashback_payments")
        .select("id, paid_at, created_at, cashback_amount, status, campaign, event_id")
        .eq("tenant_id", tenantId)
        .eq("player_id", playerId)
        .order("paid_at", { ascending: false })
        .limit(80),
      supabase
        .from("sms_send_logs")
        .select("id, created_at, delivered_at, status, delivery_status, trigger_name, content, error, provider, to_phone")
        .eq("tenant_id", tenantId)
        .eq("player_id", playerId)
        .order("created_at", { ascending: false })
        .limit(80),
      supabase
        .from("sessions")
        .select("id, iniciado_em, encerrado_em, duracao_segundos")
        .eq("tenant_id", tenantId)
        .eq("player_id", playerId)
        .order("iniciado_em", { ascending: false })
        .limit(50),
      supabase
        .from("events")
        .select("id, created_at, tipo, valor, metadata")
        .eq("tenant_id", tenantId)
        .eq("player_id", playerId)
        .order("created_at", { ascending: false })
        .limit(80),
      supabase
        .from("lead_followups")
        .select("id, created_at, alerta_tipo, acao, notes")
        .eq("tenant_id", tenantId)
        .eq("player_id", playerId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("player_attributions")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("player_id", playerId)
        .order("captured_at", { ascending: false })
        .limit(10),
      supabase
        .from("marketing_ad_metrics_daily")
        .select("campaign_name, ad_id, ad_name, creative_name, spend, impressions, clicks, metric_date")
        .eq("tenant_id", tenantId)
        .gte("metric_date", since90)
        .limit(20000),
    ]);

    const required = [
      depositsRes,
      withdrawalsRes,
      cashbacksRes,
      smsLogsRes,
      sessionsRes,
      eventsRes,
      followupsRes,
    ];
    for (const res of required) {
      if (res.error) throw new Error(res.error.message);
    }

    const deposits = (depositsRes.data ?? []) as DbRow[];
    const withdrawals = (withdrawalsRes.data ?? []) as DbRow[];
    const cashbacks = (cashbacksRes.data ?? []) as DbRow[];
    const smsLogs = (smsLogsRes.data ?? []) as DbRow[];
    const sessions = (sessionsRes.data ?? []) as DbRow[];
    const events = (eventsRes.data ?? []) as DbRow[];
    const followups = (followupsRes.data ?? []) as DbRow[];
    const attribution = ((attributionsRes.data ?? []) as DbRow[])[0] ?? null;
    const mediaRows = (mediaRes.data ?? []) as DbRow[];

    const importedDepositCount = Number(
      attribution?.raw_payload?.normalized?.depositos ?? attribution?.raw_payload?.raw?.depositos ?? 0,
    );
    const approvedDepositCount = deposits.filter((d) => !d.status || d.status === "aprovado").length;
    const depositCount = Math.max(approvedDepositCount, importedDepositCount || 0);
    const lastActivity = lastActivityMs(player);
    const media = summarizeMedia(player, attribution, mediaRows);
    const timeline = buildTimeline({ deposits, withdrawals, cashbacks, smsLogs, sessions, events, followups });

    return {
      player,
      metrics: {
        saldo_total: Number(player.saldo_carteira ?? 0) + Number(player.saldo_bonus ?? 0),
        lucro: Number(player.total_depositado ?? 0) - Number(player.total_sacado ?? 0),
        last_activity_at: lastActivity ? new Date(lastActivity).toISOString() : null,
        days_since_activity: lastActivity ? Math.floor((Date.now() - lastActivity) / 86400000) : null,
        deposit_count: depositCount,
        withdrawal_count: withdrawals.length,
        cashback_count: cashbacks.length,
        sms_sent: smsLogs.length,
        sms_delivered: smsLogs.filter((s) => ["delivered", "delivered_to_operator", "sent"].includes(String(s.delivery_status ?? s.status))).length,
        sms_clicked: events.filter((e) => String(e.tipo ?? "").toLowerCase().includes("click")).length,
        score: playerScore(player),
        retention_score: retentionScore(player),
        risk_score: riskScore(player),
        conversion_score: conversionScore(player),
      },
      attribution,
      alerts: detectAlerts(player),
      deposits,
      withdrawals,
      cashbacks,
      smsLogs,
      sessions,
      events,
      followups,
      timeline,
      media,
    };
  });

function keyOf(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function summarizeMedia(player: DbRow, attribution: DbRow | null, rows: DbRow[]): PlayerDetail["media"] {
  const source = attribution?.utm_source ?? player.utm_source ?? player.origem ?? null;
  const campaign = attribution?.utm_campaign ?? player.utm_campaign ?? null;
  const creative = attribution?.utm_content ?? player.utm_content ?? null;
  const adId = attribution?.utm_id ?? player.utm_id ?? null;
  const adIdKey = keyOf(adId);
  const creativeKey = keyOf(creative);
  const campaignKey = keyOf(campaign);

  let adSpend = 0;
  let adImpressions = 0;
  let adClicks = 0;
  let campaignSpend = 0;
  let campaignImpressions = 0;
  let campaignClicks = 0;

  for (const row of rows) {
    const rowAdKeys = [row.ad_id, row.ad_name, row.creative_name].map(keyOf);
    const rowCampaignKey = keyOf(row.campaign_name);
    const spend = Number(row.spend ?? 0);
    const impressions = Number(row.impressions ?? 0);
    const clicks = Number(row.clicks ?? 0);

    if ((adIdKey && rowAdKeys.includes(adIdKey)) || (creativeKey && rowAdKeys.includes(creativeKey))) {
      adSpend += spend;
      adImpressions += impressions;
      adClicks += clicks;
    }
    if (campaignKey && rowCampaignKey === campaignKey) {
      campaignSpend += spend;
      campaignImpressions += impressions;
      campaignClicks += clicks;
    }
  }

  const basis = adSpend > 0 ? "ad" : campaignSpend > 0 ? "campaign" : null;
  const spend = basis === "ad" ? adSpend : basis === "campaign" ? campaignSpend : null;
  const impressions = basis === "ad" ? adImpressions : basis === "campaign" ? campaignImpressions : null;
  const clicks = basis === "ad" ? adClicks : basis === "campaign" ? campaignClicks : null;

  return {
    source,
    campaign,
    creative,
    ad_id: adId,
    spend_estimate: spend,
    spend_basis: basis,
    impressions,
    clicks,
    result: spend == null ? null : Number(player.total_depositado ?? 0) - spend,
  };
}

function buildTimeline(args: {
  deposits: DbRow[];
  withdrawals: DbRow[];
  cashbacks: DbRow[];
  smsLogs: DbRow[];
  sessions: DbRow[];
  events: DbRow[];
  followups: DbRow[];
}): PlayerDetail["timeline"] {
  const items: PlayerDetail["timeline"] = [];

  for (const d of args.deposits) {
    items.push({
      id: `deposit:${d.id}`,
      type: "deposit",
      label: "Depositou",
      description: d.metodo ?? d.external_id ?? null,
      amount: Number(d.valor ?? 0),
      status: d.status ?? null,
      at: d.created_at,
    });
  }
  for (const w of args.withdrawals) {
    items.push({
      id: `withdrawal:${w.id}`,
      type: "withdrawal",
      label: "Sacou",
      description: w.metodo ?? w.external_id ?? null,
      amount: Number(w.valor ?? 0),
      status: w.status ?? null,
      at: w.created_at,
    });
  }
  for (const c of args.cashbacks) {
    items.push({
      id: `cashback:${c.id}`,
      type: "cashback",
      label: "Cashback pago",
      description: c.campaign ?? c.event_id ?? null,
      amount: Number(c.cashback_amount ?? 0),
      status: c.status ?? null,
      at: c.paid_at ?? c.created_at,
    });
  }
  for (const sms of args.smsLogs) {
    items.push({
      id: `sms:${sms.id}`,
      type: "sms",
      label: sms.trigger_name ? `SMS - ${sms.trigger_name}` : "SMS enviado",
      description: sms.content ?? sms.error ?? null,
      amount: null,
      status: sms.delivery_status ?? sms.status ?? null,
      at: sms.delivered_at ?? sms.created_at,
    });
  }
  for (const session of args.sessions) {
    items.push({
      id: `session:${session.id}`,
      type: "session",
      label: "Login",
      description: session.duracao_segundos ? `${session.duracao_segundos}s de sessao` : null,
      amount: null,
      status: null,
      at: session.iniciado_em,
    });
  }
  for (const event of args.events) {
    items.push({
      id: `event:${event.id}`,
      type: "event",
      label: String(event.tipo ?? "Evento"),
      description: describeMetadata(event.metadata),
      amount: event.valor == null ? null : Number(event.valor),
      status: null,
      at: event.created_at,
    });
  }
  for (const followup of args.followups) {
    items.push({
      id: `followup:${followup.id}`,
      type: "followup",
      label: `Follow-up - ${followup.alerta_tipo ?? "contato"}`,
      description: followup.notes ?? followup.acao ?? null,
      amount: null,
      status: followup.acao ?? null,
      at: followup.created_at,
    });
  }

  return items
    .filter((item) => item.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 80);
}

function describeMetadata(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const first =
    record.message ??
    record.description ??
    record.event ??
    record.campaign ??
    record.trigger_name ??
    record.status;
  if (first) return String(first);
  const keys = Object.keys(record).slice(0, 3);
  return keys.length ? keys.join(", ") : null;
}
