import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Histórico unificado dos canais BETLEADS (WhatsApp, SMS, Email, Ligações).
 * Somente leitura. Não toca em nenhuma lógica de envio.
 */

export type ChannelKey = "sms" | "email" | "calls" | "whatsapp";
export type StatusColor = "green" | "yellow" | "red" | "blue" | "gray";

export interface HistoryRow {
  id: string;
  created_at: string;
  channel: ChannelKey;
  player_id: string | null;
  lead_name: string | null;
  contact: string;
  message: string | null;
  template: string | null;
  flow_id: string | null;
  flow_name: string | null;
  step: string | null;
  status_raw: string;
  status_label: string;
  status_color: StatusColor;
  error: string | null;
  converted: boolean;
  attempts: number;
  provider_id: string | null;
  provider_response: any;
}

export interface HistoryStats {
  total: number;
  success: number;
  failed: number;
  pending: number;
  conversions: number;
  deliveryRate: number; // 0..100
  lastDispatchAt: string | null;
  prevTotal: number; // mesma janela imediatamente anterior
}

const ChannelEnum = z.enum(["sms", "email", "calls", "whatsapp"]);

const HistoryInput = z.object({
  channel: ChannelEnum,
  from: z.string().datetime().optional().nullable(),
  to: z.string().datetime().optional().nullable(),
  flowId: dbUuid().optional().nullable(),
  step: z.string().max(80).optional().nullable(),
  status: z.enum(["all", "green", "yellow", "red", "blue", "gray"]).optional().default("all"),
  // WhatsApp-only: direction toggle
  direction: z.enum(["all", "outgoing", "incoming"]).optional().default("outgoing"),
  search: z.string().max(120).optional().nullable(),
  page: z.number().int().min(0).default(0),
  pageSize: z.number().int().min(1).max(100).default(50),
});

// ============================================================
// Status mapping per channel
// ============================================================

function mapStatus(channel: ChannelKey, raw: string | null, extra?: string | null): {
  color: StatusColor;
  label: string;
} {
  const r = (raw ?? "").toLowerCase();
  const e = (extra ?? "").toLowerCase();
  // delivery wins over base status
  if (e === "delivered" || e === "entregue") return { color: "green", label: "Entregue" };
  if (e === "failed") return { color: "red", label: "Falhou" };

  switch (r) {
    case "delivered":
    case "entregue":
    case "sent":
    case "enviado":
      return { color: "green", label: r === "delivered" || r === "entregue" ? "Entregue" : "Enviado" };
    case "answered":
      return { color: "green", label: "Atendida" };
    case "completed":
      return { color: "green", label: "Concluída" };
    case "converted":
      return { color: "green", label: "Convertida" };
    case "pending":
    case "agendada":
      return { color: "yellow", label: "Pendente" };
    case "retry":
    case "em_retry":
      return { color: "yellow", label: "Em retry" };
    case "fora_da_janela":
      return { color: "yellow", label: "Fora da janela" };
    case "calling":
    case "processing":
    case "enviando":
    case "queued":
      return { color: "blue", label: r === "calling" ? "Ligando" : "Processando" };
    case "not_answered":
      return { color: "red", label: "Não atendida" };
    case "busy":
      return { color: "red", label: "Ocupado" };
    case "failed":
    case "error":
    case "erro":
      return { color: "red", label: "Falhou" };
    case "cancelled":
    case "canceled":
      return { color: "gray", label: "Cancelada" };
    default:
      return { color: "gray", label: raw ?? "—" };
  }
}

function matchesStatusFilter(color: StatusColor, filter: string): boolean {
  if (!filter || filter === "all") return true;
  return color === filter;
}

// ============================================================
// Helpers
// ============================================================

