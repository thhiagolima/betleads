import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { refreshPopupAudienceById, runPopupHourly } from "@/lib/popups/audience.server";
import type { PopupsDb } from "@/lib/popups/popups.server";

const resolveAudienceForTenant = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sms-audience-selection.server", () => ({ resolveAudienceForTenant }));

const NOW = new Date("2026-11-13T15:00:00Z");
let fake: ReturnType<typeof createFakeDb>;
const db = () => fake.client as unknown as PopupsDb;

beforeEach(() => {
  fake = createFakeDb();
  resolveAudienceForTenant.mockReset();
  resolveAudienceForTenant.mockResolvedValue({ playerIds: ["pl-1", "pl-2", "pl-1"] });
  fake.onRpc("site_popup_set_audience_generation", (args) => {
    const popup = fake.rows("site_popups").find((r) => r.id === args.p_popup_id)!;
    Object.assign(popup, {
      audience_generation: args.p_generation,
      audience_count: args.p_count,
      audience_refreshed_at: NOW.toISOString(),
    });
    const members = fake.rows("site_popup_audience_members");
    const keep = members.filter((m) => m.popup_id !== args.p_popup_id || m.generation === args.p_generation);
    members.splice(0, members.length, ...keep);
    return { data: null, error: null };
  });
});

describe("refreshPopupAudienceById", () => {
  it("writes the next generation, deduped, then switches to it", async () => {
    fake.rows("site_popups").push({
      id: "p",
      tenant_id: "t",
      status: "ativo",
      audience_kind: "filtro",
      audience_criteria: { x: 1 },
      audience_generation: 3,
    });
    fake.rows("site_popup_audience_members").push({ popup_id: "p", generation: 3, player_id: "velho" });
    expect(await refreshPopupAudienceById(db(), "t", "p")).toBe(2);
    expect(resolveAudienceForTenant).toHaveBeenCalledWith(expect.anything(), "t", { x: 1 }, undefined, {
      includePlayerIds: true,
    });
    expect(fake.rows("site_popup_audience_members")).toEqual([
      expect.objectContaining({ popup_id: "p", generation: 4, player_id: "pl-1" }),
      expect.objectContaining({ popup_id: "p", generation: 4, player_id: "pl-2" }),
    ]);
    expect(fake.rows("site_popups")[0]).toMatchObject({ audience_generation: 4, audience_count: 2 });
  });

  it("does nothing for other audiences, closed popups or another house", async () => {
    fake.rows("site_popups").push(
      { id: "todos", tenant_id: "t", status: "ativo", audience_kind: "todos", audience_generation: 0 },
      { id: "fim", tenant_id: "t", status: "encerrado", audience_kind: "filtro", audience_criteria: {}, audience_generation: 0 },
    );
    expect(await refreshPopupAudienceById(db(), "t", "todos")).toBeNull();
    expect(await refreshPopupAudienceById(db(), "t", "fim")).toBeNull();
    expect(await refreshPopupAudienceById(db(), "outra", "todos")).toBeNull();
    expect(resolveAudienceForTenant).not.toHaveBeenCalled();
  });
});

describe("runPopupHourly", () => {
  it("closes expired popups and refreshes stale filtro audiences only", async () => {
    fake.rows("site_popups").push(
      { id: "vencido", tenant_id: "t", status: "ativo", audience_kind: "todos", ends_at: "2026-11-13T14:00:00Z" },
      { id: "rascunho-vencido", tenant_id: "t", status: "rascunho", audience_kind: "todos", ends_at: "2026-11-13T14:00:00Z" },
      { id: "velho", tenant_id: "t", status: "ativo", audience_kind: "filtro", audience_criteria: {}, audience_generation: 0, audience_refreshed_at: "2026-11-13T13:00:00Z" },
      { id: "recente", tenant_id: "t", status: "pausado", audience_kind: "filtro", audience_criteria: {}, audience_generation: 0, audience_refreshed_at: "2026-11-13T14:30:00Z" },
      { id: "nunca", tenant_id: "t", status: "ativo", audience_kind: "filtro", audience_criteria: {}, audience_generation: 0, audience_refreshed_at: null },
    );
    const result = await runPopupHourly(db(), { now: NOW });
    expect(result).toMatchObject({ encerrados: 1, refreshed: 2, errors: [], truncated: false });
    const status = Object.fromEntries(fake.rows("site_popups").map((r) => [r.id, r.status]));
    expect(status).toMatchObject({ vencido: "encerrado", "rascunho-vencido": "rascunho" });
    expect(fake.rows("site_popups").find((r) => r.id === "recente")!.audience_generation).toBe(0);
  });

  it("keeps going after one popup fails and stops at the time budget", async () => {
    fake.rows("site_popups").push(
      { id: "a", tenant_id: "t", status: "ativo", audience_kind: "filtro", audience_criteria: {}, audience_generation: 0, audience_refreshed_at: null },
      { id: "b", tenant_id: "t", status: "ativo", audience_kind: "filtro", audience_criteria: {}, audience_generation: 0, audience_refreshed_at: null },
    );
    resolveAudienceForTenant.mockRejectedValueOnce(new Error("público inválido"));
    const result = await runPopupHourly(db(), { now: NOW });
    expect(result.refreshed).toBe(1);
    expect(result.errors).toEqual([{ popupId: "a", message: "público inválido" }]);

    let t = 0;
    const truncated = await runPopupHourly(db(), {
      now: new Date(NOW.getTime() + 3_600_000 * 2),
      budgetMs: 10,
      clock: () => (t += 20),
    });
    expect(truncated.truncated).toBe(true);
  });
});
