/* eslint-disable @typescript-eslint/no-explicit-any -- dublês mínimos do query builder. */
// Segunda revisão do público de seleção: listagem leve e tolerante, critério
// corrompido no worker, campanha/rascunho recusando a lista, lista vazia.
import { describe, expect, it, vi } from "vitest";
import { ScheduleBulkSchema } from "./sms.functions";
import { draftPayloadSchema } from "./campaign-drafts.functions";
import {
  campaignAudienceCriteriaInput,
  normalizeSmsAudienceCriteria,
} from "./sms-audience-criteria";
import {
  createSelectionAudienceRecord,
  PermanentAudienceError,
  resolveAudienceForTenant,
} from "./sms-audience-selection.server";
import { listTenantAudiences, resolveCriteriaToSave } from "./sms-audience-crud.functions";
import { createFakeDb } from "./sms-bulk.test-support";

type Row = Record<string, unknown>;
const TENANT = "00000000-0000-4000-8000-00000000a001";
const OTHER = "00000000-0000-4000-8000-00000000b002";
const AUDIENCE = "00000000-0000-4000-8000-0000000c0001";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Dublê das duas leituras de `sms_audiences` (regras / seleção), gravando filtros e colunas. */
function listingDb(opts: { rules: Row[]; selections: Row[] }) {
  const reads: Array<{ columns: string; filters: string[] }> = [];
  return {
    reads,
    from(table: string) {
      expect(table).toBe("sms_audiences");
      const read = { columns: "", filters: [] as string[] };
      reads.push(read);
      const builder: any = {
        select: (columns: string) => ((read.columns = columns), builder),
        eq: (column: string, value: unknown) => (
          read.filters.push(`eq:${column}=${value}`),
          builder
        ),
        or: (expr: string) => (read.filters.push(`or:${expr}`), builder),
        then: (resolve: (v: unknown) => unknown) => {
          const isSelection = read.filters.includes("eq:criteria->>timing=selection");
          return Promise.resolve({
            data: isSelection ? opts.selections : opts.rules,
            error: null,
          }).then(resolve);
        },
      };
      return builder;
    },
  };
}

describe("listTenantAudiences: listagem leve e tolerante", () => {
  it("seleção não lê playerIds: só a contagem gravada, na forma de referência", async () => {
    const db = listingDb({
      rules: [
        { id: "r1", name: "Ouro", updated_at: "2026-10-20T00:00:00Z", criteria: { level: "gold" } },
      ],
      selections: [
        { id: AUDIENCE, name: "Seleção", updated_at: "2026-10-22T00:00:00Z", selection_count: 3 },
      ],
    });
    const list = await listTenantAudiences(db, TENANT);
    expect(db.reads).toHaveLength(2);
    for (const read of db.reads) expect(read.filters).toContain(`eq:tenant_id=${TENANT}`);
    const selectionRead = db.reads.find((r) =>
      r.filters.includes("eq:criteria->>timing=selection"),
    )!;
    expect(selectionRead.columns).toBe(
      "id,name,description,created_at,updated_at,selection_count:criteria->selectionCount",
    );
    const rulesRead = db.reads.find((r) => r !== selectionRead)!;
    expect(rulesRead.columns).toContain("criteria");
    expect(rulesRead.filters).toContain(
      "or:criteria->>timing.is.null,criteria->>timing.neq.selection",
    );
    // updated_at desc na lista final
    expect(list.map((a) => a.id)).toEqual([AUDIENCE, "r1"]);
    expect(list[0].criteria).toMatchObject({
      timing: "selection",
      audienceId: AUDIENCE,
      selectionCount: 3,
    });
    expect(list[0].criteria.playerIds).toBeUndefined();
    expect(list[0].selection_count).toBeUndefined();
    expect(list[1].criteria).toEqual(normalizeSmsAudienceCriteria({ level: "gold" }));
  });

  it("linha inválida é registrada e pulada, sem derrubar a listagem", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = listingDb({
      rules: [
        { id: "ok", name: "Ok", updated_at: "2026-10-20T00:00:00Z", criteria: {} },
        {
          id: "bad",
          name: "Ruim",
          updated_at: "2026-10-21T00:00:00Z",
          criteria: { playerIds: null },
        },
      ],
      selections: [],
    });
    const list = await listTenantAudiences(db, TENANT);
    expect(list.map((a) => a.id)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ id: "bad" }));
    warn.mockRestore();
  });

  it("createSelectionAudienceRecord grava selectionCount junto da lista e do marcador", async () => {
    const fake = createFakeDb();
    fake.rows("players").push({ id: pid(1), tenant_id: TENANT }, { id: pid(2), tenant_id: TENANT });
    await createSelectionAudienceRecord(fake.client, TENANT, { playerIds: [pid(1), pid(2)] });
    expect(fake.rows("sms_audiences")[0].criteria).toMatchObject({
      timing: "selection",
      playerIds: [pid(1), pid(2)],
      selectionCount: 2,
    });
  });
});