function previewText(s: string | null | undefined, n = 80): string | null {
  if (!s) return null;
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

async function enrichConversions(
  supabase: any,
  rows: HistoryRow[],
): Promise<HistoryRow[]> {
  const playerIds = Array.from(
    new Set(rows.map((r) => r.player_id).filter((x): x is string => !!x)),
  );
  if (playerIds.length === 0) return rows;
  // Pega depósitos aprovados nos últimos 30 dias para todos os players da página
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: deps } = await supabase
    .from("deposits")
    .select("player_id, created_at, status")
    .in("player_id", playerIds)
    .gte("created_at", since)
    .eq("status", "aprovado");
  const byPlayer = new Map<string, number[]>();
  for (const d of deps ?? []) {
    const arr = byPlayer.get(d.player_id as string) ?? [];
    arr.push(Date.parse(d.created_at as string));
    byPlayer.set(d.player_id as string, arr);
  }
  return rows.map((row) => {
    if (!row.player_id) return row;
    const ts = byPlayer.get(row.player_id);
    if (!ts) return row;
    const sent = Date.parse(row.created_at);
    const hit = ts.some((t) => t >= sent && t - sent <= 72 * 3600 * 1000);
    return hit ? { ...row, converted: true } : row;
  });
}

// ============================================================
// Main: getChannelHistory
// ============================================================

