// Task 12 — pure anonymization helpers used by the demo clone script.
import { describe, expect, it } from "vitest";

import {
  demoProviderId,
  fakePlayer,
  fakePlayers,
  inDemoSample,
  isValidCpf,
  makeFaker,
  makeRewriteContext,
  phoneForms,
  remapId,
  rewriteText,
  scrubJson,
} from "./anonymize.mjs";

const SOURCE_TENANT = "03b73a96-aef7-414d-94fc-93a996f8256b";
const DEMO_TENANT = "11111111-2222-4333-8444-555555555555";

const maria = {
  id: "6f1d2c3b-0000-4000-8000-000000000001",
  nome: "Maria Aparecida Souza",
  telefone: "+5521987654321",
  email: "maria.souza@gmail.com",
  cpf: "52998224725",
  data_nascimento: "1990-05-17",
  player_external_id: "884512",
  affiliate_id: "AFF-SORTE-77",
  expert: "Joao Expert",
};

describe("makeFaker", () => {
  it("is deterministic per seed", () => {
    const a = makeFaker("seed-1");
    const b = makeFaker("seed-1");
    const c = makeFaker("seed-2");
    const seqA = [a.int(1000), a.int(1000), a.digits(6)];
    expect([b.int(1000), b.int(1000), b.digits(6)]).toEqual(seqA);
    expect([c.int(1000), c.int(1000), c.digits(6)]).not.toEqual(seqA);
  });
});

describe("fakePlayer", () => {
  it("is deterministic and never returns the source identity", () => {
    const first = fakePlayer(maria);
    expect(fakePlayer({ ...maria })).toEqual(first);
    expect(first.telefone).toMatch(/^\+5511900\d{6}$/);
    expect(first.telefone).not.toBe(maria.telefone);
    expect(first.email).toMatch(/@example\.com$/);
    expect(first.email).not.toBe(maria.email);
    expect(first.cpf).not.toBe(maria.cpf);
    expect(isValidCpf(first.cpf)).toBe(true);
    expect(first.nome).not.toMatch(/maria|aparecida|souza/i);
    expect(first.player_external_id).not.toBe(maria.player_external_id);
    expect(first.affiliate_id).not.toBe(maria.affiliate_id);
    expect(first.expert).not.toBe(maria.expert);
  });

  it("keeps the birth date within two years of the original", () => {
    const fake = fakePlayer(maria);
    const days =
      Math.abs(Date.parse(fake.data_nascimento) - Date.parse(maria.data_nascimento)) / 86_400_000;
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThanOrEqual(731);
  });

  it("keeps empty fields empty", () => {
    const fake = fakePlayer({
      id: maria.id,
      nome: "X",
      telefone: null,
      email: null,
      cpf: null,
      data_nascimento: null,
      player_external_id: null,
      affiliate_id: null,
      expert: null,
    });
    expect(fake).toMatchObject({
      telefone: null,
      email: null,
      cpf: null,
      data_nascimento: null,
      player_external_id: null,
      affiliate_id: null,
      expert: null,
    });
  });

  it("maps the same affiliate to the same fake affiliate across players", () => {
    const other = { ...maria, id: "6f1d2c3b-0000-4000-8000-000000000002" };
    expect(fakePlayer(other).affiliate_id).toBe(fakePlayer(maria).affiliate_id);
  });

  it("batch generation keeps phones unique and away from every real phone form", () => {
    const players = Array.from({ length: 300 }, (_, i) => ({
      ...maria,
      id: `6f1d2c3b-0000-4000-8000-${String(i).padStart(12, "0")}`,
      player_external_id: String(i),
    }));
    const avoid = new Set(phoneForms(maria.telefone));
    const out = fakePlayers(players, { avoidForms: avoid });
    const phones = [...out.values()].map((p) => p.telefone);
    expect(new Set(phones).size).toBe(players.length);
    for (const phone of phones) for (const form of phoneForms(phone)) expect(avoid.has(form)).toBe(false);
    expect(fakePlayers(players, { avoidForms: avoid })).toEqual(out);
  });
});