describe("critério corrompido no worker → erro permanente", () => {
  it("audience_criteria da campanha inválido, sem chamar o RPC", async () => {
    const fake = createFakeDb();
    let rpc = 0;
    fake.onRpc("resolve_sms_audience_v2", () => {
      rpc++;
      return { data: null, error: null };
    });
    for (const bad of [{ playerIds: "x" }, { timing: "selection" }, { timing: "nope" }])
      await expect(resolveAudienceForTenant(fake.client, TENANT, bad)).rejects.toBeInstanceOf(
        PermanentAudienceError,
      );
    expect(rpc).toBe(0);
  });

  it("critério gravado do público de seleção inválido", async () => {
    const fake = createFakeDb();
    fake.rows("sms_audiences").push({
      id: AUDIENCE,
      tenant_id: TENANT,
      criteria: { timing: "selection", playerIds: { a: 1 } },
    });
    const error = await resolveAudienceForTenant(fake.client, TENANT, {
      timing: "selection",
      audienceId: AUDIENCE,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(PermanentAudienceError);
    expect(String(error.message)).toContain("inválida");
  });

  it("erro de banco continua transitório (não permanente)", async () => {
    const fake = createFakeDb();
    fake.failNext("sms_audiences", "select", "connection reset");
    const error = await resolveAudienceForTenant(fake.client, TENANT, {
      timing: "selection",
      audienceId: AUDIENCE,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentAudienceError);
  });
});

describe("campanha e rascunho recusam a lista de jogadores", () => {
  it("campaignAudienceCriteriaInput aceita só a referência", () => {
    expect(campaignAudienceCriteriaInput.safeParse({ playerIds: [pid(1)] }).success).toBe(false);
    expect(
      campaignAudienceCriteriaInput.safeParse({ timing: "selection", audienceId: AUDIENCE })
        .success,
    ).toBe(true);
    expect(campaignAudienceCriteriaInput.safeParse({ level: "gold" }).success).toBe(true);
  });

  it("scheduleBulkSms recusa critério com playerIds", () => {
    const base = { content: "Oi", campaignName: "C", scheduledAt: "2026-10-24T12:00:00Z" };
    const withList = { timing: "selection", playerIds: [pid(1)] };
    const reference = { timing: "selection", audienceId: AUDIENCE };
    expect(ScheduleBulkSchema.safeParse({ ...base, audienceCriteria: withList }).success).toBe(
      false,
    );
    expect(ScheduleBulkSchema.safeParse({ ...base, audienceCriteria: reference }).success).toBe(
      true,
    );
  });

  it("rascunho de campanha recusa critério com playerIds", () => {
    const withList = { playerIds: [pid(1)] };
    const reference = { timing: "selection", audienceId: AUDIENCE };
    expect(
      draftPayloadSchema.safeParse({ channel: "sms", audienceCriteria: withList }).success,
    ).toBe(false);
    expect(
      draftPayloadSchema.safeParse({ channel: "sms", audienceCriteria: reference }).success,
    ).toBe(true);
  });
});

describe("resolveCriteriaToSave com lista vazia após o filtro da casa", () => {
  it("recusa com a mesma mensagem da criação", async () => {
    const fake = createFakeDb();
    fake.rows("players").push({ id: pid(2), tenant_id: OTHER });
    await expect(
      resolveCriteriaToSave(fake.client, TENANT, undefined, {
        timing: "selection",
        playerIds: [pid(2)],
      }),
    ).rejects.toThrow("Nenhum jogador desta casa na seleção");
  });
});