export const getChannelHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => HistoryInput.parse(d))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const { channel } = data;
    const from = data.page * data.pageSize;
    const to = from + data.pageSize - 1;
    const search = data.search?.trim() ?? "";

    let rows: HistoryRow[] = [];
    let total = 0;

    if (channel === "sms") {
      let q = sb
        .from("sms_send_logs")
        .select(
          "id, to_phone, content, status, delivery_status, error, trigger_name, step_index, step_label, flow_lead_id, flow_id, player_id, provider_message_id, provider_response, created_at, players:players!sms_send_logs_player_id_fkey(nome), flow:sms_flows(name)",
          { count: "exact" },
        )
        .order("created_at", { ascending: false });
      if (data.from) q = q.gte("created_at", data.from);
      if (data.to) q = q.lte("created_at", data.to);
      if (data.flowId) q = q.eq("flow_id", data.flowId);
      if (data.step) q = q.or(`step_label.eq.${data.step},trigger_name.eq.${data.step}`);
      if (search)
        q = q.or(
          `to_phone.ilike.%${search}%,content.ilike.%${search}%,trigger_name.ilike.%${search}%`,
        );
      const { data: rs, count, error } = await q.range(from, to);
      if (error) throw new Error(error.message);
      total = count ?? 0;
      rows = (rs ?? []).map((r: any) => {
        const s = mapStatus("sms", r.status, r.delivery_status);
        return {
          id: r.id,
          created_at: r.created_at,
          channel: "sms" as const,
          player_id: r.player_id,
          lead_name: r.players?.nome ?? null,
          contact: r.to_phone ?? "—",
          message: previewText(r.content),
          template: r.trigger_name ?? null,
          flow_id: r.flow_id ?? null,
          flow_name: r.flow?.name ?? null,
          step: r.step_label ?? r.trigger_name ?? null,
          status_raw: r.delivery_status ?? r.status ?? "",
          status_label: s.label,
          status_color: s.color,
          error: r.error ?? null,
          converted: false,
          attempts: 1,
          provider_id: r.provider_message_id ?? null,
          provider_response: r.provider_response ?? null,
        };
      });
    } else if (channel === "email") {
      let q = sb
        .from("email_send_logs")
        .select(
          "id, to_email, subject, status, error, automation_id, campaign_id, flow_id, block_index, step_label, flow_lead_id, player_id, provider_response, created_at, sent_at, players:players!email_send_logs_player_id_fkey(nome), automation:email_automations(name), flow:email_flows(name)",
          { count: "exact" },
        )
        .order("created_at", { ascending: false });
      if (data.from) q = q.gte("created_at", data.from);
      if (data.to) q = q.lte("created_at", data.to);
      if (data.flowId)
        q = q.or(`flow_id.eq.${data.flowId},automation_id.eq.${data.flowId}`);
      if (data.step) q = q.eq("step_label", data.step);
      if (search)
        q = q.or(`to_email.ilike.%${search}%,subject.ilike.%${search}%`);
      const { data: rs, count, error } = await q.range(from, to);
      if (error) throw new Error(error.message);
      total = count ?? 0;
      rows = (rs ?? []).map((r: any) => {
        const s = mapStatus("email", r.status, null);
        return {
          id: r.id,
          created_at: r.created_at,
          channel: "email" as const,
          player_id: r.player_id,
          lead_name: r.players?.nome ?? null,
          contact: r.to_email ?? "—",
          message: previewText(r.subject),
          template: r.subject ?? null,
          flow_id: r.flow_id ?? r.automation_id ?? null,
          flow_name: r.flow?.name ?? r.automation?.name ?? null,
          step: r.step_label ?? null,
          status_raw: r.status ?? "",
          status_label: s.label,
          status_color: s.color,
          error: r.error ?? null,
          converted: false,
          attempts: 1,
          provider_id: null,
          provider_response: r.provider_response ?? null,
        };
      });
    } else if (channel === "calls") {
      let q = sb
        .from("call_history")
        .select(
          "id, to_phone, status, error_message, provider, provider_call_id, provider_response, duration_seconds, audio_url, recording_url, lead_id, script_id, call_queue_id, created_at, players:players!call_history_lead_id_fkey(nome)",
          { count: "exact" },
        )
        .order("created_at", { ascending: false });
      if (data.from) q = q.gte("created_at", data.from);
      if (data.to) q = q.lte("created_at", data.to);
      if (search) q = q.ilike("to_phone", `%${search}%`);
      const { data: rs, count, error } = await q.range(from, to);
      if (error) throw new Error(error.message);
      total = count ?? 0;
      // Resolve flow_name via call_flow_executions(call_queue_id)
      const queueIds = Array.from(
        new Set((rs ?? []).map((r: any) => r.call_queue_id).filter(Boolean)),
      );
      const flowByQueue = new Map<string, { flow_id: string; flow_name: string | null }>();
      if (queueIds.length) {
        const { data: execs } = await sb
          .from("call_flow_executions")
          .select("call_queue_id, flow_id, flow:call_flows(name)")
          .in("call_queue_id", queueIds);
        for (const e of execs ?? []) {
          flowByQueue.set(e.call_queue_id as string, {
            flow_id: e.flow_id as string,
            flow_name: (e as any).flow?.name ?? null,
          });
        }
      }
      rows = (rs ?? []).map((r: any) => {
        const s = mapStatus("calls", r.status, null);
        const flowInfo = r.call_queue_id ? flowByQueue.get(r.call_queue_id) : undefined;
        return {
          id: r.id,
          created_at: r.created_at,
          channel: "calls" as const,
          player_id: r.lead_id,
          lead_name: r.players?.nome ?? null,
          contact: r.to_phone ?? "—",
          message: r.duration_seconds ? `${r.duration_seconds}s` : null,
          template: r.provider ?? null,
          flow_id: flowInfo?.flow_id ?? null,
          flow_name: flowInfo?.flow_name ?? null,
          step: null,
          status_raw: r.status ?? "",
          status_label: s.label,
          status_color: s.color,
          error: r.error_message ?? null,
          converted: false,
          attempts: 1,
          provider_id: r.provider_call_id ?? null,
          provider_response: r.provider_response ?? null,
        };
      });
      // post-filter by flow if requested
      if (data.flowId) rows = rows.filter((r) => r.flow_id === data.flowId);
    } else {
      // whatsapp — direção controlada pelo filtro (default: outgoing)
      let q = sb
        .from("whatsapp_messages")
        .select(
          "id, text, status, from_me, message_timestamp, message_type, remote_jid, evolution_message_id, chat:whatsapp_chats!whatsapp_messages_chat_id_fkey(phone, name)",
          { count: "exact" },
        )
        .order("message_timestamp", { ascending: false });
      if (data.direction === "outgoing") q = q.eq("from_me", true);
      else if (data.direction === "incoming") q = q.eq("from_me", false);
      if (data.from) q = q.gte("message_timestamp", data.from);
      if (data.to) q = q.lte("message_timestamp", data.to);
      if (search) q = q.or(`text.ilike.%${search}%,remote_jid.ilike.%${search}%`);
      const { data: rs, count, error } = await q.range(from, to);
      if (error) throw new Error(error.message);
      total = count ?? 0;
      const phones = Array.from(
        new Set(
          (rs ?? [])
            .map((r: any) => r.chat?.phone)
            .filter((p: any): p is string => !!p),
        ),
      );
      const playerByPhone = new Map<string, { id: string; nome: string | null }>();
      if (phones.length) {
        const { data: pls } = await (sb as any)
          .from("players")
          .select("id, nome, telefone")
          .in("telefone", phones);
        for (const p of pls ?? []) {
          if (p.telefone) playerByPhone.set(p.telefone as string, { id: p.id, nome: p.nome });
        }
      }
      rows = (rs ?? []).map((r: any) => {
        const s = mapStatus("whatsapp", r.status, null);
        const phone = r.chat?.phone as string | null;
        const pl = phone ? playerByPhone.get(phone) : undefined;
        return {
          id: r.id,
          created_at: r.message_timestamp,
          channel: "whatsapp" as const,
          player_id: pl?.id ?? null,
          lead_name: pl?.nome ?? r.chat?.name ?? null,
          contact: phone ?? r.remote_jid ?? "—",
          message: previewText(r.text),
          template: r.message_type ?? null,
          flow_id: null,
          flow_name: null,
          step: null,
          status_raw: r.status ?? "",
          status_label: s.label,
          status_color: s.color,
          error: null,
          converted: false,
          attempts: 1,
          provider_id: r.evolution_message_id ?? null,
          provider_response: null,
        };
      });
    }

    // status color filter (post)
    if (data.status && data.status !== "all") {
      rows = rows.filter((r) => matchesStatusFilter(r.status_color, data.status as string));
    }

    rows = await enrichConversions(sb, rows);
    return { rows, total };
  });