describe("remapId", () => {
  it("is stable, a valid uuid and different from the source", () => {
    const id = remapId("players", maria.id);
    expect(remapId("players", maria.id)).toBe(id);
    expect(remapId("players", maria.id.toUpperCase())).toBe(id);
    expect(id).not.toBe(maria.id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("rejects values that are not uuids", () => {
    expect(() => remapId("players", "abc")).toThrow();
  });
});

describe("demoProviderId", () => {
  it("is deterministic, prefixed and keeps nulls", () => {
    expect(demoProviderId("tx-123")).toBe(demoProviderId("tx-123"));
    expect(demoProviderId("tx-123")).toMatch(/^demo[0-9a-f]{24}$/);
    expect(demoProviderId(null)).toBeNull();
  });
});

describe("rewriteText", () => {
  const fake = fakePlayer(maria);
  const ctx = makeRewriteContext({
    sourceTenantId: SOURCE_TENANT,
    demoTenantId: DEMO_TENANT,
    hosts: ["sortealta.bet", "sortealta.link"],
    players: [{ source: maria, fake }],
  });

  it("replaces player name, brand and real domains", () => {
    const out = rewriteText("Oi Maria, acesse sortealta.bet/x", ctx);
    expect(out).not.toMatch(/maria/i);
    expect(out).not.toMatch(/sortealta/i);
    expect(out).toContain(fake.nome.split(" ")[0]);
    expect(out).toContain("demo.betleads.invalid/x");
  });

  it("replaces phone, e-mail and CPF of the player and any other e-mail", () => {
    const out = rewriteText(
      "Tel (21) 98765-4321 / 5521987654321, mail maria.souza@gmail.com, cpf 529.982.247-25, staff ops@sortealta.bet",
      ctx,
    );
    expect(out).not.toMatch(/98765-4321|5521987654321|gmail|529\.982|sortealta/);
    expect(out).toContain(fake.telefone);
    expect(out).toContain(fake.email);
  });

  it("rewrites brand spellings, short links, query values and uuids", () => {
    const out = rewriteText(
      `SORTE ALTA e Sorte Alta e SorteAlta (pixpgf) https://go.sortealta.link/AbC?btag=AFF1&utm_source=sms tenant ${SOURCE_TENANT} id ${maria.id}`,
      ctx,
    );
    expect(out).toContain("CASA DEMO e Casa Demo e casademo (demo)");
    expect(out).toContain("https://demo.betleads.invalid/AbC?btag=demo&utm_source=sms");
    expect(out).toContain(`tenant ${DEMO_TENANT}`);
    expect(out).toContain(`id ${remapId("players", maria.id)}`);
    expect(out).not.toContain(maria.id);
  });

  it("keeps template variables in query strings and returns null for null", () => {
    expect(rewriteText("https://sortealta.bet/?ref={{player_id}}", ctx)).toBe(
      "https://demo.betleads.invalid/?ref={{player_id}}",
    );
    expect(rewriteText(null, ctx)).toBeNull();
  });

  it("applies exact replacements without remapping them again", () => {
    const path = `${SOURCE_TENANT}/journeys/${maria.id}-voz.mp3`;
    const target = `${DEMO_TENANT}/journeys/new-placeholder.mp3`;
    const local = makeRewriteContext({
      sourceTenantId: SOURCE_TENANT,
      demoTenantId: DEMO_TENANT,
      hosts: [],
      exact: [[path, target]],
    });
    expect(rewriteText(`audio: ${path}`, local)).toBe(`audio: ${target}`);
  });

  it("points images to the placeholder", () => {
    const local = makeRewriteContext({
      sourceTenantId: SOURCE_TENANT,
      demoTenantId: DEMO_TENANT,
      hosts: ["cdn.sortealta.bet"],
      imageUrl: "https://storage.test/placeholder.png",
    });
    const html =
      '<img src="https://cdn.sortealta.bet/logo.PNG?v=2"><img alt="x" src="data:image/png;base64,AAAA"><a href="https://cdn.sortealta.bet/promo">x</a>';
    expect(rewriteText(html, local)).toBe(
      '<img src="https://storage.test/placeholder.png"><img alt="x" src="https://storage.test/placeholder.png"><a href="https://demo.betleads.invalid/promo">x</a>',
    );
  });
});

describe("scrubJson", () => {
  it("keeps only the listed keys, including nested dotted paths", () => {
    const value = {
      variant_index: 1,
      phone: "5521987654321",
      raw: { depositos: 3, nome: "Maria", nested: { a: 1 } },
      normalized: "not-an-object",
    };
    expect(scrubJson(value, ["variant_index", "raw.depositos", "normalized.depositos"])).toEqual({
      variant_index: 1,
      raw: { depositos: 3 },
      normalized: {},
    });
  });

  it("returns an empty object for non-objects and empty keep lists", () => {
    expect(scrubJson(null, ["a"])).toEqual({});
    expect(scrubJson([1, 2], ["a"])).toEqual({});
    expect(scrubJson({ a: 1 }, [])).toEqual({});
  });
});

describe("inDemoSample (R14)", () => {
  it("keeps a deterministic ~50% of ids, case-insensitively", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => remapId("players", `6f1d2c3b-0000-4000-8000-${String(i).padStart(12, "0")}`));
    const picked = ids.filter((id) => inDemoSample(id));
    expect(picked.length / ids.length).toBeGreaterThan(0.45);
    expect(picked.length / ids.length).toBeLessThan(0.55);
    expect(ids.filter((id) => inDemoSample(id))).toEqual(picked);
    for (const id of ids.slice(0, 50)) expect(inDemoSample(id.toUpperCase())).toBe(inDemoSample(id));
    expect(inDemoSample(null)).toBe(false);
  });
});
