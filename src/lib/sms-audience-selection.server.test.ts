/* eslint-disable @typescript-eslint/no-explicit-any -- dublês mínimos do query builder. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RESOLUTION_CHUNK_SIZE } from "./campaign-recipients.server";
import {
  EMPTY_SMS_AUDIENCE,
  normalizeSmsAudienceCriteria,
  smsAudienceCriteriaSchema,
  toSelectionReference,
} from "./sms-audience-criteria";
import {
  createSelectionAudienceRecord,
  filterPlayerIdsToTenant,
  loadTenantPlayersByIds,
  PermanentAudienceError,
  resolveAudienceForTenant,
  SELECTION_AUDIENCE_MISSING,
  SELECTION_ID_CHUNK,
  selectionAudienceName,
} from "./sms-audience-selection.server";
import { resolveCriteriaToSave, toClientAudience } from "./sms-audience-crud.functions";
import { createFakeDb } from "./sms-bulk.test-support";

type Row = Record<string, unknown>;
const TENANT = "00000000-0000-4000-8000-00000000a001";
const OTHER = "00000000-0000-4000-8000-00000000b002";
const AUDIENCE = "00000000-0000-4000-8000-0000000c0001";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const selection = (ids: string[]) => ({ timing: "selection", playerIds: ids });

/**
 * Cópia do schema e da normalização ANTERIORES a esta mudança (HEAD
 * dc22753/f8979b8), que é o que roda em produção até o deploy. Prova que o
 * código antigo falha fechado diante de um público de seleção.
 */
const legacySchema = z.object({
  activity: z
    .object({
      deposit: z.enum(["any", "never", "yes"]).default("any"),
      pixUnpaid: z.boolean().default(false),
      cashback: z.boolean().default(false),
      withdrawal: z.enum(["any", "yes", "never"]).default("any"),
      withdrawalPending: z.boolean().default(false),
    })
    .default({
      deposit: "any",
      pixUnpaid: false,
      cashback: false,
      withdrawal: "any",
      withdrawalPending: false,
    }),
  level: z.enum(["bronze", "silver", "gold", "diamond", "black"]).nullable().default(null),
  timing: z
    .enum(["any", "cooling", "sleeping", "inactive30", "inactive90", "custom", "registered_week"])
    .default("any"),
  customDays: z.number().int().min(1).max(3650).default(2),
  daysWithoutLogin: z.number().int().min(1).max(3650).nullable().default(null),
  daysSinceRegistration: z.number().int().min(1).max(3650).nullable().default(null),
});
function legacyNormalize(value: unknown) {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const legacyDays = Number(raw.daysWithoutDeposit ?? 0);
  const timing =
    raw.timing ??
    (legacyDays === 2
      ? "cooling"
      : legacyDays === 7
        ? "sleeping"
        : legacyDays === 30
          ? "inactive30"
          : legacyDays === 90
            ? "inactive90"
            : legacyDays > 0
              ? "custom"
              : "any");
  return legacySchema.parse({
    ...raw,
    activity: raw.activity ?? { ...EMPTY_SMS_AUDIENCE.activity, deposit: raw.deposit ?? "any" },
    level: raw.level === "any" ? null : raw.level,
    timing,
    customDays: timing === "custom" ? legacyDays || raw.customDays || 2 : raw.customDays || 2,
    daysWithoutLogin: raw.daysWithoutLogin || null,
    daysSinceRegistration: raw.daysSinceRegistration || null,
  });
}