// ============================================================
// Stats (cards)
// ============================================================

const StatsInput = z.object({
  channel: ChannelEnum,
  from: z.string().datetime().optional().nullable(),
  to: z.string().datetime().optional().nullable(),
});

/** Configuração por canal: nome do timestamp + buckets de status. */
const CHANNEL_CFG: Record<ChannelKey, {
  table: string;
  tsCol: string;
  // Função que recebe o objeto { status, delivery_status } da linha e devolve "success"|"failed"|"pending"|null
  bucket: (row: any) => "success" | "failed" | "pending" | null;
  selectCols: string;
}> = {
  sms: {
    table: "sms_send_logs",
    tsCol: "created_at",
    selectCols: "status, delivery_status, created_at",
    bucket: (r) => {
      const ds = (r.delivery_status ?? "").toLowerCase();
      const s = (r.status ?? "").toLowerCase();
      if (ds === "delivered" || ds === "entregue") return "success";
      if (ds === "failed" || s === "error" || s === "erro") return "failed";
      if (s === "sent" || s === "enviado") return "success";
      if (s === "pending" || s === "queued" || s === "processing") return "pending";
      return null;
    },
  },
  email: {
    table: "email_send_logs",
    tsCol: "created_at",
    selectCols: "status, created_at",
    bucket: (r) => {
      const s = (r.status ?? "").toLowerCase();
      if (s === "sent" || s === "delivered" || s === "enviado" || s === "entregue") return "success";
      if (s === "error" || s === "failed" || s === "erro" || s === "dlq") return "failed";
      if (s === "pending" || s === "agendada" || s === "enviando" || s === "queued") return "pending";
      return null;
    },
  },
  calls: {
    table: "call_history",
    tsCol: "created_at",
    selectCols: "status, created_at",
    bucket: (r) => {
      const s = (r.status ?? "").toLowerCase();
      if (s === "answered" || s === "completed" || s === "converted") return "success";
      if (s === "failed" || s === "not_answered" || s === "busy" || s === "error") return "failed";
      if (s === "pending" || s === "calling" || s === "queued") return "pending";
      return null;
    },
  },
  whatsapp: {
    table: "whatsapp_messages",
    tsCol: "message_timestamp",
    selectCols: "status, message_timestamp",
    bucket: (r) => {
      const s = (r.status ?? "").toLowerCase();
      if (s === "sent" || s === "delivered" || s === "read") return "success";
      if (s === "failed" || s === "error") return "failed";
      if (!s || s === "pending" || s === "queued") return "pending";
      return null;
    },
  },
};

