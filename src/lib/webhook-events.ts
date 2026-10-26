export type WebhookEvent = {
  slug: string;
  label: string;
  categoria: "Usuário" | "Depósito" | "Saque" | "Jogo" | "Bônus";
  descricao: string;
};

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  {
    slug: "cadastro",
    label: "Cadastro",
    categoria: "Usuário",
    descricao: "Novo player se cadastrou",
  },
  { slug: "login", label: "Login", categoria: "Usuário", descricao: "Player entrou na plataforma" },
  { slug: "logout", label: "Logout", categoria: "Usuário", descricao: "Player saiu da plataforma" },
  {
    slug: "deposito-pendente",
    label: "Depósito Pendente",
    categoria: "Depósito",
    descricao: "Depósito iniciado",
  },
  {
    slug: "deposito-aprovado",
    label: "Depósito Aprovado",
    categoria: "Depósito",
    descricao: "Depósito confirmado",
  },
  {
    slug: "deposito-falhou",
    label: "Depósito Falhou",
    categoria: "Depósito",
    descricao: "Depósito recusado",
  },
  {
    slug: "saque-pendente",
    label: "Saque Pendente",
    categoria: "Saque",
    descricao: "Saque solicitado",
  },
  { slug: "saque-aprovado", label: "Saque Aprovado", categoria: "Saque", descricao: "Saque pago" },
  { slug: "saque-falhou", label: "Saque Falhou", categoria: "Saque", descricao: "Saque recusado" },
  {
    slug: "saque-concluido",
    label: "Saque Concluído",
    categoria: "Saque",
    descricao: "payment.withdrawal.completed",
  },
  {
    slug: "jogo-iniciado",
    label: "Jogo Iniciado",
    categoria: "Jogo",
    descricao: "Player iniciou uma partida",
  },
  {
    slug: "bonus-ativado",
    label: "Bônus Ativado",
    categoria: "Bônus",
    descricao: "Player ativou bônus",
  },
  {
    slug: "cashback-pago",
    label: "Cashback Pago",
    categoria: "Bônus",
    descricao: "Cashback creditado",
  },
];
export type EventTypeDisplay = {
  label: string;
  /** Null when the type is unknown: show it as a neutral "Evento". */
  categoria: WebhookEvent["categoria"] | null;
  /** The event reports a refused or failed operation. */
  failed: boolean;
};

/** Types written before the webhook slugs (kept so old rows still read right). */
const LEGACY_EVENT_TYPES: Record<string, Omit<EventTypeDisplay, "failed">> = {
  deposito: { label: "Depósito", categoria: "Depósito" },
  saque: { label: "Saque", categoria: "Saque" },
  aposta: { label: "Aposta", categoria: "Jogo" },
  bet: { label: "Aposta", categoria: "Jogo" },
  jogo: { label: "Jogo", categoria: "Jogo" },
};

/**
 * Label of an `events.tipo` value. `events.tipo` holds the webhook slug, so
 * WEBHOOK_EVENTS is the single source; an unknown type is a neutral "Evento".
 */
export function describeEventType(tipo: string | null | undefined): EventTypeDisplay {
  const slug = (tipo ?? "").trim().toLowerCase();
  const known = WEBHOOK_EVENTS.find((event) => event.slug === slug);
  if (known) {
    return { label: known.label, categoria: known.categoria, failed: slug.endsWith("-falhou") };
  }
  const legacy = LEGACY_EVENT_TYPES[slug];
  if (legacy) return { ...legacy, failed: false };
  return { label: "Evento", categoria: null, failed: false };
}