/** Query builder que grava cada chamada (`eq`, `in`) por consulta. */
function recordingDb(players: Row[]) {
  const queries: Array<Array<{ method: string; column: string; value: unknown }>> = [];
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  return {
    queries,
    rpcCalls,
    db: {
      from(table: string) {
        const ops: Array<{ method: string; column: string; value: unknown }> = [];
        queries.push(ops);
        const builder: any = {
          select: () => builder,
          eq: (column: string, value: unknown) => (
            ops.push({ method: "eq", column, value }),
            builder
          ),
          in: (column: string, value: unknown[]) => (
            ops.push({ method: "in", column, value }),
            builder
          ),
          then: (resolve: (v: unknown) => unknown) => {
            const rows = (table === "players" ? players : []).filter((row) =>
              ops.every((op) =>
                op.method === "eq"
                  ? row[op.column] === op.value
                  : (op.value as unknown[]).includes(row[op.column]),
              ),
            );
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
        return builder;
      },
      rpc: (fn: string, args: Row) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve({
          data: {
            phones: ["5511999990001"],
            total: 1,
            recipientTotal: 1,
            emailPlayerIds: [],
            emailRecipientTotal: 0,
            facets: {},
            settings: { thresholds: {}, cooling: 2, sleeping: 7 },
          },
          error: null,
        });
      },
    },
  };
}

describe("critério de seleção", () => {
  it("público por regras continua sem os campos de seleção", () => {
    const criteria = normalizeSmsAudienceCriteria({ activity: { deposit: "yes" } });
    expect("playerIds" in criteria).toBe(false);
    expect("audienceId" in criteria).toBe(false);
    expect(criteria.timing).toBe("any");
    expect(normalizeSmsAudienceCriteria({})).toEqual(EMPTY_SMS_AUDIENCE);
  });

  it("normalize preserva a lista sem repetição e força o marcador timing=selection", () => {
    const criteria = normalizeSmsAudienceCriteria({ playerIds: [pid(1), pid(2), pid(1)] });
    expect(criteria.playerIds).toEqual([pid(1), pid(2)]);
    expect(criteria.timing).toBe("selection");
  });

  it("B1: o schema ANTIGO rejeita um público de seleção (falha fechado, não vira 'todos')", () => {
    const stored = normalizeSmsAudienceCriteria(selection([pid(1)]));
    expect(() => legacyNormalize(stored)).toThrow();
    const reference = toSelectionReference(stored, AUDIENCE);
    expect(() => legacyNormalize(reference)).toThrow();
    // Controle: sem o marcador, o schema antigo descartaria a lista e viraria "todos".
    expect(legacyNormalize({ playerIds: [pid(1)] })).toEqual(EMPTY_SMS_AUDIENCE);
  });

  it("I1: playerIds presente e não-lista lança erro", () => {
    for (const bad of [null, "abc", { a: 1 }, 5])
      expect(() => normalizeSmsAudienceCriteria({ playerIds: bad })).toThrow(/seleção/);
  });

  it("timing=selection sem lista nem referência lança erro", () => {
    expect(() => normalizeSmsAudienceCriteria({ timing: "selection" })).toThrow(/seleção/);
  });

  it("M1: seleção com qualquer regra lança erro", () => {
    expect(() =>
      normalizeSmsAudienceCriteria({ ...selection([pid(1)]), activity: { deposit: "yes" } }),
    ).toThrow(/não aceita regras/);
    expect(() => normalizeSmsAudienceCriteria({ ...selection([pid(1)]), level: "gold" })).toThrow();
    expect(() =>
      normalizeSmsAudienceCriteria({ playerIds: [pid(1)], timing: "cooling" }),
    ).toThrow();
    expect(() =>
      normalizeSmsAudienceCriteria({ ...selection([pid(1)]), daysWithoutLogin: 5 }),
    ).toThrow();
  });

  it("recusa id que não é uuid e lista acima de 50 mil", () => {
    expect(() => normalizeSmsAudienceCriteria(selection(["abc"]))).toThrow();
    const tooMany = Array.from({ length: 50_001 }, (_, i) => pid(i + 1));
    expect(
      smsAudienceCriteriaSchema.safeParse({ timing: "selection", playerIds: tooMany }).success,
    ).toBe(false);
    const max = Array.from({ length: 50_000 }, (_, i) => pid(i + 1));
    expect(
      smsAudienceCriteriaSchema.safeParse({ timing: "selection", playerIds: max }).success,
    ).toBe(true);
  });

  it("forma de referência: sem a lista, com id e contagem", () => {
    const reference = toSelectionReference(
      normalizeSmsAudienceCriteria(selection([pid(1), pid(2)])),
      AUDIENCE,
    );
    expect(reference.playerIds).toBeUndefined();
    expect(reference).toMatchObject({
      timing: "selection",
      audienceId: AUDIENCE,
      selectionCount: 2,
    });
    expect(normalizeSmsAudienceCriteria(reference)).toEqual(reference);
  });
});

describe("loadTenantPlayersByIds", () => {
  it("I2: lote igual ao da resolução de campanha (300) e filtro da casa em cada lote", async () => {
    expect(SELECTION_ID_CHUNK).toBe(RESOLUTION_CHUNK_SIZE);
    expect(SELECTION_ID_CHUNK).toBe(300);
    const ids = Array.from({ length: SELECTION_ID_CHUNK * 2 + 7 }, (_, i) => pid(i + 1));
    const players = ids.map((id) => ({ id, tenant_id: TENANT, telefone: null, email: null }));
    const { db, queries } = recordingDb(players);
    const rows = await loadTenantPlayersByIds(db, TENANT, ids);
    expect(rows).toHaveLength(ids.length);
    expect(queries).toHaveLength(3);
    for (const ops of queries) {
      expect(ops).toContainEqual({ method: "eq", column: "tenant_id", value: TENANT });
      const inOp = ops.find((op) => op.method === "in")!;
      expect(inOp.column).toBe("id");
    }
    const sizes = queries.map(
      (ops) => (ops.find((op) => op.method === "in")!.value as string[]).length,
    );
    expect(sizes.sort((a, b) => b - a)).toEqual([SELECTION_ID_CHUNK, SELECTION_ID_CHUNK, 7]);
  });

  it("jogador de outra casa não volta mesmo com o id na lista", async () => {
    const { db } = recordingDb([
      { id: pid(1), tenant_id: TENANT, telefone: "+5511999990001", email: null },
      { id: pid(2), tenant_id: OTHER, telefone: "+5511999990002", email: "x@y.com" },
    ]);
    const rows = await loadTenantPlayersByIds<{ id: string }>(db, TENANT, [pid(1), pid(2)]);
    expect(rows.map((r) => r.id)).toEqual([pid(1)]);
  });

  it("sem casa, recusa em vez de consultar sem filtro", async () => {
    const { db, queries } = recordingDb([]);
    await expect(loadTenantPlayersByIds(db, "", [pid(1)])).rejects.toThrow();
    expect(queries).toHaveLength(0);
  });
});

describe("resolveAudienceForTenant", () => {
  const players = [
    { id: pid(1), tenant_id: TENANT, telefone: "+55 11 99999-0001", email: "a@b.com" },
    { id: pid(2), tenant_id: TENANT, telefone: "+5511999990002", email: "" },
    { id: pid(3), tenant_id: TENANT, telefone: "123", email: "c@d.com" },
    { id: pid(4), tenant_id: OTHER, telefone: "+5511999990004", email: "e@f.com" },
  ];

  it("lista: só jogadores da casa, telefone em dígitos, sem chamar o RPC", async () => {
    const { db, rpcCalls } = recordingDb(players);
    const result = await resolveAudienceForTenant(
      db,
      TENANT,
      selection([pid(1), pid(2), pid(3), pid(4)]),
    );
    expect(rpcCalls).toHaveLength(0);
    expect(result.total).toBe(3);
    expect(result.phones).toEqual(["5511999990001", "5511999990002"]);
    expect(result.recipientTotal).toBe(2);
    expect(result.emailPlayerIds.sort()).toEqual([pid(1), pid(3)]);
    expect(result.emailRecipientTotal).toBe(2);
  });

  function withAudience() {
    const fake = createFakeDb();
    fake.rows("players").push(...players);
    fake.rows("sms_audiences").push({
      id: AUDIENCE,
      tenant_id: TENANT,
      criteria: selection([pid(1), pid(2), pid(4)]),
    });
    let rpc = 0;
    fake.onRpc("resolve_sms_audience_v2", () => {
      rpc++;
      return { data: null, error: { message: "não deveria chamar" } };
    });
    return { fake, rpcCount: () => rpc };
  }

  it("referência: o servidor carrega a lista do público pelo id + casa", async () => {
    const { fake, rpcCount } = withAudience();
    const reference = toSelectionReference(normalizeSmsAudienceCriteria(selection([])), AUDIENCE);
    const result = await resolveAudienceForTenant(fake.client, TENANT, reference);
    expect(rpcCount()).toBe(0);
    expect(result.total).toBe(2);
    expect(result.phones).toEqual(["5511999990001", "5511999990002"]);
  });

  it("referência a público de outra casa ou excluído: erro permanente, nada resolvido", async () => {
    const { fake } = withAudience();
    const reference = { timing: "selection", audienceId: AUDIENCE };
    const otherHouse = resolveAudienceForTenant(fake.client, OTHER, reference);
    await expect(otherHouse).rejects.toBeInstanceOf(PermanentAudienceError);
    fake.rows("sms_audiences").length = 0;
    await expect(resolveAudienceForTenant(fake.client, TENANT, reference)).rejects.toThrow(
      SELECTION_AUDIENCE_MISSING,
    );
  });

  it("regressão: sem seleção é a mesma chamada ao RPC de sempre, sem ler players", async () => {
    const { db, rpcCalls, queries } = recordingDb(players);
    const raw = { activity: { deposit: "yes" }, level: "gold" };
    const result = await resolveAudienceForTenant(db, TENANT, raw);
    expect(queries).toHaveLength(0);
    expect(rpcCalls).toEqual([
      {
        fn: "resolve_sms_audience_v2",
        args: { _tenant: TENANT, _criteria: normalizeSmsAudienceCriteria(raw) },
      },
    ]);
    const sent = rpcCalls[0].args._criteria as Row;
    expect(sent.timing).not.toBe("selection");
    expect("playerIds" in sent || "audienceId" in sent).toBe(false);
    expect(result.phones).toEqual(["5511999990001"]);
  });
});

describe("createSelectionAudienceRecord", () => {
  function setup() {
    const fake = createFakeDb();
    fake
      .rows("players")
      .push(
        { id: pid(1), tenant_id: TENANT },
        { id: pid(2), tenant_id: TENANT },
        { id: pid(9), tenant_id: OTHER },
      );
    return fake;
  }

  it("descarta ids de outra casa e grava a seleção com o marcador", async () => {
    const fake = setup();
    const now = new Date("2026-10-23T15:07:00Z");
    const created = await createSelectionAudienceRecord(fake.client, TENANT, {
      playerIds: [pid(1), pid(9), pid(2), pid(1)],
      now,
    });
    expect(created.playerCount).toBe(2);
    expect(created.discarded).toBe(1);
    const [row] = fake.rows("sms_audiences");
    expect(row.id).toBe(created.id);
    expect(row.tenant_id).toBe(TENANT);
    expect(row.name).toBe("Seleção de Jogadores · 23/10 12:07");
    expect(row.description).toBe("2 jogadores escolhidos em Jogadores");
    expect((row.criteria as Row).playerIds).toEqual([pid(1), pid(2)]);
    expect((row.criteria as Row).timing).toBe("selection");
    expect(() => legacyNormalize(row.criteria)).toThrow();
  });

  it("sem nenhum jogador da casa, recusa e não grava", async () => {
    const fake = setup();
    await expect(
      createSelectionAudienceRecord(fake.client, TENANT, { playerIds: [pid(9), pid(77)] }),
    ).rejects.toThrow("Nenhum jogador desta casa na seleção");
    expect(fake.rows("sms_audiences")).toHaveLength(0);
  });

  it("filterPlayerIdsToTenant mantém a ordem e só ids da casa", async () => {
    const fake = setup();
    expect(await filterPlayerIdsToTenant(fake.client, TENANT, [pid(2), pid(9), pid(1)])).toEqual([
      pid(2),
      pid(1),
    ]);
  });

  it("nome no horário de Brasília", () => {
    expect(selectionAudienceName(new Date("2026-01-05T02:30:00Z"))).toBe(
      "Seleção de Jogadores · 04/01 23:30",
    );
  });
});

describe("Públicos (listar e salvar)", () => {
  it("I3: a lista vai ao navegador sem playerIds, com id e contagem", () => {
    const row = toClientAudience({
      id: AUDIENCE,
      name: "Seleção",
      criteria: selection([pid(1), pid(2), pid(3)]),
    });
    expect(row.criteria.playerIds).toBeUndefined();
    expect(row.criteria).toMatchObject({
      timing: "selection",
      audienceId: AUDIENCE,
      selectionCount: 3,
    });
    const rules = toClientAudience({ id: "x", criteria: { level: "gold" } });
    expect(rules.criteria).toEqual(normalizeSmsAudienceCriteria({ level: "gold" }));
  });

  it("renomear um público de seleção mantém a lista gravada", async () => {
    const fake = createFakeDb();
    fake.rows("sms_audiences").push({
      id: AUDIENCE,
      tenant_id: TENANT,
      criteria: selection([pid(1)]),
    });
    const saved = await resolveCriteriaToSave(fake.client, TENANT, AUDIENCE, {
      timing: "selection",
      audienceId: AUDIENCE,
      selectionCount: 1,
    });
    expect(saved.playerIds).toEqual([pid(1)]);
    expect(saved.timing).toBe("selection");
  });

  it("referência de seleção num público novo é recusada", async () => {
    const fake = createFakeDb();
    await expect(
      resolveCriteriaToSave(fake.client, TENANT, undefined, {
        timing: "selection",
        audienceId: AUDIENCE,
      }),
    ).rejects.toThrow(/Jogadores/);
  });

  it("lista nova enviada direto só guarda jogadores da casa", async () => {
    const fake = createFakeDb();
    fake.rows("players").push({ id: pid(1), tenant_id: TENANT }, { id: pid(2), tenant_id: OTHER });
    const saved = await resolveCriteriaToSave(
      fake.client,
      TENANT,
      undefined,
      selection([pid(1), pid(2)]),
    );
    expect(saved.playerIds).toEqual([pid(1)]);
  });

  it("público por regras salva como antes", async () => {
    const fake = createFakeDb();
    const saved = await resolveCriteriaToSave(fake.client, TENANT, undefined, { level: "gold" });
    expect(saved).toEqual(normalizeSmsAudienceCriteria({ level: "gold" }));
  });
});
