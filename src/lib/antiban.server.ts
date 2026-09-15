// Configurações globais Anti-ban (singleton). Funcionam como TETO obrigatório
// sobre limites de fluxo e sessão. Sempre aplicar o MAIS RESTRITIVO.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface AntibanSettings {
  delay_min_seconds: number;
  delay_max_seconds: number;
  hourly_limit: number;
  daily_limit: number;
  window_start: string; // "HH:MM" ou "HH:MM:SS"
  window_end: string;
  randomization_enabled: boolean;
  smart_suppression_enabled: boolean;
  auto_pause_enabled: boolean;
  warmup_enabled: boolean;
  warmup_initial_daily: number;
  warmup_days: number;
}

const DEFAULTS: AntibanSettings = {
  delay_min_seconds: 180,
  delay_max_seconds: 720,
  hourly_limit: 40,
  daily_limit: 400,
  window_start: "06:00",
  window_end: "22:00",
  randomization_enabled: true,
  smart_suppression_enabled: true,
  auto_pause_enabled: true,
  warmup_enabled: true,
  warmup_initial_daily: 50,
  warmup_days: 7,
};

export async function getAntibanSettings(): Promise<AntibanSettings> {
  const { data } = await supabaseAdmin
    .from("antiban_settings")
    .select(
      "delay_min_seconds, delay_max_seconds, hourly_limit, daily_limit, window_start, window_end, randomization_enabled, smart_suppression_enabled, auto_pause_enabled, warmup_enabled, warmup_initial_daily, warmup_days",
    )
    .limit(1)
    .maybeSingle();
  if (!data) return DEFAULTS;
  return data as AntibanSettings;
}

function parseHMS(s: string): number {
  // retorna minutos desde 00:00
  const [h = "0", m = "0"] = s.split(":");
  return Number(h) * 60 + Number(m);
}

const TZ = "America/Sao_Paulo";
const tzFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
});

function minutesOfDayInTZ(now: Date): number {
  const parts = tzFormatter.formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // Intl pode retornar "24" para meia-noite em alguns runtimes
  return (h % 24) * 60 + m;
}

export function isWithinOperationalWindow(now: Date, s: AntibanSettings): boolean {
  const cur = minutesOfDayInTZ(now);
  const start = parseHMS(s.window_start);
  const end = parseHMS(s.window_end);
  if (start === end) return true; // janela 24h
  if (start < end) return cur >= start && cur < end;
  // janela cruza meia-noite (ex: 22:00 -> 06:00)
  return cur >= start || cur < end;
}

export function nextWindowStart(now: Date, s: AntibanSettings): Date {
  const start = parseHMS(s.window_start);
  // Calcula o próximo início da janela no fuso de São Paulo.
  // Brasil não observa DST desde 2019, então o offset é fixo em -03:00.
  const curMin = minutesOfDayInTZ(now);
  const diffMin = start - curMin;
  const next = new Date(now.getTime() + diffMin * 60_000);
  if (next.getTime() <= now.getTime()) {
    next.setTime(next.getTime() + 24 * 60 * 60_000);
  }
  return next;
}

export interface FlowCapsInput {
  delay_min_seconds?: number | null;
  delay_max_seconds?: number | null;
  hourly_limit?: number | null;
  daily_limit?: number | null;
}

export interface SessionCapsInput {
  hourly_limit?: number | null;
  daily_limit?: number | null;
  created_at?: string | null;
}

export interface EffectiveCaps {
  delayMin: number;
  delayMax: number;
  hourlyLimit: number;
  dailyLimit: number;
}

export function effectiveSessionDailyLimit(
  session: SessionCapsInput,
  s: AntibanSettings,
): number {
  const rawDaily = Math.min(
    s.daily_limit,
    session.daily_limit ?? Number.MAX_SAFE_INTEGER,
  );
  if (!s.warmup_enabled || !session.created_at) return rawDaily;
  const ageDays = (Date.now() - new Date(session.created_at).getTime()) / 86400000;
  if (ageDays >= s.warmup_days) return rawDaily;
  // interpolação linear: dia 0 = warmup_initial_daily, dia warmup_days = rawDaily
  const ratio = Math.max(0, Math.min(1, ageDays / Math.max(1, s.warmup_days)));
  const interpolated = Math.round(
    s.warmup_initial_daily + (rawDaily - s.warmup_initial_daily) * ratio,
  );
  return Math.min(rawDaily, Math.max(1, interpolated));
}

export function applyAntibanCaps(
  flow: FlowCapsInput,
  session: SessionCapsInput,
  s: AntibanSettings,
): EffectiveCaps {
  const dMinCandidates = [s.delay_min_seconds, flow.delay_min_seconds ?? 0].filter(
    (n) => typeof n === "number",
  ) as number[];
  const dMaxCandidates = [s.delay_max_seconds, flow.delay_max_seconds ?? 0].filter(
    (n) => typeof n === "number",
  ) as number[];
  // delay: o MAIOR mínimo e o MAIOR máximo entre antiban e fluxo (mais restritivo = mais lento)
  const delayMin = Math.max(...dMinCandidates, 0);
  const delayMax = Math.max(delayMin, ...dMaxCandidates, 0);

  const hourlyLimit = Math.min(
    s.hourly_limit,
    flow.hourly_limit ?? Number.MAX_SAFE_INTEGER,
    session.hourly_limit ?? Number.MAX_SAFE_INTEGER,
  );
  const dailyLimit = Math.min(
    s.daily_limit,
    flow.daily_limit ?? Number.MAX_SAFE_INTEGER,
    effectiveSessionDailyLimit(session, s),
  );
  return { delayMin, delayMax, hourlyLimit, dailyLimit };
}