async function fetchStatusRows(
  sb: any,
  channel: ChannelKey,
  fromIso: string,
  toIso: string,
): Promise<any[]> {
  const cfg = CHANNEL_CFG[channel];
  // Página única, sem paginar — limitada a 50k linhas (suficiente p/ janelas de 30d).
  const { data, error } = await sb
    .from(cfg.table)
    .select(cfg.selectCols)
    .gte(cfg.tsCol, fromIso)
    .lte(cfg.tsCol, toIso)
    .order(cfg.tsCol, { ascending: false })
    .limit(50000);
  if (error) {
    console.error("[history.stats]", channel, error.message);
    return [];
  }
  return data ?? [];
}

export const getChannelHistoryStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => StatsInput.parse(d))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dayIso = startOfDay.toISOString();
    const fromIso = data.from ?? dayIso;
    const toIso = data.to ?? new Date().toISOString();
    const cfg = CHANNEL_CFG[data.channel];

    // Janela atual + janela imediatamente anterior (mesma duração) para o delta.
    const fromMs = Date.parse(fromIso);
    const toMs = Date.parse(toIso);
    const prevToIso = fromIso;
    const prevFromIso = new Date(fromMs - (toMs - fromMs)).toISOString();

    const [rows, prevRows] = await Promise.all([
      fetchStatusRows(sb, data.channel, fromIso, toIso),
      fetchStatusRows(sb, data.channel, prevFromIso, prevToIso),
    ]);

    let success = 0, failed = 0, pending = 0;
    let lastDispatchAt: string | null = null;
    for (const r of rows) {
      const b = cfg.bucket(r);
      if (b === "success") success++;
      else if (b === "failed") failed++;
      else if (b === "pending") pending++;
      const ts = r[cfg.tsCol];
      if (ts && (!lastDispatchAt || ts > lastDispatchAt)) lastDispatchAt = ts;
    }
    const total = rows.length;
    const deliveryRate = total > 0 ? Math.round((success / total) * 1000) / 10 : 0;

    let conversions = 0;
    if (data.channel !== "calls" && total > 0) {
      conversions = await countConversions(sb, cfg.table, fromIso, toIso);
    }

    return {
      total,
      success,
      failed,
      pending,
      conversions,
      deliveryRate,
      lastDispatchAt,
      prevTotal: prevRows.length,
    } satisfies HistoryStats;
  });

async function countConversions(
  sb: any,
  table: string,
  fromIso: string,
  toIso: string,
): Promise<number> {
  // best-effort: contagem distinta de player_id que recebeu envio no período e
  // teve depósito aprovado em até 72h
  const { data: logs } = await sb
    .from(table)
    .select("player_id, created_at")
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .not("player_id", "is", null)
    .limit(5000);
  if (!logs || logs.length === 0) return 0;
  const playerIds = Array.from(new Set(logs.map((l: any) => l.player_id)));
  const since = new Date(Date.parse(fromIso) - 0).toISOString();
  const until = new Date(Date.parse(toIso) + 72 * 3600 * 1000).toISOString();
  const { data: deps } = await sb
    .from("deposits")
    .select("player_id, created_at")
    .in("player_id", playerIds)
    .eq("status", "aprovado")
    .gte("created_at", since)
    .lte("created_at", until);
  if (!deps) return 0;
  const depMap = new Map<string, number[]>();
  for (const d of deps as any[]) {
    const arr = depMap.get(d.player_id) ?? [];
    arr.push(Date.parse(d.created_at));
    depMap.set(d.player_id, arr);
  }
  const converted = new Set<string>();
  for (const l of logs as any[]) {
    const sent = Date.parse(l.created_at);
    const ts = depMap.get(l.player_id);
    if (!ts) continue;
    if (ts.some((t) => t >= sent && t - sent <= 72 * 3600 * 1000)) {
      converted.add(l.player_id);
    }
  }
  return converted.size;
}

// ============================================================
// Flow options + resumo por fluxo
// ============================================================

