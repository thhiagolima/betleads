// Resolve um segmento (definido na UI) para a lista de players com email.
// Compartilhado pelos envios em massa de Email Marketing.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { applyActiveWithin, applyInactiveAtLeast, applyInactivityWindow } from "./player-activity";

const DAY = 86400000;
/** PostgREST `max_rows` (1000 on Supabase): every response is cut there without an error. */
const PAGE_SIZE = 1000;
/** Ids per `in(...)` filter: keeps the request URL short. */
const ID_CHUNK = 300;
const ago = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function requireTenant(tenantId: string) {
  if (!tenantId) throw new Error("tenant obrigatório para resolver a audiência de e-mail");
}

// Roda com service role, então o filtro por tenant é a única barreira entre
// casas: nunca remover o `.eq("tenant_id", ...)` destas consultas.
// Sem teto: pagina por id (keyset) até o fim do segmento.
export async function loadPlayersForSegment(tenantId: string, segmento: string): Promise<any[]> {
  requireTenant(tenantId);
  const rows: any[] = [];
  let lastId: string | null = null;
  for (;;) {
    let q = segmentQuery(tenantId, segmento);
    if (lastId !== null) q = q.gt("id", lastId);
    const { data, error } = await q.order("id", { ascending: true }).limit(PAGE_SIZE);
    if (error) {
      console.error("loadPlayersForSegment", segmento, error.message);
      return [];
    }
    const page = (data ?? []) as any[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    lastId = String(page[page.length - 1].id);
  }
}

function segmentQuery(
  tenantId: string,
  segmento: string,
  columns = "*",
  options?: { count: "exact"; head: true },
) {
  let q = supabaseAdmin
    .from("players")
    .select(columns, options)
    .eq("tenant_id", tenantId)
    .not("email", "is", null)
    .neq("email", "");

  switch (segmento) {
    case "Todos":
      break;
    case "Logaram nos últimos 4 dias":
      q = applyActiveWithin(q, ago(4));
      break;
    case "7+ dias sem login":
      q = applyInactiveAtLeast(q, ago(7));
      break;
    case "VIP":
      q = q.eq("vip", true);
      break;
    case "VIP sem login":
      q = applyInactiveAtLeast(q.eq("vip", true), ago(7));
      break;
    case "Faltando pouco pro VIP":
      q = q.eq("vip", false).gte("total_depositado", 800);
      break;
    case "Depositando frequentemente":
      q = q.gte("ultimo_deposito", ago(7));
      break;
    case "Com saldo e sem login":
      q = applyInactiveAtLeast(q.gt("saldo_carteira", 0), ago(3));
      break;
    case "Depositaram hoje":
      q = q.gte("ultimo_deposito", ago(1));
      break;
    case "Cadastrados sem depósito":
      q = q.is("ftd_em", null);
      break;
    case "7 a 14 dias sem login":
      q = applyInactivityWindow(q, ago(7), ago(14)).not("ftd_em", "is", null);
      break;
    case "15 a 24 dias sem login":
      q = applyInactivityWindow(q, ago(15), ago(24)).not("ftd_em", "is", null);
      break;
    case "25 a 34 dias sem login":
      q = applyInactivityWindow(q, ago(25), ago(34)).not("ftd_em", "is", null);
      break;
    case "35 a 44 dias sem login":
      q = applyInactivityWindow(q, ago(35), ago(44)).not("ftd_em", "is", null);
      break;
    case "45 a 59 dias sem login":
      q = applyInactivityWindow(q, ago(45), ago(59)).not("ftd_em", "is", null);
      break;
    case "60+ dias sem login":
      q = applyInactiveAtLeast(q, ago(60)).not("ftd_em", "is", null);
      break;
    default:
      break;
  }

  return q;
}

export async function countPlayersForSegment(tenantId: string, segmento: string): Promise<number> {
  requireTenant(tenantId);
  const { count, error } = await segmentQuery(tenantId, segmento, "id", {
    count: "exact",
    head: true,
  });
  if (error) {
    console.error("countPlayersForSegment", segmento, error.message);
    return 0;
  }
  return count ?? 0;
}

/** Leads escolhidos à mão: ids de outra casa são descartados silenciosamente. */
export async function loadPlayersByIds(tenantId: string, ids: string[]): Promise<any[]> {
  requireTenant(tenantId);
  const rows: any[] = [];
  const unique = Array.from(new Set(ids));
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("players")
      .select("*")
      .eq("tenant_id", tenantId)
      .in("id", unique.slice(i, i + ID_CHUNK));
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
  }
  return rows;
}
