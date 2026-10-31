import type { MetaAccount, MetaConnection, MetaSummary } from "./meta-summary";

// Regras da aba Meta Ads de Integrações (MB3), em funções puras: a tela só
// desenha. Tudo que depende do relógio recebe `now`; nada aqui lê Date.now().

export const META_TEXTS = {
  noKeyReaches: "Nenhuma chave conectada alcança esta conta.",
  keyInError: "A chave que alcança esta conta está com erro. Teste o acesso.",
  readOnly: "Só o administrador da casa altera a conexão.",
  usdOutsideRoas: "Gasto em outra moeda fica fora do ROAS e do custo por FTD.",
  listChanged: "A lista de contas mudou desde que você abriu a tela. Revise e salve de novo.",
} as const satisfies {
  noKeyReaches: string;
  keyInError: string;
  readOnly: string;
  usdOutsideRoas: string;
  listChanged: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_ACCOUNT_WINDOW_MS = 7 * DAY_MS;
const EXPIRY_SOON_MS = 7 * DAY_MS;
const NO_BUSINESS_KEY = "__none__";
const NO_BUSINESS_NAME = "Sem BM identificada";

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function timeOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

function byName(a: string, b: string) {
  return a.localeCompare(b, "pt-BR", { sensitivity: "base" });
}

function businessKey(account: MetaAccount) {
  return account.business_id ?? NO_BUSINESS_KEY;
}

/** Minúsculas e sem acento, para a busca. */
export function normalizeSearch(value: string | null | undefined): string {
  return (value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** "agora", "há 8 min", "há 3 h", "há 2 dias". */
export function relativeTimePtBr(iso: string, now: Date): string {
  const time = timeOf(iso);
  if (time === null) return "";
  const diff = now.getTime() - time;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${plural(Math.floor(hours / 24), "dia", "dias")}`;
}

/** Nome da chave na tela. */
export function connectionTitle(connection: MetaConnection): string {
  return (
    connection.connection_label ?? connection.meta_user_name ?? connection.app_name ?? "Chave Meta"
  );
}

// ---------------------------------------------------------------------------
// Contas
// ---------------------------------------------------------------------------

export type AccountFilter = "all" | "selected" | "errors" | "new";

export type AccountRow = {
  account: MetaAccount;
  /** Acesso ativo por uma chave `connected` (a única que o worker usa). */
  reachableConnectionIds: string[];
  /** Todas as chaves com acesso ativo, inclusive as em erro. */
  anyAccessConnectionIds: string[];
  /** Marcar exige uma chave `connected` (o RPC recusa sem ela). */
  selectable: boolean;
  /** Apareceu nos últimos 7 dias e ainda não foi marcada. */
  isNew: boolean;
  /** Moeda informada e diferente de BRL: o gasto fica fora do ROAS. */
  usdWarning: boolean;
  /** Por que não dá para marcar, em texto visível. */
  reason: string | null;
};

/**
 * Uma conta aparece enquanto alguma chave ativa a alcança (tabela N:N da MB1).
 * A marcada aparece sempre, mesmo sem chave, para não sumir da tela nem do Salvar.
 */
export function buildAccountRows(summary: MetaSummary, now: Date): AccountRow[] {
  const active = summary.connections.filter((item) => item.status !== "disabled");
  const activeIds = new Set(active.map((item) => item.id));
  const connectedIds = new Set(
    active.filter((item) => item.status === "connected").map((item) => item.id),
  );
  const rows: AccountRow[] = [];
  for (const account of summary.accounts) {
    const anyAccessConnectionIds = account.access_connection_ids.filter((id) => activeIds.has(id));
    if (!account.selected && anyAccessConnectionIds.length === 0) continue;
    const reachableConnectionIds = anyAccessConnectionIds.filter((id) => connectedIds.has(id));
    const selectable = reachableConnectionIds.length > 0;
    const createdAt = timeOf(account.created_at);
    const isNew =
      !account.selected && createdAt !== null && now.getTime() - createdAt <= NEW_ACCOUNT_WINDOW_MS;
    const currency = account.currency?.trim().toUpperCase() ?? "";
    rows.push({
      account,
      reachableConnectionIds,
      anyAccessConnectionIds,
      selectable,
      isNew,
      usdWarning: currency !== "" && currency !== "BRL",
      reason: selectable
        ? null
        : anyAccessConnectionIds.length > 0
          ? META_TEXTS.keyInError
          : META_TEXTS.noKeyReaches,
    });
  }
  return rows;
}

function rowName(row: AccountRow) {
  return row.account.name ?? row.account.account_id ?? row.account.meta_ad_account_id;
}

export type BusinessGroup = {
  key: string;
  name: string;
  rows: AccountRow[];
  selectedCount: number;
  selectableCount: number;
  checkState: boolean | "indeterminate";
};

/** Agrupa por BM (a BM é atributo da conta), em ordem alfabética pt-BR. */
export function groupByBusiness(
  rows: AccountRow[],
  selected: ReadonlySet<string>,
): BusinessGroup[] {
  const groups = new Map<string, { name: string; rows: AccountRow[] }>();
  for (const row of rows) {
    const key = businessKey(row.account);
    const group = groups.get(key) ?? {
      name: row.account.business_name ?? NO_BUSINESS_NAME,
      rows: [],
    };
    if (group.name === NO_BUSINESS_NAME && row.account.business_name) {
      group.name = row.account.business_name;
    }
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const sortedRows = [...group.rows].sort((a, b) => byName(rowName(a), rowName(b)));
      const selectedCount = sortedRows.filter((row) => selected.has(row.account.id)).length;
      const selectableRows = sortedRows.filter((row) => row.selectable);
      const allSelectableSelected =
        selectableRows.length > 0 && selectableRows.every((row) => selected.has(row.account.id));
      const checkState: boolean | "indeterminate" = allSelectableSelected
        ? true
        : selectedCount > 0
          ? "indeterminate"
          : false;
      return {
        key,
        name: group.name,
        rows: sortedRows,
        selectedCount,
        selectableCount: selectableRows.length,
        checkState,
      };
    })
    .sort((a, b) => byName(a.name, b.name) || byName(a.key, b.key));
}

/**
 * Filtro (Todas / Marcadas / Com erro / Novas) e busca sem acento nem caixa.
 * Ordem: `(rows, filter, query, persisted)`. "Marcadas" usa a seleção SALVA
 * (não o rascunho), para a linha não sumir ao desmarcar antes de salvar.
 */
export function filterRows(
  rows: AccountRow[],
  filter: AccountFilter,
  query: string,
  persisted: ReadonlySet<string>,
): AccountRow[] {
  const needle = normalizeSearch(query);
  return rows.filter((row) => {
    if (filter === "selected" && !persisted.has(row.account.id)) return false;
    if (filter === "errors" && row.account.sync_status !== "error" && row.reason === null) {
      return false;
    }
    if (filter === "new" && !row.isNew) return false;
    if (!needle) return true;
    return [row.account.name, row.account.meta_ad_account_id, row.account.business_name].some(
      (value) => normalizeSearch(value).includes(needle),
    );
  });
}

/**
 * Marca ou desmarca a BM inteira: com todas as marcáveis já marcadas, desmarca
 * todas as contas do grupo; senão marca as marcáveis (nunca uma sem chave).
 */
export function toggleGroup(group: BusinessGroup, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const selectableRows = group.rows.filter((row) => row.selectable);
  const allSelected = selectableRows.every((row) => next.has(row.account.id));
  if (allSelected) {
    for (const row of group.rows) next.delete(row.account.id);
  } else {
    for (const row of selectableRows) next.add(row.account.id);
  }
  return next;
}

/** O que o rascunho muda em relação ao que está salvo. */
export function selectionDiff(
  persisted: ReadonlySet<string>,
  draft: ReadonlySet<string>,
): { added: string[]; removed: string[]; dirty: boolean } {
  const added = [...draft].filter((id) => !persisted.has(id));
  const removed = [...persisted].filter((id) => !draft.has(id));
  return { added, removed, dirty: added.length + removed.length > 0 };
}

// ---------------------------------------------------------------------------
// Chaves
// ---------------------------------------------------------------------------

export type ConnectionCard = {
  connection: MetaConnection;
  title: string;
  businesses: number;
  accounts: number;
  selectedAccounts: number;
  expiry: { kind: "never" | "date" | "unknown"; date: string | null; soon: boolean };
  health: "ok" | "attention" | "error";
  healthText: string | null;
};

// `token_expires_at` já vem do resumo (select de getMetaConnectionSummaryFor),
// mas não está no tipo `MetaConnection`; lê com segurança.
type ConnectionWithTokenExpiry = MetaConnection & { token_expires_at?: string | null };

function connectionExpiry(connection: MetaConnection, now: Date): ConnectionCard["expiry"] {
  const candidates = [
    (connection as ConnectionWithTokenExpiry).token_expires_at,
    connection.data_access_expires_at,
  ]
    .map((iso) => ({ iso, time: timeOf(iso) }))
    .filter((item): item is { iso: string; time: number } => item.time !== null)
    .sort((a, b) => a.time - b.time);
  const first = candidates[0];
  if (first) {
    return { kind: "date", date: first.iso, soon: first.time - now.getTime() <= EXPIRY_SOON_MS };
  }
  // Sem data: se a chave já passou pelo debug_token (MB2-03), ela não expira;
  // se nunca passou, a validade é desconhecida.
  const checked = Boolean(connection.token_type) || Boolean(connection.health_checked_at);
  return { kind: checked ? "never" : "unknown", date: null, soon: false };
}

function expiryText(date: string, now: Date) {
  const remaining = (timeOf(date) ?? 0) - now.getTime();
  if (remaining <= 0) return "A chave expirou. Troque a chave.";
  const days = Math.ceil(remaining / DAY_MS);
  return days <= 1
    ? "A chave expira em menos de 1 dia. Troque a chave."
    : `A chave expira em ${days} dias. Troque a chave.`;
}

export function buildConnectionCards(summary: MetaSummary, now: Date): ConnectionCard[] {
  const rows = buildAccountRows(summary, now);
  return summary.connections
    .filter((connection) => connection.status !== "disabled")
    .map((connection) => {
      const reached = rows.filter((row) => row.anyAccessConnectionIds.includes(connection.id));
      const businesses = new Set(reached.map((row) => businessKey(row.account))).size;
      const selectedAccounts = reached.filter((row) => row.account.selected).length;
      const expiry = connectionExpiry(connection, now);
      const expired = expiry.kind === "date" && (timeOf(expiry.date) ?? 0) <= now.getTime();
      // Só as contas marcadas sincronizam; o erro de uma desmarcada é antigo.
      const accountErrors = reached.filter(
        (row) =>
          row.account.selected &&
          row.reachableConnectionIds.includes(connection.id) &&
          row.account.sync_status === "error",
      ).length;

      let health: ConnectionCard["health"] = "ok";
      let healthText: string | null = null;
      if (connection.status !== "connected") {
        health = "error";
        healthText = "A chave está com erro. Teste o acesso ou troque a chave.";
      } else if (expired) {
        health = "error";
        healthText = expiryText(expiry.date as string, now);
      } else if (expiry.soon || accountErrors > 0) {
        health = "attention";
        healthText = [
          expiry.soon ? expiryText(expiry.date as string, now) : null,
          accountErrors > 0
            ? `${plural(accountErrors, "conta", "contas")} com erro de sincronização.`
            : null,
        ]
          .filter(Boolean)
          .join(" ");
      }

      return {
        connection,
        title: connectionTitle(connection),
        businesses,
        accounts: reached.length,
        selectedAccounts,
        expiry,
        health,
        healthText,
      };
    });
}

export type DisconnectImpact = {
  accountsReached: number;
  businesses: number;
  stop: number;
  keepVia: { connectionTitle: string; count: number }[];
  requiresTypedConfirmation: boolean;
};

/**
 * O que acontece ao desconectar a chave: as contas marcadas que só ela alcança
 * param; as que outra chave conectada alcança seguem por ela (a preferida da
 * conta, se for uma dessas; senão a primeira).
 */
export function disconnectImpact(summary: MetaSummary, connectionId: string): DisconnectImpact {
  const connections = summary.connections.filter((item) => item.status !== "disabled");
  const activeIds = new Set(connections.map((item) => item.id));
  const connectedById = new Map(
    connections.filter((item) => item.status === "connected").map((item) => [item.id, item]),
  );
  const reached = summary.accounts.filter(
    (account) =>
      activeIds.has(connectionId) && account.access_connection_ids.includes(connectionId),
  );
  let stop = 0;
  const keep = new Map<string, number>();
  for (const account of reached) {
    if (!account.selected) continue;
    const others = account.access_connection_ids.filter(
      (id) => id !== connectionId && connectedById.has(id),
    );
    if (others.length === 0) {
      stop += 1;
      continue;
    }
    const via = others.includes(account.connection_id) ? account.connection_id : others[0];
    const title = connectionTitle(connectedById.get(via) as MetaConnection);
    keep.set(title, (keep.get(title) ?? 0) + 1);
  }
  return {
    accountsReached: reached.length,
    businesses: new Set(reached.map(businessKey)).size,
    stop,
    keepVia: [...keep.entries()]
      .map(([title, count]) => ({ connectionTitle: title, count }))
      .sort((a, b) => b.count - a.count || byName(a.connectionTitle, b.connectionTitle)),
    requiresTypedConfirmation: stop > 0,
  };
}

// ---------------------------------------------------------------------------
// Progresso e cabeçalho
// ---------------------------------------------------------------------------

export type ProgressStep = "connect" | "choose" | "first_read" | "done";

export type ConnectionProgress = {
  step: ProgressStep;
  /** % do backfill em andamento (primeira leitura ou importação de contas novas). */
  percent: number | null;
  /** Contas com erro no último backfill encerrado como `partial`/`failed`. */
  failedAccounts: number;
  /** Backfill em andamento com alguma conta marcada já lida: só contas novas. */
  incremental: boolean;
};

function backfillPercent(backfill: NonNullable<MetaSummary["latestBackfill"]>) {
  return backfill.total_accounts > 0
    ? Math.min(
        100,
        Math.max(0, Math.round((backfill.processed_accounts / backfill.total_accounts) * 100)),
      )
    : 0;
}

/**
 * Conectar → Escolher contas → Primeira leitura (% do backfill) → Pronto.
 * Um backfill novo depois que alguma conta marcada já foi lida não volta para
 * "Primeira leitura": fica em "Pronto" com `incremental` e o %.
 */
export function connectionProgress(summary: MetaSummary | undefined): ConnectionProgress {
  const base = { percent: null, failedAccounts: 0, incremental: false };
  if (!summary || summary.connections.length === 0) return { step: "connect", ...base };
  const selected = summary.accounts.filter((account) => account.selected);
  if (selected.length === 0) return { step: "choose", ...base };
  const backfill = summary.latestBackfill;
  if (backfill && (backfill.status === "queued" || backfill.status === "running")) {
    const percent = backfillPercent(backfill);
    const alreadyRead = selected.some((account) => timeOf(account.last_success_at) !== null);
    return alreadyRead
      ? { step: "done", percent, failedAccounts: 0, incremental: true }
      : { step: "first_read", percent, failedAccounts: 0, incremental: false };
  }
  const failedAccounts =
    backfill && (backfill.status === "partial" || backfill.status === "failed")
      ? Math.max(0, backfill.failed_accounts)
      : 0;
  return { step: "done", percent: null, failedAccounts, incremental: false };
}

export type HeaderStatus = { tone: "ok" | "attention" | "error" | "none"; text: string };

/**
 * Status agregado do cabeçalho: uma chave em erro não pinta tudo de vermelho
 * enquanto outras seguem saudáveis (UX-12).
 */
export function headerStatus(summary: MetaSummary | undefined, now: Date): HeaderStatus {
  if (!summary) return { tone: "none", text: "Não conectada" };
  const cards = buildConnectionCards(summary, now);
  if (cards.length === 0) return { tone: "none", text: "Não conectada" };

  const errors = cards.filter((card) => card.health === "error").length;
  if (errors === cards.length) {
    return { tone: "error", text: `${plural(errors, "chave", "chaves")} com erro` };
  }

  const rows = buildAccountRows(summary, now);
  const selectedRows = rows.filter((row) => row.account.selected);
  const counted = selectedRows.length > 0 ? selectedRows : rows;
  const bms = plural(new Set(counted.map((row) => businessKey(row.account))).size, "BM", "BMs");

  const attention = cards.filter((card) => card.health !== "ok").length;
  if (attention > 0) {
    return {
      tone: "attention",
      text: `${bms} · ${plural(attention, "chave", "chaves")} com atenção`,
    };
  }

  const parts = [bms, plural(counted.length, "conta", "contas")];
  if (selectedRows.length === 0) {
    parts.push("nenhuma marcada");
  } else {
    const lastSuccess = selectedRows
      .map((row) => row.account.last_success_at)
      .filter((iso): iso is string => timeOf(iso) !== null)
      .sort((a, b) => (timeOf(b) ?? 0) - (timeOf(a) ?? 0))[0];
    if (lastSuccess) parts.push(`atualizado ${relativeTimePtBr(lastSuccess, now)}`);
  }
  return { tone: "ok", text: parts.join(" · ") };
}