export const getChannelFlowOptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ channel: ChannelEnum }).parse(d))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    if (data.channel === "sms") {
      const { data: rs } = await sb
        .from("sms_flows")
        .select("id, name, trigger_name")
        .order("name", { ascending: true });
      return { flows: (rs ?? []).map((r: any) => ({ id: r.id, name: r.name, trigger_name: r.trigger_name })) };
    }
    if (data.channel === "email") {
      const { data: autos } = await sb
        .from("email_automations")
        .select("id, name, trigger_name")
        .order("name", { ascending: true });
      const { data: flows } = await sb
        .from("email_flows")
        .select("id, name")
        .order("name", { ascending: true });
      const items = [
        ...(flows ?? []).map((r: any) => ({ id: r.id, name: r.name, trigger_name: null })),
        ...(autos ?? []).map((r: any) => ({ id: r.id, name: r.name, trigger_name: r.trigger_name })),
      ];
      return { flows: items };
    }
    if (data.channel === "calls") {
      const { data: rs } = await sb
        .from("call_flows")
        .select("id, name, trigger_name")
        .order("name", { ascending: true });
      return { flows: (rs ?? []).map((r: any) => ({ id: r.id, name: r.name, trigger_name: r.trigger_name })) };
    }
    return { flows: [] };
  });

export const getChannelFlowSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => StatsInput.parse(d))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const fromIso = data.from ?? new Date(Date.now() - 7 * 86400000).toISOString();
    const toIso = data.to ?? new Date().toISOString();

    if (data.channel === "sms") {
      const { data: rs } = await sb
        .from("sms_send_logs")
        .select("flow_id, status, delivery_status, created_at")
        .gte("created_at", fromIso)
        .lte("created_at", toIso)
        .not("flow_id", "is", null)
        .limit(30000);
      return aggregate(rs, "flow_id", "created_at", sb, "sms_flows", "sms");
    }
    if (data.channel === "email") {
      const { data: rs } = await sb
        .from("email_send_logs")
        .select("flow_id, automation_id, status, created_at")
        .gte("created_at", fromIso)
        .lte("created_at", toIso)
        .limit(30000);
      // Prefere flow_id (fluxos novos); cai pra automation_id (automations antigas).
      const normalized = (rs ?? [])
        .map((r: any) => ({ ...r, _flowKey: r.flow_id ?? r.automation_id ?? null }))
        .filter((r: any) => r._flowKey);
      return aggregateEmail(normalized, sb);
    }
    if (data.channel === "calls") {
      const { data: rs } = await sb
        .from("call_flow_executions")
        .select("flow_id, status, created_at")
        .gte("created_at", fromIso)
        .lte("created_at", toIso)
        .not("flow_id", "is", null)
        .limit(30000);
      return aggregate(rs, "flow_id", "created_at", sb, "call_flows", "calls");
    }
    return { items: [] as FlowSummaryItem[] };
  });

export interface FlowSummaryItem {
  flow_id: string;
  flow_name: string;
  total: number;
  success: number;
  failed: number;
  last_at: string | null;
}

async function aggregate(
  rows: any[] | null,
  key: string,
  tsCol: string,
  sb: any,
  flowTable: string,
  channel: ChannelKey,
): Promise<{ items: FlowSummaryItem[] }> {
  const cfg = CHANNEL_CFG[channel];
  const map = new Map<string, { total: number; success: number; failed: number; last_at: string | null }>();
  for (const r of rows ?? []) {
    const id = r[key] as string;
    if (!id) continue;
    const cur = map.get(id) ?? { total: 0, success: 0, failed: 0, last_at: null };
    cur.total++;
    const b = cfg.bucket(r);
    if (b === "success") cur.success++;
    else if (b === "failed") cur.failed++;
    const ts = r[tsCol];
    if (ts && (!cur.last_at || ts > cur.last_at)) cur.last_at = ts;
    map.set(id, cur);
  }
  const ids = Array.from(map.keys());
  if (!ids.length) return { items: [] };
  const { data: flows } = await sb.from(flowTable).select("id, name").in("id", ids);
  const nameById = new Map((flows ?? []).map((f: any) => [f.id, f.name]));
  const items: FlowSummaryItem[] = ids.map((id) => ({
    flow_id: id,
    flow_name: (nameById.get(id) as string) ?? "—",
    ...map.get(id)!,
  }));
  items.sort((a, b) => b.total - a.total);
  return { items: items.slice(0, 20) };
}

