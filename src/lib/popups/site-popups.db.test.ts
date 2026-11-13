// Popups nas casas — PGlite test for
// supabase/migrations/20261230100000_site_popups.sql: table checks, the event
// counter RPC and the audience generation swap, on the fully migrated db.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migratedPglitePath = "../../../scripts/demo/test-support/migrated-pglite.mjs";
const { createMigratedDb } = (await import(/* @vite-ignore */ migratedPglitePath)) as {
  createMigratedDb: () => Promise<{ db: PGlite }>;
};

const TENANT = "5e1d2c3b-0000-4000-8000-000000000001";
const POPUP = "5e1d2c3b-0000-4000-8000-0000000000a1";
const P1 = "5e1d2c3b-0000-4000-8000-0000000000b1";
const P2 = "5e1d2c3b-0000-4000-8000-0000000000b2";

let db: PGlite;

beforeAll(async () => {
  ({ db } = await createMigratedDb());
  await db.query(
    `insert into public.tenants (id, nome, slug, status, plano, is_demo)
     values ($1, 'Casa Popup', 'popup-teste', 'active', 'starter', false)`,
    [TENANT],
  );
  await db.query(
    `insert into public.site_popups (id, tenant_id, nome, titulo) values ($1, $2, 'Boas-vindas', 'Olá')`,
    [POPUP, TENANT],
  );
});

afterAll(async () => {
  await db?.close();
});

async function insertFails(sql: string, params: unknown[]): Promise<boolean> {
  try {
    await db.query(sql, params);
    return false;
  } catch {
    return true;
  }
}

describe("site_popups checks", () => {
  it("defaults to a draft shown to everyone, on every page, once a day", async () => {
    const { rows } = await db.query<Record<string, unknown>>(
      `select status, audience_kind, paginas_modo, frequencia, formato from public.site_popups where id = $1`,
      [POPUP],
    );
    expect(rows[0]).toEqual({
      status: "rascunho",
      audience_kind: "todos",
      paginas_modo: "todas",
      frequencia: "dia",
      formato: "central",
    });
  });

  it("refuses a popup with nothing to show", async () => {
    expect(
      await insertFails(`insert into public.site_popups (tenant_id, nome) values ($1, 'Vazio')`, [TENANT]),
    ).toBe(true);
  });

  it("refuses http links and images", async () => {
    expect(
      await insertFails(
        `insert into public.site_popups (tenant_id, nome, titulo, botao_label, botao_url)
         values ($1, 'x', 'x', 'Ir', 'http://casa.example')`,
        [TENANT],
      ),
    ).toBe(true);
    expect(
      await insertFails(
        `insert into public.site_popups (tenant_id, nome, image_url) values ($1, 'x', 'javascript:alert(1)')`,
        [TENANT],
      ),
    ).toBe(true);
  });

  it("requires the button label and link together", async () => {
    expect(
      await insertFails(
        `insert into public.site_popups (tenant_id, nome, titulo, botao_label) values ($1, 'x', 'x', 'Ir')`,
        [TENANT],
      ),
    ).toBe(true);
  });

  it("requires criteria for the filtro audience and pages for incluir/excluir", async () => {
    expect(
      await insertFails(
        `insert into public.site_popups (tenant_id, nome, titulo, audience_kind) values ($1, 'x', 'x', 'filtro')`,
        [TENANT],
      ),
    ).toBe(true);
    expect(
      await insertFails(
        `insert into public.site_popups (tenant_id, nome, titulo, paginas_modo) values ($1, 'x', 'x', 'incluir')`,
        [TENANT],
      ),
    ).toBe(true);
  });

  it("refuses an end before the start", async () => {
    expect(
      await insertFails(
        `insert into public.site_popups (tenant_id, nome, titulo, starts_at, ends_at)
         values ($1, 'x', 'x', now(), now() - interval '1 day')`,
        [TENANT],
      ),
    ).toBe(true);
  });
});

describe("site_popup_record_event", () => {
  it("adds each event to today's counters", async () => {
    await db.query(`select public.site_popup_record_event($1, 'exibicao')`, [POPUP]);
    await db.query(`select public.site_popup_record_event($1, 'exibicao')`, [POPUP]);
    await db.query(`select public.site_popup_record_event($1, 'clique')`, [POPUP]);
    await db.query(`select public.site_popup_record_event($1, 'fechamento')`, [POPUP]);
    const { rows } = await db.query<Record<string, unknown>>(
      `select tenant_id, exibicoes::int, cliques::int, fechamentos::int from public.site_popup_daily_stats where popup_id = $1`,
      [POPUP],
    );
    expect(rows).toEqual([{ tenant_id: TENANT, exibicoes: 2, cliques: 1, fechamentos: 1 }]);
  });

  it("ignores an unknown popup and refuses an unknown kind", async () => {
    const { rows } = await db.query<{ ok: boolean }>(
      `select public.site_popup_record_event('5e1d2c3b-0000-4000-8000-0000000000ff', 'clique') as ok`,
    );
    expect(rows[0]!.ok).toBe(false);
    expect(await insertFails(`select public.site_popup_record_event($1, 'hack')`, [POPUP])).toBe(true);
  });
});

describe("site_popup_set_audience_generation", () => {
  it("switches to the new generation and drops the old ones", async () => {
    await db.query(
      `insert into public.site_popup_audience_members (popup_id, generation, player_id)
       values ($1, 0, $2), ($1, 1, $3)`,
      [POPUP, P1, P2],
    );
    await db.query(`select public.site_popup_set_audience_generation($1, 1, 1)`, [POPUP]);
    const members = await db.query<{ generation: number; player_id: string }>(
      `select generation, player_id from public.site_popup_audience_members where popup_id = $1`,
      [POPUP],
    );
    expect(members.rows).toEqual([{ generation: 1, player_id: P2 }]);
    const popup = await db.query<Record<string, unknown>>(
      `select audience_generation, audience_count, audience_refreshed_at is not null as refreshed
       from public.site_popups where id = $1`,
      [POPUP],
    );
    expect(popup.rows[0]).toEqual({ audience_generation: 1, audience_count: 1, refreshed: true });
  });
});
