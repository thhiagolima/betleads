import { describe, expect, it } from "vitest";

import {
  META_TEXTS,
  buildAccountRows,
  buildConnectionCards,
  connectionProgress,
  connectionTitle,
  disconnectImpact,
  filterRows,
  groupByBusiness,
  headerStatus,
  normalizeSearch,
  relativeTimePtBr,
  selectionDiff,
  toggleGroup,
} from "./meta-connection-model";
import type { MetaAccount, MetaBackfillRun, MetaConnection, MetaSummary } from "./meta-summary";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();
const daysAgo = (d: number) => minutesAgo(d * 24 * 60);
const daysAhead = (d: number) => minutesAgo(-d * 24 * 60);

function connection(overrides: Partial<MetaConnection> & { id: string }): MetaConnection {
  return {
    meta_user_name: null,
    token_expires_at: null,
    scopes: ["ads_read"],
    status: "connected",
    last_error: null,
    last_sync_at: null,
    token_hint: "a3f9",
    token_validated_at: null,
    permissions_checked_at: null,
    app_id: "app-1",
    app_name: null,
    business_id: null,
    connection_label: null,
    accounts_discovered_at: null,
    auth_type: "system_user_token",
    token_type: "SYSTEM_USER",
    data_access_expires_at: null,
    health_checked_at: minutesAgo(60),
    ...overrides,
  };
}

function account(overrides: Partial<MetaAccount> & { id: string }): MetaAccount {
  return {
    connection_id: "k1",
    access_connection_ids: ["k1"],
    meta_ad_account_id: `act_${overrides.id}`,
    account_id: overrides.id,
    name: `Conta ${overrides.id}`,
    business_id: "bm-sa",
    business_name: "Sorte Alta",
    currency: "BRL",
    selected: false,
    last_sync_at: null,
    sync_status: "never",
    last_attempt_at: null,
    last_success_at: null,
    last_error: null,
    last_row_count: 0,
    created_at: daysAgo(30),
    account_status: 1,
    timezone_name: "America/Sao_Paulo",
    ...overrides,
  };
}

function summary(overrides: Partial<MetaSummary> = {}): MetaSummary {
  return { connections: [], accounts: [], latestBackfill: null, ...overrides };
}

function backfill(overrides: Partial<MetaBackfillRun>): MetaBackfillRun {
  return {
    id: "run-1",
    status: "running",
    total_accounts: 3,
    processed_accounts: 1,
    successful_accounts: 1,
    failed_accounts: 0,
    created_at: minutesAgo(10),
    finished_at: null,
    ...overrides,
  };
}

const k1 = connection({ id: "k1", connection_label: "Mídia Interna" });
const k2 = connection({ id: "k2", meta_user_name: "Agência X" });
const kErr = connection({ id: "k3", status: "error", app_name: "App Erro" });

describe("texts and helpers", () => {
  it("reuses the existing screen texts", () => {
    expect(META_TEXTS).toEqual({
      noKeyReaches: "Nenhuma chave conectada alcança esta conta.",
      keyInError: "A chave que alcança esta conta está com erro. Teste o acesso.",
      readOnly: "Só o administrador da casa altera a conexão.",
      usdOutsideRoas: "Gasto em outra moeda fica fora do ROAS e do custo por FTD.",
      listChanged: "A lista de contas mudou desde que você abriu a tela. Revise e salve de novo.",
    });
  });

  it("normalizes accents and case", () => {
    expect(normalizeSearch("  Captação ÁGIL ")).toBe("captacao agil");
    expect(normalizeSearch(null)).toBe("");
  });

  it("formats relative time in pt-BR", () => {
    expect(relativeTimePtBr(minutesAgo(0), NOW)).toBe("agora");
    expect(relativeTimePtBr(minutesAgo(-5), NOW)).toBe("agora");
    expect(relativeTimePtBr(minutesAgo(8), NOW)).toBe("há 8 min");
    expect(relativeTimePtBr(minutesAgo(59), NOW)).toBe("há 59 min");
    expect(relativeTimePtBr(minutesAgo(60 * 3 + 10), NOW)).toBe("há 3 h");
    expect(relativeTimePtBr(daysAgo(1), NOW)).toBe("há 1 dia");
    expect(relativeTimePtBr(daysAgo(2.5), NOW)).toBe("há 2 dias");
  });

  it("titles a connection by label, user, app, then a default", () => {
    expect(connectionTitle(k1)).toBe("Mídia Interna");
    expect(connectionTitle(k2)).toBe("Agência X");
    expect(connectionTitle(kErr)).toBe("App Erro");
    expect(connectionTitle(connection({ id: "x" }))).toBe("Chave Meta");
  });
});

