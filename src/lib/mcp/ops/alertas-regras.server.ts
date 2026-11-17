// MCP do grupo, área de operação: the `alertas` rules (spec
// docs/superpowers/specs/2026-11-17-mcp-grupo-design.md §5.9). Each rule is a
// small pure function over data already loaded for the scope, tested on its
// own (alertas-regras.server.test.ts); thresholds are the constants below.
// No I/O here: ./alertas.server.ts loads the data and calls these.

export const FALHA_LIMITE = 0.2;
export const JANELA_CAMPANHAS_DIAS = 7;
export const JORNADA_PARADA_HORAS = 48;
export const CONSUMO_MEDIO_DIAS = 3;

/** tenants.status values that stop the house (tenant-access.server.ts). */
export const STATUS_SUSPENSA = new Set(["suspended"]);
export const STATUS_CANCELADA = new Set(["canceled", "cancelled"]);

export type Gravidade = "alta" | "media";
export type TipoAlerta =
  | "casa_suspensa"
  | "casa_cancelada"
  | "bloqueio_cobranca"
  | "saldo_zerado"
  | "saldo_baixo"
  | "campanha_com_falha"
  | "jornada_sem_envio"
  | "teto_expert"
  | "integracao_parada";

export type CasaRef = { id: string; nome: string };
export type AlertaRef = {
  tipo: "campanha" | "jornada" | "expert";
  id: string;
  canal?: string;
};
export type Alerta = {
  casa: CasaRef;
  tipo: TipoAlerta;
  gravidade: Gravidade;
  mensagem: string;
  ref?: AlertaRef;
};

const brl = (value: number) =>
  value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** Suspended / canceled house, and the billing lock as a fact (no super admin exemption). */
export function regraStatusCasa(
  casa: CasaRef,
  input: { status: string | null; bloqueadaPorCobranca: boolean },
): Alerta[] {
  const out: Alerta[] = [];
  if (input.status && STATUS_SUSPENSA.has(input.status)) {
    out.push({ casa, tipo: "casa_suspensa", gravidade: "alta", mensagem: "Casa suspensa." });
  }
  if (input.status && STATUS_CANCELADA.has(input.status)) {
    out.push({ casa, tipo: "casa_cancelada", gravidade: "alta", mensagem: "Casa cancelada." });
  }
  if (input.bloqueadaPorCobranca) {
    out.push({
      casa,
      tipo: "bloqueio_cobranca",
      gravidade: "alta",
      mensagem: "Casa bloqueada por cobrança (mensalidade).",
    });
  }
  return out;
}

/**
 * Wallet balance (BRL) below the average daily send consumption of the last
 * CONSUMO_MEDIO_DIAS days: `alta` when zero or negative, `media` when low.
 * No consumption → no alert (a house that does not spend from the wallet,
 * e.g. sends on its own provider account, is never "low").
 */
export function regraSaldo(
  casa: CasaRef,
  input: { saldo: number; consumoMedioDiario: number },
): Alerta | null {
  const { saldo, consumoMedioDiario } = input;
  if (!(consumoMedioDiario > 0) || saldo >= consumoMedioDiario) return null;
  if (saldo <= 0) {
    return {
      casa,
      tipo: "saldo_zerado",
      gravidade: "alta",
      mensagem: `Saldo da carteira zerado (${brl(saldo)}); consumo médio de ${brl(consumoMedioDiario)}/dia nos últimos ${CONSUMO_MEDIO_DIAS} dias.`,
    };
  }
  return {
    casa,
    tipo: "saldo_baixo",
    gravidade: "media",
    mensagem: `Saldo da carteira (${brl(saldo)}) abaixo do consumo médio de ${brl(consumoMedioDiario)}/dia dos últimos ${CONSUMO_MEDIO_DIAS} dias.`,
  };
}

/**
 * A campaign of the last JANELA_CAMPANHAS_DIAS days whose status is a failure,
 * or whose failures are above FALHA_LIMITE of the total (strictly above).
 */
