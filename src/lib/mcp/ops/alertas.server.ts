// MCP do grupo, área de operação: `alertas` (spec
// docs/superpowers/specs/2026-11-17-mcp-grupo-design.md §5.9) — "what needs
// attention now". Data is read in bulk for every house of the scope
// (`tenant_id in ids`), one check at a time; the rules are the pure functions
// of ./alertas-regras.server.ts. A check whose read fails goes to
// `verificacoes_com_erro` and the other checks still run; only when every
// check fails does the tool fail.
import { z } from "zod";

import { presetRange } from "@/lib/finance/calc";
import { isBillingEnforcementEnabled } from "@/lib/billing/billing-state.server";
import { isEffectiveLock, type BillingAccessState } from "@/lib/billing/billing-view";
import { fetchSendUsage, type SendUsageRow } from "@/lib/finance/finance-data.server";

import type { McpIdentity } from "../access.server";
import { OPS_CONCURRENCY } from "../config.server";
import { CANAIS, STATUS_FALHA, chunks, loadCampanhasCanal, opsDb } from "./campanhas-data.server";
import {
  CONSUMO_MEDIO_DIAS,
  JANELA_CAMPANHAS_DIAS,
  STATUS_CANCELADA,
  STATUS_SUSPENSA,
  ordenarAlertas,
  regraCampanha,
  regraIntegracaoParada,
  regraJornadaParada,
  regraSaldo,
  regraStatusCasa,
  regraTetoExpert,
  type Alerta,
  type CasaRef,
} from "./alertas-regras.server";
import { escopoOps, type CasaComErro } from "./runner.server";
import { resolverEscopoOps, type CasaOps } from "./scope.server";

export const alertasInput = z.object({ escopo: escopoOps });

export type Verificacao =
  "status_casa" | "saldo" | "campanhas" | "jornadas" | "teto_expert" | "integracao";

export type AlertasResult = {
  rotulo: string;
  gerado_em: string;
  casas: Array<{ id: string; nome: string; alertas: number }>;
  alertas: Alerta[];
  verificacoes_com_erro: Array<{ verificacao: Verificacao; erro: string }>;
  casas_com_erro: CasaComErro[];
};

type Row = Record<string, unknown>;
const DAY_MS = 86_400_000;
const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const addDays = (date: string, delta: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
const ref = (casa: CasaOps): CasaRef => ({ id: casa.id, nome: casa.nome });

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose PostgREST builder (opsDb) */
type Query = any;

async function selectIn(
  table: string,
  columns: string,
  ids: string[],
  extra?: (query: Query) => Query,
) {
  const rows: Row[] = [];
  for (const part of chunks(ids)) {
    let query = opsDb().from(table).select(columns).in("tenant_id", part);
    if (extra) query = extra(query);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
  }
  return rows;
}

async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(OPS_CONCURRENCY, items.length) }, worker));
  return out;
}

// ─── Checks ─────────────────────────────────────────────────────────────────

async function checarStatus(casas: CasaOps[]): Promise<Alerta[]> {
  const billing = await selectIn(
    "tenant_billing",
    "tenant_id,access_state",
    casas.map((c) => c.id),
  );
  const stateOf = new Map(billing.map((row) => [String(row.tenant_id), row.access_state]));
  const enforcement = isBillingEnforcementEnabled();
  return casas.flatMap((casa) => {
    const state = stateOf.get(casa.id) as BillingAccessState | null | undefined;
    return regraStatusCasa(ref(casa), {
      status: casa.status,
      bloqueadaPorCobranca: state ? isEffectiveLock(state, enforcement) : false,
    });
  });
}

async function checarSaldo(casas: CasaOps[], today: string): Promise<Alerta[]> {
  const ids = casas.map((c) => c.id);
  const [wallets, usage] = await Promise.all([
    selectIn("tenant_wallets", "tenant_id,balance", ids),
    fetchSendUsage(ids, { from: addDays(today, -CONSUMO_MEDIO_DIAS), to: addDays(today, -1) }),
  ]);
  const balance = new Map(wallets.map((row) => [String(row.tenant_id), num(row.balance)]));
  const spent = new Map<string, number>();
  for (const row of usage as SendUsageRow[]) {
    spent.set(row.tenant_id, (spent.get(row.tenant_id) ?? 0) + num(row.amount));
  }
  return casas.flatMap((casa) => {
    const alerta = regraSaldo(ref(casa), {
      saldo: balance.get(casa.id) ?? 0,
      consumoMedioDiario: (spent.get(casa.id) ?? 0) / CONSUMO_MEDIO_DIAS,
    });
    return alerta ? [alerta] : [];
  });
}

async function checarCampanhas(casas: CasaOps[], now: Date): Promise<Alerta[]> {
  const byId = new Map(casas.map((c) => [c.id, c]));
  const janela = {
    fromInstant: new Date(now.getTime() - JANELA_CAMPANHAS_DIAS * DAY_MS).toISOString(),
    toInstant: now.toISOString(),
  };
  const porCanal = await Promise.all(
    CANAIS.map((canal) => loadCampanhasCanal(canal, Array.from(byId.keys()), janela)),
  );
  return porCanal.flatMap(({ campanhas }) =>
    campanhas.flatMap((campanha) => {
      const casa = byId.get(campanha.tenant_id);
      if (!casa) return [];
      const alerta = regraCampanha(ref(casa), campanha, STATUS_FALHA);
      return alerta ? [alerta] : [];
    }),
  );
}