describe("buildAccountRows", () => {
  it("keeps accounts with active access or selected, and computes reach", () => {
    const rows = buildAccountRows(
      summary({
        connections: [k1, k2, kErr],
        accounts: [
          account({ id: "shared", access_connection_ids: ["k1", "k2"] }),
          account({ id: "err-only", access_connection_ids: ["k3"] }),
          account({ id: "mixed", access_connection_ids: ["k3", "k2"] }),
          account({ id: "gone", access_connection_ids: [] }),
          account({ id: "removed-key", access_connection_ids: ["k-disconnected"] }),
          // Legada: só o ponteiro `connection_id`, sem acesso N:N, mas marcada.
          account({
            id: "legacy",
            connection_id: "k-legacy",
            access_connection_ids: [],
            selected: true,
          }),
        ],
      }),
      NOW,
    );
    const byId = Object.fromEntries(rows.map((row) => [row.account.id, row]));
    expect(Object.keys(byId).sort()).toEqual(["err-only", "legacy", "mixed", "shared"]);

    expect(byId.shared.reachableConnectionIds).toEqual(["k1", "k2"]);
    expect(byId.shared.selectable).toBe(true);
    expect(byId.shared.reason).toBeNull();

    expect(byId["err-only"].anyAccessConnectionIds).toEqual(["k3"]);
    expect(byId["err-only"].reachableConnectionIds).toEqual([]);
    expect(byId["err-only"].selectable).toBe(false);
    expect(byId["err-only"].reason).toBe(META_TEXTS.keyInError);

    expect(byId.mixed.reachableConnectionIds).toEqual(["k2"]);
    expect(byId.mixed.anyAccessConnectionIds).toEqual(["k3", "k2"]);
    expect(byId.mixed.reason).toBeNull();

    expect(byId.legacy.selectable).toBe(false);
    expect(byId.legacy.anyAccessConnectionIds).toEqual([]);
    expect(byId.legacy.reason).toBe(META_TEXTS.noKeyReaches);
  });

  it("flags non-BRL currency", () => {
    const rows = buildAccountRows(
      summary({
        connections: [k1],
        accounts: [
          account({ id: "usd", currency: "USD" }),
          account({ id: "brl", currency: "brl" }),
          account({ id: "none", currency: null }),
        ],
      }),
      NOW,
    );
    expect(rows.map((row) => [row.account.id, row.usdWarning])).toEqual([
      ["usd", true],
      ["brl", false],
      ["none", false],
    ]);
  });

  it("marks new accounts created within 7 days and not selected", () => {
    const rows = buildAccountRows(
      summary({
        connections: [k1],
        accounts: [
          account({ id: "fresh", created_at: daysAgo(2) }),
          account({ id: "edge", created_at: daysAgo(7) }),
          account({ id: "old", created_at: daysAgo(8) }),
          account({ id: "fresh-selected", created_at: daysAgo(1), selected: true }),
        ],
      }),
      NOW,
    );
    expect(rows.filter((row) => row.isNew).map((row) => row.account.id)).toEqual(["fresh", "edge"]);
  });
});

