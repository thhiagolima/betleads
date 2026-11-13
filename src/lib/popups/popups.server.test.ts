import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  deletePopupDraft,
  duplicatePopup,
  getPopupDailyStats,
  getPopupInstallState,
  listPopups,
  savePopup,
  setPopupStatus,
  type PopupsDb,
} from "@/lib/popups/popups.server";
import { EMPTY_POPUP_DRAFT, type PopupDraft } from "@/lib/popups/shared";

vi.mock("@/lib/sms-audience-selection.server", () => ({
  resolveAudienceForTenant: vi.fn(async () => ({ playerIds: ["pl-1", "pl-2", "pl-1"] })),
}));

const TENANT = "tenant-1";
const NOW = new Date("2026-11-13T15:00:00Z");
const draft: PopupDraft = { ...EMPTY_POPUP_DRAFT, nome: "Bônus", titulo: "Ganhe" };

let fake: ReturnType<typeof createFakeDb>;
const db = () => fake.client as unknown as PopupsDb;

beforeEach(() => {
  fake = createFakeDb();
});

async function create(over: Partial<PopupDraft> = {}) {
  return savePopup(db(), { tenantId: TENANT, id: null, draft: { ...draft, ...over }, userId: "u1", now: NOW });
}

describe("savePopup", () => {
  it("creates a draft with the validated columns", async () => {
    const { id, status } = await create({ nome: "  Bônus  " });
    expect(status).toBe("rascunho");
    const row = fake.rows("site_popups").find((r) => r.id === id)!;
    expect(row).toMatchObject({ tenant_id: TENANT, nome: "Bônus", status: "rascunho", created_by: "u1" });
  });

  it("refuses an invalid draft with the house-facing message", async () => {
    await expect(create({ titulo: null })).rejects.toThrow(/título ou uma imagem/);
  });

  it("flags an audience change only when the CRM criteria changed", async () => {
    const created = await create({ audienceKind: "filtro", audienceCriteria: { a: 1 }, audienceLabel: "VIP" });
    expect(created.audienceChanged).toBe(true);
    const same = await savePopup(db(), {
      tenantId: TENANT,
      id: created.id,
      draft: { ...draft, audienceKind: "filtro", audienceCriteria: { a: 1 }, titulo: "Outro" },
      userId: "u1",
      now: NOW,
    });
    expect(same.audienceChanged).toBe(false);
    const changed = await savePopup(db(), {
      tenantId: TENANT,
      id: created.id,
      draft: { ...draft, audienceKind: "filtro", audienceCriteria: { a: 2 } },
      userId: "u1",
      now: NOW,
    });
    expect(changed.audienceChanged).toBe(true);
  });

  it("never touches another house's popup or a closed one", async () => {
    const { id } = await create();
    await expect(
      savePopup(db(), { tenantId: "tenant-2", id, draft, userId: "u1", now: NOW }),
    ).rejects.toThrow(/não encontrado/);
    fake.rows("site_popups")[0]!.status = "encerrado";
    await expect(savePopup(db(), { tenantId: TENANT, id, draft, userId: "u1", now: NOW })).rejects.toThrow(/encerrado/);
  });
});

describe("setPopupStatus", () => {
  it("follows the allowed transitions", async () => {
    const { id } = await create();
    await expect(setPopupStatus(db(), { tenantId: TENANT, id, status: "pausado", now: NOW })).rejects.toThrow();
    expect((await setPopupStatus(db(), { tenantId: TENANT, id, status: "ativo", now: NOW })).status).toBe("ativo");
    await setPopupStatus(db(), { tenantId: TENANT, id, status: "pausado", now: NOW });
    await setPopupStatus(db(), { tenantId: TENANT, id, status: "encerrado", now: NOW });
    await expect(setPopupStatus(db(), { tenantId: TENANT, id, status: "ativo", now: NOW })).rejects.toThrow();
  });

  it("refuses to activate a popup whose end date passed and asks for the audience on filtro", async () => {
    const past = await create({ endsAt: "2026-11-12T00:00:00Z" });
    await expect(setPopupStatus(db(), { tenantId: TENANT, id: past.id, status: "ativo", now: NOW })).rejects.toThrow(
      /fim já passou/,
    );
    const filtro = await create({ audienceKind: "filtro", audienceCriteria: { a: 1 } });
    const result = await setPopupStatus(db(), { tenantId: TENANT, id: filtro.id, status: "ativo", now: NOW });
    expect(result.needsAudience).toBe(true);
  });
});