async function aggregateEmail(
  rows: any[],
  sb: any,
): Promise<{ items: FlowSummaryItem[] }> {
  const cfg = CHANNEL_CFG.email;
  const map = new Map<string, { total: number; success: number; failed: number; last_at: string | null }>();
  for (const r of rows) {
    const id = r._flowKey as string;
    const cur = map.get(id) ?? { total: 0, success: 0, failed: 0, last_at: null };
    cur.total++;
    const b = cfg.bucket(r);
    if (b === "success") cur.success++;
    else if (b === "failed") cur.failed++;
    if (r.created_at && (!cur.last_at || r.created_at > cur.last_at)) cur.last_at = r.created_at;
    map.set(id, cur);
  }
  const ids = Array.from(map.keys());
  if (!ids.length) return { items: [] };
  const [{ data: flows }, { data: autos }] = await Promise.all([
    sb.from("email_flows").select("id, name").in("id", ids),
    sb.from("email_automations").select("id, name").in("id", ids),
  ]);
  const nameById = new Map<string, string>();
  for (const f of flows ?? []) nameById.set(f.id as string, f.name as string);
  for (const a of autos ?? []) if (!nameById.has(a.id)) nameById.set(a.id as string, a.name as string);
  const items: FlowSummaryItem[] = ids.map((id) => ({
    flow_id: id,
    flow_name: nameById.get(id) ?? "—",
    ...map.get(id)!,
  }));
  items.sort((a, b) => b.total - a.total);
  return { items: items.slice(0, 20) };
}

// ============================================================
// Steps (dias) de um fluxo — para o filtro "Etapa"
// ============================================================

export const getChannelFlowSteps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ channel: ChannelEnum, flowId: dbUuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    if (data.channel === "sms") {
      const { data: steps } = await sb
        .from("sms_flow_steps")
        .select("order_index, step_type, delay_days, content")
        .eq("flow_id", data.flowId)
        .order("order_index", { ascending: true });
      const list = steps ?? [];
      let day = 1;
      const result: Array<{ value: string; label: string }> = [];
      for (const s of list) {
        if (s.step_type === "delay") {
          day += s.delay_days || 0;
          continue;
        }
        if (s.step_type === "sms") {
          const label = `Dia ${day}`;
          if (!result.some((r) => r.value === label)) {
            result.push({ value: label, label });
          }
        }
      }
      return { steps: result };
    }
    if (data.channel === "email") {
      const { data: blocks } = await sb
        .from("email_flow_blocks")
        .select("order_index, block_type, pre_delay_seconds, delay_seconds")
        .eq("flow_id", data.flowId)
        .order("order_index", { ascending: true });
      const list = blocks ?? [];
      let secs = 0;
      const result: Array<{ value: string; label: string }> = [];
      for (const b of list) {
        if (b.block_type === "send_email") {
          const dayN = 1 + Math.floor(secs / 86400);
          const label = `Dia ${dayN}`;
          if (!result.some((r) => r.value === label)) result.push({ value: label, label });
        }
        secs += (b.pre_delay_seconds || 0) + (b.delay_seconds || 0);
      }
      return { steps: result };
    }
    return { steps: [] as Array<{ value: string; label: string }> };
  });

// ============================================================
// Dispatch timeline (sparkline)
// ============================================================

const TimelineInput = z.object({
  channel: ChannelEnum,
  from: z.string().datetime().optional().nullable(),
  to: z.string().datetime().optional().nullable(),
  bucket: z.enum(["hour", "day"]).default("hour"),
});