describe("groupByBusiness", () => {
  const rows = buildAccountRows(
    summary({
      connections: [k1, kErr],
      accounts: [
        account({ id: "b2", name: "Retarget", selected: true }),
        account({ id: "b1", name: "Captação" }),
        account({ id: "z", name: "Única", business_id: "bm-z", business_name: "Zeta" }),
        account({ id: "e", name: "Énfase", business_id: "bm-e", business_name: "Ágata" }),
        account({ id: "n", name: "Sem BM", business_id: null, business_name: null }),
        account({
          id: "blocked",
          name: "Bloqueada",
          business_id: "bm-z",
          business_name: "Zeta",
          access_connection_ids: ["k3"],
        }),
      ],
    }),
    NOW,
  );

  it("groups, names and sorts with pt-BR collation", () => {
    const groups = groupByBusiness(rows, new Set(["b2"]));
    expect(groups.map((group) => [group.key, group.name])).toEqual([
      ["bm-e", "Ágata"],
      ["__none__", "Sem BM identificada"],
      ["bm-sa", "Sorte Alta"],
      ["bm-z", "Zeta"],
    ]);
    const sa = groups.find((group) => group.key === "bm-sa");
    expect(sa?.rows.map((row) => row.account.name)).toEqual(["Captação", "Retarget"]);
  });

  it("computes counts and the mixed check state", () => {
    const groups = groupByBusiness(rows, new Set(["b2"]));
    const sa = groups.find((group) => group.key === "bm-sa");
    expect(sa).toMatchObject({ selectedCount: 1, selectableCount: 2, checkState: "indeterminate" });
    expect(groups.find((group) => group.key === "bm-e")?.checkState).toBe(false);

    const all = groupByBusiness(rows, new Set(["b1", "b2"]));
    expect(all.find((group) => group.key === "bm-sa")?.checkState).toBe(true);

    // Todas as marcáveis marcadas; a sem chave não conta para o "todas".
    const zeta = groupByBusiness(rows, new Set(["z"])).find((group) => group.key === "bm-z");
    expect(zeta).toMatchObject({ selectedCount: 1, selectableCount: 1, checkState: true });
  });

  it("toggles a group without ever adding a non-selectable account", () => {
    const zeta = groupByBusiness(rows, new Set()).find((group) => group.key === "bm-z");
    if (!zeta) throw new Error("missing group");
    const selected = toggleGroup(zeta, new Set(["b1"]));
    expect([...selected].sort()).toEqual(["b1", "z"]);

    const zetaSelected = groupByBusiness(rows, selected).find((group) => group.key === "bm-z");
    if (!zetaSelected) throw new Error("missing group");
    expect([...toggleGroup(zetaSelected, selected)]).toEqual(["b1"]);
  });

  it("mixed group toggle selects the rest; full group toggle clears all its rows", () => {
    const initial = new Set(["b2"]);
    const sa = groupByBusiness(rows, initial).find((group) => group.key === "bm-sa");
    if (!sa) throw new Error("missing group");
    const filled = toggleGroup(sa, initial);
    expect([...filled].sort()).toEqual(["b1", "b2"]);
    expect(initial.size).toBe(1);

    // Conta sem chave marcada no rascunho também sai ao desmarcar a BM.
    const withBlocked = new Set(["z", "blocked"]);
    const zeta = groupByBusiness(rows, withBlocked).find((group) => group.key === "bm-z");
    if (!zeta) throw new Error("missing group");
    expect(zeta.checkState).toBe(true);
    expect(toggleGroup(zeta, withBlocked).size).toBe(0);
  });
});

describe("filterRows", () => {
  const rows = buildAccountRows(
    summary({
      connections: [k1, kErr],
      accounts: [
        account({ id: "123", name: "SA - Captação 01", meta_ad_account_id: "act_123" }),
        account({
          id: "456",
          name: "Retarget",
          meta_ad_account_id: "act_456",
          sync_status: "error",
          selected: true,
        }),
        account({
          id: "999",
          name: "AX - Casa",
          meta_ad_account_id: "act_999",
          business_name: "Agência X",
          created_at: daysAgo(1),
        }),
        account({ id: "777", name: "Sem acesso", access_connection_ids: ["k3"] }),
      ],
    }),
    NOW,
  );
  const ids = (list: typeof rows) => list.map((row) => row.account.id);

  it("searches name, account id and BM ignoring accents and case", () => {
    expect(ids(filterRows(rows, "all", "captacao", new Set()))).toEqual(["123"]);
    expect(ids(filterRows(rows, "all", "ACT_45", new Set()))).toEqual(["456"]);
    expect(ids(filterRows(rows, "all", "agencia", new Set()))).toEqual(["999"]);
    expect(ids(filterRows(rows, "all", "  ", new Set()))).toEqual(["123", "456", "999", "777"]);
  });

  it("filters by the saved selection, errors and new", () => {
    expect(ids(filterRows(rows, "selected", "", new Set(["123"])))).toEqual(["123"]);
    expect(ids(filterRows(rows, "errors", "", new Set()))).toEqual(["456", "777"]);
    expect(ids(filterRows(rows, "new", "", new Set()))).toEqual(["999"]);
    expect(ids(filterRows(rows, "errors", "retar", new Set()))).toEqual(["456"]);
  });

  it("keeps a saved row under Marcadas even after it is unticked in the draft", () => {
    // O 4º argumento é a seleção salva: o rascunho (sem o 456) não entra no filtro.
    const persisted = new Set(["456"]);
    expect(ids(filterRows(rows, "selected", "", persisted))).toEqual(["456"]);
    expect(ids(filterRows(rows, "selected", "", new Set()))).toEqual([]);
  });
});