describe("duplicate and delete", () => {
  it("duplicates as a draft and deletes only drafts", async () => {
    const { id } = await create();
    await setPopupStatus(db(), { tenantId: TENANT, id, status: "ativo", now: NOW });
    const copy = await duplicatePopup(db(), { tenantId: TENANT, id, userId: "u2" });
    const copyRow = fake.rows("site_popups").find((r) => r.id === copy.id)!;
    expect(copyRow).toMatchObject({ nome: "Bônus (cópia)", status: "rascunho" });
    await expect(deletePopupDraft(db(), { tenantId: TENANT, id })).rejects.toThrow(/rascunhos/);
    await deletePopupDraft(db(), { tenantId: TENANT, id: copy.id });
    expect(fake.rows("site_popups").map((r) => r.id)).toEqual([id]);
  });
});

describe("listPopups and stats", () => {
  it("sums the last 7 days and orders active first, then by priority", async () => {
    fake.rows("site_popups").push(
      { id: "r", tenant_id: TENANT, nome: "R", status: "rascunho", prioridade: 9, updated_at: "1" },
      { id: "a1", tenant_id: TENANT, nome: "A1", status: "ativo", prioridade: 1, updated_at: "1" },
      { id: "a2", tenant_id: TENANT, nome: "A2", status: "ativo", prioridade: 5, starts_at: "2026-11-20T00:00:00Z", updated_at: "1" },
      { id: "x", tenant_id: "tenant-2", nome: "X", status: "ativo", prioridade: 0, updated_at: "1" },
    );
    fake.rows("site_popup_daily_stats").push(
      { popup_id: "a1", tenant_id: TENANT, dia: "2026-11-13", exibicoes: 10, cliques: 2, fechamentos: 3 },
      { popup_id: "a1", tenant_id: TENANT, dia: "2026-11-07", exibicoes: 5, cliques: 1, fechamentos: 0 },
      { popup_id: "a1", tenant_id: TENANT, dia: "2026-11-06", exibicoes: 100, cliques: 100, fechamentos: 100 },
    );
    const list = await listPopups(db(), TENANT, NOW);
    expect(list.map((p) => p.id)).toEqual(["a2", "a1", "r"]);
    expect(list.find((p) => p.id === "a1")!.ultimos7Dias).toEqual({ exibicoes: 15, cliques: 3, fechamentos: 3 });
    expect(list.find((p) => p.id === "a2")!.aguardandoInicio).toBe(true);
  });

  it("fills every day of the period, zero where nothing happened", async () => {
    fake.rows("site_popups").push({ id: "a", tenant_id: TENANT, nome: "A", status: "ativo" });
    fake.rows("site_popup_daily_stats").push({
      popup_id: "a",
      tenant_id: TENANT,
      dia: "2026-11-12",
      exibicoes: "4",
      cliques: "1",
      fechamentos: "0",
    });
    const points = await getPopupDailyStats(db(), { tenantId: TENANT, id: "a", days: 3, now: NOW });
    expect(points).toEqual([
      { dia: "2026-11-11", exibicoes: 0, cliques: 0, fechamentos: 0 },
      { dia: "2026-11-12", exibicoes: 4, cliques: 1, fechamentos: 0 },
      { dia: "2026-11-13", exibicoes: 0, cliques: 0, fechamentos: 0 },
    ]);
  });
});

describe("getPopupInstallState", () => {
  it("reports the loader from the push integration", async () => {
    expect(await getPopupInstallState(db(), TENANT)).toMatchObject({ installed: false, loaderSnippet: "" });
    fake.rows("tenant_webpush_settings").push({ tenant_id: TENANT, public_token: "tok", popup_player_seen_at: null });
    fake.rows("tenant_webpush_apps").push(
      { tenant_id: TENANT, origin: "https://casa.bet", status: "ativo", script_seen_at: "2026-11-10T00:00:00Z", player_linked_at: null },
      { tenant_id: TENANT, origin: "https://velho.bet", status: "desativado", script_seen_at: "2026-11-12T00:00:00Z", player_linked_at: "x" },
    );
    const state = await getPopupInstallState(db(), TENANT);
    expect(state).toMatchObject({
      installed: true,
      scriptSeenAt: "2026-11-10T00:00:00Z",
      playerIdSeen: false,
      origins: ["https://casa.bet"],
    });
    expect(state.loaderSnippet).toContain("loader.js?t=tok");
  });
});
