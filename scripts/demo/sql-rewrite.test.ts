// Task 12 — the SQL rewrite functions must produce exactly what the JS
// helpers produce (the clone mixes both: SQL for big tables, JS for configs).
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { demoUuid, inDemoSample, makeRewriteContext, rewriteGeneric, scrubJson } from "./anonymize.mjs";
import { rewriteFunctionsSql, scrubJsonSql } from "./sql-rewrite.mjs";

const SOURCE_TENANT = "03b73a96-aef7-414d-94fc-93a996f8256b";
const DEMO_TENANT = "11111111-2222-4333-8444-555555555555";
const HOSTS = ["sortealta.bet", "sortealta.link", "betleads.io", "wa.me"];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  for (const sql of rewriteFunctionsSql({
    sourceTenantId: SOURCE_TENANT,
    demoTenantId: DEMO_TENANT,
    hosts: HOSTS,
    brandNames: ["Sorte Alta Bet"],
  }))
    await db.query(sql);
});

afterAll(async () => {
  await db?.close();
});

const SAMPLES = [
  "plain status",
  "",
  "journey:6F1D2C3B-0000-4000-8000-000000000001",
  `tenant ${SOURCE_TENANT} and 6f1d2c3b-0000-4000-8000-000000000001 twice 6f1d2c3b-0000-4000-8000-000000000001`,
  "https://go.sortealta.link/AbC?btag=AFF1&utm_source=sms&s=sig-123#frag",
  "https://betleads.io/api/public/click/6f1d2c3b-0000-4000-8000-000000000001?s=abc.def",
  "<a href=\"https://sortealta.bet/x?a=1&amp;btag=2\">SORTE ALTA</a> Sorte Alta Bet sorte-alta SorteAlta pixpgf",
  "erro para maria@gmail.com e contato@example.com",
  "https://sortealta.bet/?ref={{player_id}}&x=%7B",
  "wa.me/5521987654321 e www.wa.me",
  "{\"k\": \"https://sortealta.bet/p?id=7\", \"campanha:Sorte Alta outubro:1\": 3}",
];

describe("pg_temp.demo_rw vs rewriteGeneric", () => {
  const ctx = makeRewriteContext({
    sourceTenantId: SOURCE_TENANT,
    demoTenantId: DEMO_TENANT,
    hosts: HOSTS,
    brandNames: ["Sorte Alta Bet"],
  });

  it.each(SAMPLES)("matches for %j", async (sample) => {
    const { rows } = await db.query<{ out: string }>("select pg_temp.demo_rw($1) as out", [sample]);
    expect(rows[0].out).toBe(rewriteGeneric(sample, ctx));
  });

  it("keeps null", async () => {
    const { rows } = await db.query<{ out: string | null }>("select pg_temp.demo_rw(null) as out");
    expect(rows[0].out).toBeNull();
  });
});

describe("pg_temp.demo_uuid vs demoUuid", () => {
  it("derives the same ids and maps the source tenant to the demo tenant", async () => {
    const ids = [
      "6f1d2c3b-0000-4000-8000-000000000001",
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
      "00000000-0000-0000-0000-000000000000",
    ];
    for (const id of ids) {
      const { rows } = await db.query<{ out: string }>("select pg_temp.demo_uuid($1::uuid)::text as out", [id]);
      expect(rows[0].out).toBe(demoUuid(id));
    }
    const { rows } = await db.query<{ out: string }>("select pg_temp.demo_uuid($1::uuid)::text as out", [
      SOURCE_TENANT,
    ]);
    expect(rows[0].out).toBe(DEMO_TENANT);
  });
});

describe("scrubJsonSql vs scrubJson", () => {
  const cases: Array<[unknown, string[]]> = [
    [{ a: 1, b: 2 }, ["a"]],
    [{ raw: { depositos: 3, nome: "x" }, normalized: "s", other: 1 }, ["raw.depositos", "normalized.depositos"]],
    [[1, 2], ["a"]],
    ["text", ["a"]],
    [{ a: null, b: { c: { d: 1, e: 2 } } }, ["a", "b.c.d"]],
  ];
  it.each(cases)("matches for %j", async (value, keep) => {
    const { rows } = await db.query<{ out: unknown }>(`select ${scrubJsonSql("$1::jsonb", keep)} as out`, [
      JSON.stringify(value),
    ]);
    expect(rows[0].out).toEqual(scrubJson(value, keep));
  });
});

describe("pg_temp.demo_in_sample vs inDemoSample (R14)", () => {
  it("agrees on uuids, phones, e-mails and null", async () => {
    const values = [
      ...Array.from({ length: 200 }, (_, i) => `6f1d2c3b-0000-4000-8000-${String(i).padStart(12, "0")}`),
      "5521987654321",
      "Maria.Souza@Gmail.com",
      "deposit_approved:tx-1",
    ];
    const { rows } = await db.query<{ v: string; out: boolean }>(
      `select v, pg_temp.demo_in_sample(v) as out from unnest($1::text[]) v`,
      [values],
    );
    for (const r of rows) expect(r.out, r.v).toBe(inDemoSample(r.v));
    const { rows: nul } = await db.query<{ out: boolean }>("select pg_temp.demo_in_sample(null) as out");
    expect(nul[0].out).toBe(false);
  });
});