describe("selectionDiff", () => {
  it("lists added and removed ids", () => {
    expect(selectionDiff(new Set(["a", "b"]), new Set(["b", "c"]))).toEqual({
      added: ["c"],
      removed: ["a"],
      dirty: true,
    });
    expect(selectionDiff(new Set(["a"]), new Set(["a"]))).toEqual({
      added: [],
      removed: [],
      dirty: false,
    });
  });
});

describe("buildConnectionCards", () => {
  it("counts reach and selected accounts per key", () => {
    const cards = buildConnectionCards(
      summary({
        connections: [k1, k2],
        accounts: [
          account({ id: "a", access_connection_ids: ["k1", "k2"], selected: true }),
          account({ id: "b", business_id: "bm-x", business_name: "X" }),
          account({ id: "c", access_connection_ids: ["k2"], business_id: "bm-x" }),
        ],
      }),
      NOW,
    );
    expect(
      cards.map(({ title, businesses, accounts, selectedAccounts, health }) => ({
        title,
        businesses,
        accounts,
        selectedAccounts,
        health,
      })),
    ).toEqual([
      { title: "Mídia Interna", businesses: 2, accounts: 2, selectedAccounts: 1, health: "ok" },
      { title: "Agência X", businesses: 2, accounts: 2, selectedAccounts: 1, health: "ok" },
    ]);
    expect(cards[0].expiry).toEqual({ kind: "never", date: null, soon: false });
    expect(cards[0].healthText).toBeNull();
  });

  it("reads expiry: date, soon, expired and unknown", () => {
    const later = daysAhead(30);
    const soon = daysAhead(3);
    const cards = buildConnectionCards(
      summary({
        connections: [
          connection({ id: "later", data_access_expires_at: later }),
          connection({ id: "soon", data_access_expires_at: soon }),
          {
            ...connection({ id: "token-soon", data_access_expires_at: later }),
            token_expires_at: soon,
          } as MetaConnection,
          connection({ id: "expired", data_access_expires_at: daysAgo(1) }),
          connection({ id: "unknown", token_type: null, health_checked_at: null }),
        ],
      }),
      NOW,
    );
    const byId = Object.fromEntries(cards.map((card) => [card.connection.id, card]));
    expect(byId.later.expiry).toEqual({ kind: "date", date: later, soon: false });
    expect(byId.later.health).toBe("ok");
    expect(byId.soon.expiry).toEqual({ kind: "date", date: soon, soon: true });
    expect(byId.soon.health).toBe("attention");
    expect(byId.soon.healthText).toBe("A chave expira em 3 dias. Troque a chave.");
    expect(byId["token-soon"].expiry.date).toBe(soon);
    expect(byId.expired.health).toBe("error");
    expect(byId.expired.healthText).toBe("A chave expirou. Troque a chave.");
    expect(byId.unknown.expiry).toEqual({ kind: "unknown", date: null, soon: false });
  });

  it("flags attention for selected accounts in error and error for a key in error", () => {
    const cards = buildConnectionCards(
      summary({
        connections: [k1, kErr],
        accounts: [
          account({ id: "a", sync_status: "error", selected: true }),
          account({ id: "b", sync_status: "error", selected: false }),
          account({ id: "c", access_connection_ids: ["k3"] }),
        ],
      }),
      NOW,
    );
    expect(cards[0]).toMatchObject({
      health: "attention",
      healthText: "1 conta com erro de sincronização.",
    });
    expect(cards[1]).toMatchObject({
      health: "error",
      healthText: "A chave está com erro. Teste o acesso ou troque a chave.",
      accounts: 1,
    });
  });
});

