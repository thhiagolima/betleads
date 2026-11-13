// Sonda da rota SMS (Short Brasil). Regras puras, sem acesso ao banco: o
// servidor (sms-route-probe.server.ts) busca as linhas e chama estas funções;
// o painel e a barra do super admin importam os tipos. Não importar nada
// `*.server.ts` aqui.

export const PROBE_INTERVAL_MINUTES = 30;
export const MAX_PROBE_PHONES = 10;
/** Tempo que um SMS aceito tem para ser confirmado antes de contar como "não entregue". */
export const DELIVERY_GRACE_MS = 20 * 60_000;
/** Quantos SMS aceitos seguidos sem confirmação viram o aviso de rota sem entrega. */
export const NOT_DELIVERING_AFTER = 2;
/** Rodada mais velha que isso não acende a barra (sonda parada ou desligada). */
export const STALE_AFTER_MS = 2.5 * PROBE_INTERVAL_MINUTES * 60_000;

export type ProbeResult = "accepted" | "no_balance" | "auth_error" | "error";

export type ProbeRow = {
  round_id: string;
  probe_code: string;
  phone: string;
  sent_at: string;
  result: ProbeResult;
  error: string | null;
  delivery_status: string | null;
  delivered_at: string | null;
};

export type ProbeBalance = "ok" | "no_balance" | "unknown";
export type ProbeDelivery = "delivering" | "not_delivering" | "pending" | "unknown";

export type ProbeStatus = {
  enabled: boolean;
  lastProbeAt: string | null;
  /** A última rodada é velha demais para valer (robô parado ou sonda desligada). */
  stale: boolean;
  balance: ProbeBalance;
  /** Desde quando as rodadas seguidas voltam "sem saldo". */
  noBalanceSince: string | null;
  delivery: ProbeDelivery;
  /** Primeiro SMS aceito da sequência sem confirmação de entrega. */
  notDeliveringSince: string | null;
  lastDeliveredAt: string | null;
  /** Erro da última rodada quando não é saldo (credencial, provedor fora). */
  lastError: string | null;
};

// Textos sem acento (GSM-7) e sem link: operadora filtra SMS idênticos
// repetidos, então o texto muda a cada envio e sempre leva o código único.
export const PROBE_TEMPLATES = [
  "BetLeads: teste automatico da rota SMS. Codigo {code}.",
  "Controle de entrega BetLeads {code}. Mensagem automatica, nao responda.",
  "Verificacao periodica do envio de SMS BetLeads - ref {code}.",
  "BetLeads monitor {code}: SMS de controle enviado as {hora}.",
  "Teste de saldo e rota BetLeads. Identificador {code}.",
  "Mensagem de controle BetLeads ({code}) - verificacao de entrega as {hora}.",
] as const;

// Sem 0/O/1/I/L para o código ser lido sem confusão no celular.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newProbeCode(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(6);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function brtTime(now: Date): string {
  return now.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Texto do SMS de controle; `index` escolhe o modelo (o chamador varia a cada envio). */
export function probeMessage(code: string, index: number, now: Date): string {
  const template = PROBE_TEMPLATES[Math.abs(index) % PROBE_TEMPLATES.length];
  return template.replace("{code}", code).replace("{hora}", brtTime(now));
}

/** Resultado do envio a partir do erro resumido do provedor (summarizeProviderError). */
export function classifyProbeSend(ok: boolean, errorSummary: string | null): ProbeResult {
  if (ok) return "accepted";
  const text = (errorSummary ?? "").toLowerCase();
  if (text.includes("saldo insuficiente")) return "no_balance";
  if (text.includes("autenticacao") || text.includes("credenciais")) return "auth_error";
  return "error";
}

/** `rows` do mais novo para o mais velho. */
export function computeProbeStatus(rows: ProbeRow[], enabled: boolean, now: Date): ProbeStatus {
  const status: ProbeStatus = {
    enabled,
    lastProbeAt: rows[0]?.sent_at ?? null,
    stale: true,
    balance: "unknown",
    noBalanceSince: null,
    delivery: "unknown",
    notDeliveringSince: null,
    lastDeliveredAt: null,
    lastError: null,
  };
  if (rows.length === 0) return status;
  const nowMs = now.getTime();
  status.stale = nowMs - new Date(rows[0].sent_at).getTime() > STALE_AFTER_MS;

  const lastRound = rows.filter((row) => row.round_id === rows[0].round_id);
  if (lastRound.some((row) => row.result === "no_balance")) {
    status.balance = "no_balance";
    // Começo da sequência: o envio mais velho antes do primeiro aceito.
    for (const row of rows) {
      if (row.result === "accepted") break;
      if (row.result === "no_balance") status.noBalanceSince = row.sent_at;
    }
  } else if (lastRound.some((row) => row.result === "accepted")) {
    status.balance = "ok";
  }
  const lastFailure = lastRound.find((row) => row.result === "error" || row.result === "auth_error");
  if (lastFailure && status.balance !== "ok") status.lastError = lastFailure.error;

  const accepted = rows.filter((row) => row.result === "accepted");
  status.lastDeliveredAt =
    accepted.find((row) => row.delivery_status === "delivered")?.delivered_at ??
    accepted.find((row) => row.delivery_status === "delivered")?.sent_at ??
    null;
  // Só julga quem já teve tempo de ser confirmado.
  const judged = accepted.filter(
    (row) => nowMs - new Date(row.sent_at).getTime() >= DELIVERY_GRACE_MS ||
      row.delivery_status === "delivered",
  );
  if (judged.length === 0) {
    status.delivery = accepted.length > 0 ? "pending" : "unknown";
    return status;
  }
  let undelivered = 0;
  for (const row of judged) {
    if (row.delivery_status === "delivered") break;
    undelivered++;
    status.notDeliveringSince = row.sent_at;
  }
  if (undelivered === 0) {
    status.delivery = "delivering";
    status.notDeliveringSince = null;
  } else if (undelivered >= NOT_DELIVERING_AFTER) {
    status.delivery = "not_delivering";
  } else {
    // Um único SMS sem confirmação ainda não basta para acusar a rota.
    status.delivery = judged.length > undelivered ? "delivering" : "pending";
    status.notDeliveringSince = null;
  }
  return status;
}

/** Barras que o super admin vê no topo (vazio = nada a avisar). */
export type ProbeBannerKind = "no_balance" | "not_delivering";

export function probeBanners(status: ProbeStatus): ProbeBannerKind[] {
  if (!status.enabled || status.stale) return [];
  const banners: ProbeBannerKind[] = [];
  if (status.balance === "no_balance") banners.push("no_balance");
  else if (status.delivery === "not_delivering") banners.push("not_delivering");
  return banners;
}
