import { beforeEach, describe, expect, it } from "vitest";

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import type { PopupsDb } from "@/lib/popups/popups.server";
import { createPopupPublicService } from "@/lib/popups/public.server";

const TENANT = "tenant-1";
const ORIGIN = "https://casa.bet";
const NOW = Date.parse("2026-11-13T15:00:00Z");

let fake: ReturnType<typeof createFakeDb>;
let clock: number;

function popupRow(over: Record<string, unknown>) {
  return {
    tenant_id: TENANT,
    status: "ativo",
    prioridade: 0,
    starts_at: null,
    ends_at: null,
    formato: "central",
    image_url: null,
    titulo: "Oi",
    texto: null,
    botao_label: null,
    botao_url: null,
    audience_kind: "todos",
    audience_generation: 0,
    paginas_modo: "todas",
    paginas: [],
    atraso_segundos: 0,
    frequencia: "dia",
    frequencia_dias: null,
    ...over,
  };
}

function service() {
  return createPopupPublicService(fake.client as unknown as PopupsDb, { clock: () => clock });
}

beforeEach(() => {
  fake = createFakeDb();
  clock = NOW;
  fake.rows("tenant_webpush_settings").push({ tenant_id: TENANT, public_token: "tok", popup_player_seen_at: null });
  fake.rows("tenant_webpush_apps").push(
    { tenant_id: TENANT, origin: ORIGIN, status: "ativo" },
    { tenant_id: TENANT, origin: "https://antigo.bet", status: "desativado" },
  );
  fake.rows("players").push({ id: "pl-1", tenant_id: TENANT, player_external_id: "ext-1" });
});

describe("eligiblePopups", () => {
  it("returns nothing for an unknown token or an origin the house never registered", async () => {
    fake.rows("site_popups").push(popupRow({ id: "a" }));
    const svc = service();
    expect(await svc.eligiblePopups({ token: "nope", origin: ORIGIN, playerId: null })).toEqual([]);
    expect(await svc.eligiblePopups({ token: "tok", origin: "https://outro.site", playerId: null })).toEqual([]);
    expect(await svc.eligiblePopups({ token: "tok", origin: "https://antigo.bet", playerId: null })).toEqual([]);
    expect(await svc.eligiblePopups({ token: "tok", origin: null, playerId: null })).toEqual([]);
  });

  it("returns active popups in their period, highest priority first, without internal fields", async () => {
    fake.rows("site_popups").push(
      popupRow({ id: "baixa", prioridade: 1 }),
      popupRow({ id: "alta", prioridade: 9 }),
      popupRow({ id: "pausado", status: "pausado" }),
      popupRow({ id: "futuro", starts_at: "2026-11-14T00:00:00Z" }),
      popupRow({ id: "acabou", ends_at: "2026-11-13T14:00:00Z" }),
      popupRow({ id: "outra-casa", tenant_id: "tenant-2" }),
    );
    const popups = await service().eligiblePopups({ token: "tok", origin: `${ORIGIN}/`, playerId: null });
    expect(popups.map((p) => p.id)).toEqual(["alta", "baixa"]);
    expect(popups[0]).not.toHaveProperty("tenant_id");
    expect(popups[0]).not.toHaveProperty("audience_kind");
  });

  it("splits logged and anonymous visitors by the presence of a player id", async () => {
    fake.rows("site_popups").push(
      popupRow({ id: "logados", audience_kind: "logados" }),
      popupRow({ id: "deslogados", audience_kind: "deslogados" }),
    );
    const svc = service();
    expect((await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: "ext-1" })).map((p) => p.id)).toEqual([
      "logados",
    ]);
    expect((await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: "  " })).map((p) => p.id)).toEqual([
      "deslogados",
    ]);
  });

  it("shows a filtro popup only to members of its current generation", async () => {
    fake.rows("site_popups").push(popupRow({ id: "vip", audience_kind: "filtro", audience_generation: 2 }));
    fake.rows("site_popup_audience_members").push(
      { popup_id: "vip", generation: 1, player_id: "pl-old" },
      { popup_id: "vip", generation: 2, player_id: "pl-1" },
    );
    fake.rows("players").push({ id: "pl-old", tenant_id: TENANT, player_external_id: "ext-old" });
    const svc = service();
    expect(await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: "ext-1" })).toHaveLength(1);
    expect(await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: "ext-old" })).toEqual([]);
    expect(await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: "desconhecido" })).toEqual([]);
    expect(await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: null })).toEqual([]);
  });

  it("records the first identified player once", async () => {
    fake.rows("site_popups").push(popupRow({ id: "a" }));
    const svc = service();
    await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: "ext-1" });
    expect(fake.rows("tenant_webpush_settings")[0]!.popup_player_seen_at).toBe(new Date(NOW).toISOString());
    const playerLookups = () => fake.calls.filter((c) => c.table === "players").length;
    const before = playerLookups();
    await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: "ext-1" });
    expect(playerLookups()).toBe(before);
  });

  it("caches the house for 60 s", async () => {
    const svc = service();
    expect(await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: null })).toEqual([]);
    fake.rows("site_popups").push(popupRow({ id: "novo" }));
    expect(await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: null })).toEqual([]);
    clock += 61_000;
    expect(await svc.eligiblePopups({ token: "tok", origin: ORIGIN, playerId: null })).toHaveLength(1);
  });
});

describe("recordEvent", () => {
  it("counts only valid events of this house's active popups from its origins", async () => {
    fake.rows("site_popups").push(popupRow({ id: "a" }), popupRow({ id: "b", tenant_id: "tenant-2" }));
    const counted: unknown[] = [];
    fake.onRpc("site_popup_record_event", (args) => {
      counted.push(args);
      return { data: true, error: null };
    });
    const svc = service();
    expect(await svc.recordEvent({ token: "tok", origin: ORIGIN, popupId: "a", kind: "clique" })).toBe(true);
    expect(await svc.recordEvent({ token: "tok", origin: ORIGIN, popupId: "b", kind: "clique" })).toBe(false);
    expect(await svc.recordEvent({ token: "tok", origin: ORIGIN, popupId: "a", kind: "hack" })).toBe(false);
    expect(await svc.recordEvent({ token: "tok", origin: "https://x.site", popupId: "a", kind: "clique" })).toBe(false);
    expect(counted).toEqual([{ p_popup_id: "a", p_kind: "clique" }]);
  });
});