async function checarJornadas(casas: CasaOps[], now: Date): Promise<Alerta[]> {
  const byId = new Map(casas.map((c) => [c.id, c]));
  const journeys = await selectIn(
    "journeys",
    "id,tenant_id,name",
    Array.from(byId.keys()),
    (q: Query) => q.eq("status", "active"),
  );
  const ultimos = await mapLimit(journeys, async (journey) => {
    const { data, error } = await opsDb()
      .from("journey_step_executions")
      .select("created_at")
      .eq("tenant_id", journey.tenant_id)
      .eq("journey_id", journey.id)
      .in("status", ["sent", "delivered"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const last = ((data ?? []) as Row[])[0]?.created_at;
    return last ? String(last) : null;
  });
  return journeys.flatMap((journey, index) => {
    const casa = byId.get(String(journey.tenant_id));
    if (!casa) return [];
    const alerta = regraJornadaParada(
      ref(casa),
      { id: String(journey.id), nome: String(journey.name ?? ""), ultimoEnvioEm: ultimos[index] },
      now,
    );
    return alerta ? [alerta] : [];
  });
}

async function checarTetoExpert(casas: CasaOps[], today: string): Promise<Alerta[]> {
  const byId = new Map(casas.map((c) => [c.id, c]));
  // One row per expert per month (claim of the monthly cap e-mail): a row of
  // the current São Paulo month is an open cap.
  const month = `${today.slice(0, 7)}-01`;
  const open = await selectIn(
    "expert_cap_alerts",
    "tenant_id,expert_id",
    Array.from(byId.keys()),
    (q) => q.eq("month", month),
  );
  if (!open.length) return [];
  const names = new Map<string, string | null>();
  for (const part of chunks(open.map((row) => String(row.expert_id)))) {
    const { data, error } = await opsDb().from("experts").select("id,nome").in("id", part);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Row[])
      names.set(String(row.id), (row.nome as string) ?? null);
  }
  return open.flatMap((row) => {
    const casa = byId.get(String(row.tenant_id));
    if (!casa) return [];
    const id = String(row.expert_id);
    return [regraTetoExpert(ref(casa), { id, nome: names.get(id) ?? null })];
  });
}

async function checarIntegracao(casas: CasaOps[], today: string): Promise<Alerta[]> {
  // A suspended or canceled house already has its own `alta`.
  const ativas = casas.filter(
    (c) => !(c.status && (STATUS_SUSPENSA.has(c.status) || STATUS_CANCELADA.has(c.status))),
  );
  if (!ativas.length) return [];
  const days = [addDays(today, -1), today];
  const rows = await selectIn(
    "tenant_daily_metrics",
    "tenant_id,metric_date,registrations,approved_deposit_count",
    ativas.map((c) => c.id),
    (q) => q.in("metric_date", days),
  );
  const byTenant = new Map<string, Array<{ cadastros: number; depositos: number }>>();
  for (const row of rows) {
    const key = String(row.tenant_id);
    byTenant.set(key, [
      ...(byTenant.get(key) ?? []),
      { cadastros: num(row.registrations), depositos: num(row.approved_deposit_count) },
    ]);
  }
  return ativas.flatMap((casa) => {
    const alerta = regraIntegracaoParada(ref(casa), byTenant.get(casa.id) ?? []);
    return alerta ? [alerta] : [];
  });
}

// ─── Tool ───────────────────────────────────────────────────────────────────

const shortError = (error: unknown) =>
  (error instanceof Error && error.message ? error.message : "Erro na verificação.").slice(0, 200);

/** `alertas` (§5.9): alerts sorted by gravidade then house. */
export async function alertas(
  identity: McpIdentity,
  args: z.input<typeof alertasInput>,
  now: Date = new Date(),
): Promise<AlertasResult> {
  const data = alertasInput.parse(args);
  const { casas, rotulo } = await resolverEscopoOps(identity.userId, data.escopo);
  const today = presetRange("today", now).from;

  const checks: Array<[Verificacao, () => Promise<Alerta[]>]> = [
    ["status_casa", () => checarStatus(casas)],
    ["saldo", () => checarSaldo(casas, today)],
    ["campanhas", () => checarCampanhas(casas, now)],
    ["jornadas", () => checarJornadas(casas, now)],
    ["teto_expert", () => checarTetoExpert(casas, today)],
    ["integracao", () => checarIntegracao(casas, today)],
  ];
  const settled = await Promise.allSettled(checks.map(([, run]) => run()));
  const found: Alerta[] = [];
  const verificacoes_com_erro: AlertasResult["verificacoes_com_erro"] = [];
  settled.forEach((entry, index) => {
    if (entry.status === "fulfilled") found.push(...entry.value);
    else
      verificacoes_com_erro.push({ verificacao: checks[index][0], erro: shortError(entry.reason) });
  });
  if (casas.length && verificacoes_com_erro.length === checks.length) {
    throw new Error(`Nenhuma verificação respondeu. ${verificacoes_com_erro[0].erro}`);
  }

  const lista = ordenarAlertas(found);
  const count = new Map<string, number>();
  for (const alerta of lista) count.set(alerta.casa.id, (count.get(alerta.casa.id) ?? 0) + 1);
  return {
    rotulo,
    gerado_em: now.toISOString(),
    casas: casas.map((casa) => ({
      id: casa.id,
      nome: casa.nome,
      alertas: count.get(casa.id) ?? 0,
    })),
    alertas: lista,
    verificacoes_com_erro,
    casas_com_erro: [],
  };
}