describe("disconnectImpact", () => {
  const s = summary({
    connections: [k1, k2, kErr],
    accounts: [
      // exclusivas de k2, marcadas
      account({ id: "x1", access_connection_ids: ["k2"], selected: true }),
      account({ id: "x2", access_connection_ids: ["k2"], selected: true, business_id: "bm-x" }),
      // compartilhada com k1 (conectada)
      account({ id: "s1", access_connection_ids: ["k1", "k2"], selected: true }),
      // compartilhada só com chave em erro: para
      account({ id: "s2", access_connection_ids: ["k2", "k3"], selected: true }),
      // não marcada: alcança, mas não conta para parar/seguir
      account({ id: "u1", access_connection_ids: ["k2"], selected: false }),
      // não alcançada por k2
      account({ id: "other", access_connection_ids: ["k1"], selected: true }),
    ],
  });

  it("splits stop and keep-via for a shared key", () => {
    expect(disconnectImpact(s, "k2")).toEqual({
      accountsReached: 5,
      businesses: 2,
      stop: 3,
      keepVia: [{ connectionTitle: "Mídia Interna", count: 1 }],
      requiresTypedConfirmation: true,
    });
  });

  it("requires typing only when some account stops", () => {
    expect(disconnectImpact(s, "k1")).toEqual({
      accountsReached: 2,
      businesses: 1,
      stop: 1,
      keepVia: [{ connectionTitle: "Agência X", count: 1 }],
      requiresTypedConfirmation: true,
    });
    const shared = summary({
      connections: [k1, k2],
      accounts: [account({ id: "s", access_connection_ids: ["k1", "k2"], selected: true })],
    });
    expect(disconnectImpact(shared, "k1")).toMatchObject({
      stop: 0,
      keepVia: [{ connectionTitle: "Agência X", count: 1 }],
      requiresTypedConfirmation: false,
    });
  });

  it("prefers the account's preferred key when it stays connected", () => {
    const k4 = connection({ id: "k4", connection_label: "Reserva" });
    const multi = summary({
      connections: [k1, k2, k4],
      accounts: [
        account({
          id: "m",
          connection_id: "k4",
          access_connection_ids: ["k1", "k2", "k4"],
          selected: true,
        }),
        account({
          id: "n",
          connection_id: "k1",
          access_connection_ids: ["k1", "k2"],
          selected: true,
        }),
      ],
    });
    expect(disconnectImpact(multi, "k1").keepVia).toEqual([
      { connectionTitle: "Agência X", count: 1 },
      { connectionTitle: "Reserva", count: 1 },
    ]);
  });

  it("returns zeros for an unknown key", () => {
    expect(disconnectImpact(s, "nope")).toEqual({
      accountsReached: 0,
      businesses: 0,
      stop: 0,
      keepVia: [],
      requiresTypedConfirmation: false,
    });
  });
});