export function regraCampanha(
  casa: CasaRef,
  campanha: {
    canal: string;
    id: string;
    nome: string;
    status: string;
    total: number | null;
    falhas: number | null;
  },
  statusFalha: ReadonlySet<string>,
): Alerta | null {
  const ref: AlertaRef = { tipo: "campanha", id: campanha.id, canal: campanha.canal };
  const nome = campanha.nome || "sem nome";
  if (statusFalha.has(campanha.status)) {
    return {
      casa,
      tipo: "campanha_com_falha",
      gravidade: "media",
      mensagem: `Campanha de ${campanha.canal} "${nome}" terminou com status de falha (${campanha.status}).`,
      ref,
    };
  }
  const total = campanha.total ?? 0;
  const falhas = campanha.falhas ?? 0;
  if (total > 0 && falhas / total > FALHA_LIMITE) {
    const pct = Math.round((falhas / total) * 1000) / 10;
    return {
      casa,
      tipo: "campanha_com_falha",
      gravidade: "media",
      mensagem: `Campanha de ${campanha.canal} "${nome}" com ${falhas} falhas de ${total} (${String(pct).replace(".", ",")}%).`,
      ref,
    };
  }
  return null;
}

const HOUR_MS = 3_600_000;

/**
 * An active journey that sent before but nothing in the last
 * JORNADA_PARADA_HORAS hours. `ultimoEnvioEm` null = never sent → no alert.
 */
export function regraJornadaParada(
  casa: CasaRef,
  jornada: { id: string; nome: string; ultimoEnvioEm: string | null },
  now: Date,
): Alerta | null {
  if (!jornada.ultimoEnvioEm) return null;
  const last = Date.parse(jornada.ultimoEnvioEm);
  if (!Number.isFinite(last)) return null;
  const hours = (now.getTime() - last) / HOUR_MS;
  if (hours < JORNADA_PARADA_HORAS) return null;
  return {
    casa,
    tipo: "jornada_sem_envio",
    gravidade: "media",
    mensagem: `Jornada ativa "${jornada.nome || "sem nome"}" sem envio há ${Math.floor(hours)} h (enviava antes).`,
    ref: { tipo: "jornada", id: jornada.id },
  };
}

/** An expert whose monthly cap alert (expert_cap_alerts) is open for the current month. */
export function regraTetoExpert(
  casa: CasaRef,
  expert: { id: string; nome: string | null },
): Alerta {
  return {
    casa,
    tipo: "teto_expert",
    gravidade: "media",
    mensagem: `Expert "${expert.nome?.trim() || "sem nome"}" atingiu o teto mensal de envios.`,
    ref: { tipo: "expert", id: expert.id },
  };
}

/**
 * No signup and no approved deposit on any of the given days (yesterday and
 * today, São Paulo) in tenant_daily_metrics: the integration looks stopped.
 * A missing day row counts as zero.
 */
export function regraIntegracaoParada(
  casa: CasaRef,
  dias: Array<{ cadastros: number; depositos: number }>,
): Alerta | null {
  const movimento = dias.reduce((acc, dia) => acc + dia.cadastros + dia.depositos, 0);
  if (movimento > 0) return null;
  return {
    casa,
    tipo: "integracao_parada",
    gravidade: "alta",
    mensagem: "Nenhum cadastro e nenhum depósito ontem e hoje: a integração pode estar parada.",
  };
}

const PESO: Record<Gravidade, number> = { alta: 0, media: 1 };

/** Gravidade (alta first), then house name, then tipo. */
export function ordenarAlertas(alertas: Alerta[]): Alerta[] {
  return [...alertas].sort(
    (a, b) =>
      PESO[a.gravidade] - PESO[b.gravidade] ||
      a.casa.nome.localeCompare(b.casa.nome, "pt-BR") ||
      a.casa.id.localeCompare(b.casa.id) ||
      a.tipo.localeCompare(b.tipo),
  );
}
