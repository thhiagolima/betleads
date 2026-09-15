// Janela de envio global para disparos automáticos (SMS, email, ligações).
// Lê a tabela singleton `send_window_settings` (com cache de 60s) e expõe
// helpers para decidir "pode enviar agora?" e "qual o próximo horário permitido?".

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type SendWindowSettings = {
  start_minute: number;
  end_minute: number;
  timezone: string;
  weekdays: number[]; // 0=dom..6=sáb
  enabled: boolean;
};

const DEFAULTS: SendWindowSettings = {
  // O provedor (BusinessCode) recusa envios antes das 08:00 BRT com
  // HTTP 422 QUIET_HOURS. Mantemos a janela padrão dentro do permitido.
  start_minute: 8 * 60,
  end_minute: 21 * 60,
  timezone: "America/Sao_Paulo",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
};

const MAIN_TENANT_ID = "00000000-0000-0000-0000-000000000001";

const cache = new Map<string, { value: SendWindowSettings; at: number }>();
const TTL_MS = 60_000;

export async function getSendWindow(
  force = false,
  tenantId: string = MAIN_TENANT_ID,
): Promise<SendWindowSettings> {
  const hit = cache.get(tenantId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    // Havia mais de uma linha (uma por tenant): sem o filtro por tenant o
    // maybeSingle falhava e a janela caía silenciosamente no DEFAULTS.
    const { data } = await supabaseAdmin
      .from("send_window_settings")
      .select("start_minute,end_minute,timezone,weekdays,enabled")
      .eq("singleton", true)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const v: SendWindowSettings = data
      ? {
          start_minute: data.start_minute ?? DEFAULTS.start_minute,
          end_minute: data.end_minute ?? DEFAULTS.end_minute,
          timezone: data.timezone || DEFAULTS.timezone,
          weekdays:
            Array.isArray(data.weekdays) && data.weekdays.length
              ? (data.weekdays as number[])
              : DEFAULTS.weekdays,
          enabled: data.enabled ?? DEFAULTS.enabled,
        }
      : DEFAULTS;
    cache.set(tenantId, { value: v, at: Date.now() });
    return v;
  } catch {
    return DEFAULTS;
  }
}

export function invalidateSendWindowCache() {
  cache.clear();
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getLocalParts(date: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  return {
    weekday: WEEKDAY_MAP[m.weekday] ?? 0,
    year: parseInt(m.year, 10),
    month: parseInt(m.month, 10),
    day: parseInt(m.day, 10),
    hour: parseInt(m.hour, 10) % 24,
    minute: parseInt(m.minute, 10),
  };
}

/** Converte uma data/hora "local" (no timezone informado) para um Date UTC. */
function localToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timezone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const p = getLocalParts(new Date(guess), timezone);
  const localOfGuess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  const offset = localOfGuess - guess;
  return new Date(guess - offset);
}

export function isWithinWindow(
  settings: SendWindowSettings,
  date: Date = new Date(),
): boolean {
  if (!settings.enabled) return true;
  const p = getLocalParts(date, settings.timezone);
  if (!settings.weekdays.includes(p.weekday)) return false;
  const minute = p.hour * 60 + p.minute;
  // janela [start, end). 22:00 fim → 22:00 já é fora.
  return minute >= settings.start_minute && minute < settings.end_minute;
}

/** Devolve o próximo instante em que envios voltam a ser permitidos.
 *  Se já estiver dentro da janela, devolve o instante recebido. */
export function nextAllowedAt(
  settings: SendWindowSettings,
  from: Date = new Date(),
): Date {
  if (!settings.enabled) return from;
  if (isWithinWindow(settings, from)) return from;

  for (let offset = 0; offset < 14; offset++) {
    const probeUtc = new Date(from.getTime() + offset * 86_400_000);
    const lp = getLocalParts(probeUtc, settings.timezone);
    if (!settings.weekdays.includes(lp.weekday)) continue;
    const startH = Math.floor(settings.start_minute / 60);
    const startM = settings.start_minute % 60;
    const target = localToUtc(lp.year, lp.month, lp.day, startH, startM, settings.timezone);
    if (target.getTime() > from.getTime()) return target;
  }
  // fallback: amanhã 06:00 UTC
  return new Date(from.getTime() + 6 * 3600_000);
}

/** Atalho usado pelos dispatchers: se fora da janela, devolve ISO do próximo
 *  horário permitido; senão `null`. */
export async function deferIfOutsideWindow(
  date: Date = new Date(),
  tenantId?: string,
): Promise<string | null> {
  const s = await getSendWindow(false, tenantId ?? MAIN_TENANT_ID);
  if (isWithinWindow(s, date)) return null;
  return nextAllowedAt(s, date).toISOString();
}