describe("connectionProgress", () => {
  const idle = { failedAccounts: 0, incremental: false };
  const selected = { connections: [k1], accounts: [account({ id: "a", selected: true })] };

  it("walks connect → choose → first_read → done", () => {
    expect(connectionProgress(undefined)).toEqual({ step: "connect", percent: null, ...idle });
    expect(connectionProgress(summary())).toEqual({ step: "connect", percent: null, ...idle });
    expect(
      connectionProgress(summary({ connections: [k1], accounts: [account({ id: "a" })] })),
    ).toEqual({ step: "choose", percent: null, ...idle });

    expect(
      connectionProgress(
        summary({ ...selected, latestBackfill: backfill({ processed_accounts: 2 }) }),
      ),
    ).toEqual({ step: "first_read", percent: 67, ...idle });
    expect(
      connectionProgress(
        summary({
          ...selected,
          latestBackfill: backfill({ status: "queued", processed_accounts: 0, total_accounts: 0 }),
        }),
      ),
    ).toEqual({ step: "first_read", percent: 0, ...idle });
    expect(
      connectionProgress(
        summary({ ...selected, latestBackfill: backfill({ status: "completed" }) }),
      ),
    ).toEqual({ step: "done", percent: null, ...idle });
    expect(
      connectionProgress(
        summary({ ...selected, latestBackfill: backfill({ status: "canceled" }) }),
      ),
    ).toEqual({ step: "done", percent: null, ...idle });
    expect(connectionProgress(summary(selected))).toEqual({ step: "done", percent: null, ...idle });
  });

  it("reports failed accounts only for partial/failed backfills", () => {
    for (const status of ["partial", "failed"] as const) {
      expect(
        connectionProgress(
          summary({ ...selected, latestBackfill: backfill({ status, failed_accounts: 2 }) }),
        ),
      ).toEqual({ step: "done", percent: null, failedAccounts: 2, incremental: false });
    }
    expect(
      connectionProgress(
        summary({
          ...selected,
          latestBackfill: backfill({ status: "completed", failed_accounts: 2 }),
        }),
      ).failedAccounts,
    ).toBe(0);
  });

  it("stays done with incremental % when an account was already read", () => {
    const read = {
      connections: [k1],
      accounts: [
        account({ id: "a", selected: true, last_success_at: minutesAgo(30) }),
        account({ id: "b", selected: true }),
      ],
    };
    expect(
      connectionProgress(summary({ ...read, latestBackfill: backfill({ processed_accounts: 2 }) })),
    ).toEqual({ step: "done", percent: 67, failedAccounts: 0, incremental: true });
    expect(
      connectionProgress(summary({ ...read, latestBackfill: backfill({ status: "completed" }) })),
    ).toEqual({ step: "done", percent: null, ...idle });
  });
});

describe("headerStatus", () => {
  it("is none without summary or connections", () => {
    expect(headerStatus(undefined, NOW)).toEqual({ tone: "none", text: "Não conectada" });
    expect(headerStatus(summary(), NOW)).toEqual({ tone: "none", text: "Não conectada" });
  });

  it("is ok with BMs, selected accounts and the latest success", () => {
    const s = summary({
      connections: [k1],
      accounts: [
        account({ id: "a", selected: true, last_success_at: minutesAgo(30) }),
        account({ id: "b", selected: true, last_success_at: minutesAgo(8), business_id: "bm-2" }),
        account({ id: "c", selected: true, business_id: "bm-3" }),
        account({ id: "d", selected: false, last_success_at: minutesAgo(1) }),
      ],
    });
    expect(headerStatus(s, NOW)).toEqual({
      tone: "ok",
      text: "3 BMs · 3 contas · atualizado há 8 min",
    });
  });

  it("shows hours, days and 'agora'", () => {
    const at = (iso: string) =>
      headerStatus(
        summary({
          connections: [k1],
          accounts: [account({ id: "a", selected: true, last_success_at: iso })],
        }),
        NOW,
      ).text;
    expect(at(minutesAgo(0))).toBe("1 BM · 1 conta · atualizado agora");
    expect(at(minutesAgo(180))).toBe("1 BM · 1 conta · atualizado há 3 h");
    expect(at(daysAgo(2))).toBe("1 BM · 1 conta · atualizado há 2 dias");
  });

  it("says nothing is selected yet", () => {
    expect(
      headerStatus(summary({ connections: [k1], accounts: [account({ id: "a" })] }), NOW),
    ).toEqual({ tone: "ok", text: "1 BM · 1 conta · nenhuma marcada" });
  });

  it("is attention when some key needs care but not all are in error", () => {
    const s = summary({
      connections: [k1, k2, kErr],
      accounts: [
        account({ id: "a", selected: true }),
        account({ id: "b", selected: true, business_id: "bm-2", access_connection_ids: ["k2"] }),
        account({ id: "c", selected: true, business_id: "bm-3", access_connection_ids: ["k2"] }),
      ],
    });
    expect(headerStatus(s, NOW)).toEqual({
      tone: "attention",
      text: "3 BMs · 1 chave com atenção",
    });
  });

  it("is error only when every key is in error", () => {
    const s = summary({
      connections: [kErr, connection({ id: "k5", status: "error" })],
      accounts: [account({ id: "a", access_connection_ids: ["k3"] })],
    });
    expect(headerStatus(s, NOW)).toEqual({ tone: "error", text: "2 chaves com erro" });
    expect(headerStatus(summary({ connections: [kErr] }), NOW)).toEqual({
      tone: "error",
      text: "1 chave com erro",
    });
  });
});