export const getChannelDispatchTimeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => TimelineInput.parse(d))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const cfg = CHANNEL_CFG[data.channel];
    const fromIso = data.from ?? new Date(Date.now() - 86400000).toISOString();
    const toIso = data.to ?? new Date().toISOString();
    const { data: rs } = await (sb as any)
      .from(cfg.table)
      .select(cfg.tsCol)
      .gte(cfg.tsCol, fromIso)
      .lte(cfg.tsCol, toIso)
      .order(cfg.tsCol, { ascending: true })
      .limit(50000);
    const slotMs = data.bucket === "hour" ? 3600 * 1000 : 86400 * 1000;
    const map = new Map<number, number>();
    for (const r of rs ?? []) {
      const ts = (r as any)[cfg.tsCol];
      if (!ts) continue;
      const slot = Math.floor(Date.parse(ts) / slotMs) * slotMs;
      map.set(slot, (map.get(slot) ?? 0) + 1);
    }
    const slots: Array<{ t: string; count: number }> = [];
    const startSlot = Math.floor(Date.parse(fromIso) / slotMs) * slotMs;
    const endSlot = Math.floor(Date.parse(toIso) / slotMs) * slotMs;
    for (let s = startSlot; s <= endSlot; s += slotMs) {
      slots.push({ t: new Date(s).toISOString(), count: map.get(s) ?? 0 });
    }
    return { points: slots };
  });

// ============================================================
// Histórico de contatos do player (cross-canal)
// ============================================================

export const getPlayerContactHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ playerId: dbUuid(), limit: z.number().int().min(1).max(200).default(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const lim = data.limit;
    const { data: player } = await sb
      .from("players")
      .select("id, nome, telefone")
      .eq("id", data.playerId)
      .maybeSingle();
    const phone = player?.telefone as string | null;

    const [sms, email, calls, wa] = await Promise.all([
      sb
        .from("sms_send_logs")
        .select("id, created_at, content, status, delivery_status, trigger_name, flow:sms_flows(name)")
        .eq("player_id", data.playerId)
        .order("created_at", { ascending: false })
        .limit(lim),
      sb
        .from("email_send_logs")
        .select("id, created_at, subject, status, automation:email_automations(name)")
        .eq("player_id", data.playerId)
        .order("created_at", { ascending: false })
        .limit(lim),
      sb
        .from("call_history")
        .select("id, created_at, to_phone, status, duration_seconds")
        .eq("lead_id", data.playerId)
        .order("created_at", { ascending: false })
        .limit(lim),
      phone
        ? sb
            .from("whatsapp_messages")
            .select("id, text, message_timestamp, status, chat:whatsapp_chats!whatsapp_messages_chat_id_fkey(phone)")
            .eq("from_me", true)
            .order("message_timestamp", { ascending: false })
            .limit(lim * 2)
        : { data: [] as any[] },
    ]);

    const items: Array<{
      channel: ChannelKey;
      at: string;
      preview: string;
      flow: string | null;
      step: string | null;
      status_label: string;
      status_color: StatusColor;
    }> = [];

    for (const r of sms.data ?? []) {
      const s = mapStatus("sms", (r as any).status, (r as any).delivery_status);
      items.push({
        channel: "sms",
        at: (r as any).created_at,
        preview: previewText((r as any).content) ?? "—",
        flow: (r as any).flow?.name ?? null,
        step: (r as any).trigger_name ?? null,
        status_label: s.label,
        status_color: s.color,
      });
    }
    for (const r of email.data ?? []) {
      const s = mapStatus("email", (r as any).status);
      items.push({
        channel: "email",
        at: (r as any).created_at,
        preview: previewText((r as any).subject) ?? "—",
        flow: (r as any).automation?.name ?? null,
        step: null,
        status_label: s.label,
        status_color: s.color,
      });
    }
    for (const r of calls.data ?? []) {
      const s = mapStatus("calls", (r as any).status);
      items.push({
        channel: "calls",
        at: (r as any).created_at,
        preview: (r as any).duration_seconds ? `${(r as any).duration_seconds}s` : "Ligação",
        flow: null,
        step: null,
        status_label: s.label,
        status_color: s.color,
      });
    }
    for (const r of (wa as any).data ?? []) {
      if ((r as any).chat?.phone !== phone) continue;
      const s = mapStatus("whatsapp", (r as any).status);
      items.push({
        channel: "whatsapp",
        at: (r as any).message_timestamp,
        preview: previewText((r as any).text) ?? "—",
        flow: null,
        step: null,
        status_label: s.label,
        status_color: s.color,
      });
    }
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { items: items.slice(0, lim) };
  });