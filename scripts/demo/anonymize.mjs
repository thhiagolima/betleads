// Pure anonymization helpers for the demo tenant clone (Task 12).
//
// Ids and identities seeded by source ROW ids are deterministic (a reset
// rebuilds the same ids and the same fake players). Anything derived from a
// real VALUE (provider ids, hashes, affiliate codes, expert names, loose
// phones, unknown short links) is keyed with a per-run random `secret`
// instead, so a fake value can never be checked against a guessed real one
// (fix round, item 2). Tests pass a fixed secret. No I/O.
//
// The generic text rules (uuid remap, e-mails, query values, hosts, brand) are
// exported as data so `sql-rewrite.mjs` builds the SQL twin of `rewriteText`
// from the same patterns; a test asserts both produce identical output.
import { createHash } from "node:crypto";

export const DEMO_DOMAIN = "demo.betleads.invalid";
export const DEMO_BRAND = "Casa Demo";
export const DEMO_SLUG = "demo";
export const FAKE_PHONE_PREFIX = "+5511900";

const md5 = (value) => createHash("md5").update(value).digest("hex");

export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_EXACT = new RegExp(`^${UUID_PATTERN}$`, "i");

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Fixed namespace of the demo remap (RFC 4122 name-based uuids). */
export const DEMO_NAMESPACE = "b5f0e6a8-3c1d-4e9b-9a57-6d2c4e8f1a03";
const NAMESPACE_BYTES = Buffer.from(DEMO_NAMESPACE.replace(/-/g, ""), "hex");

/**
 * Deterministic demo uuid for a source uuid: RFC 4122 version-3 uuid
 * (name-based, MD5) of the lower-case source id under DEMO_NAMESPACE. MD5
 * rather than v5/SHA-1 because Postgres has md5() built in; the SQL twin
 * `pg_temp.demo_uuid` in sql-rewrite.mjs computes the same bytes. Version 3
 * (not a custom version) because CHECK constraints such as
 * link_dispatches_conversion_source_uuid accept only versions 1–5.
 * The mapping is global per id (uuids are unique across tables), so a uuid
 * embedded in text/jsonb remaps to the same value as the column it points to.
 */
export function demoUuid(sourceId) {
  const id = String(sourceId).toLowerCase();
  if (!UUID_EXACT.test(id)) throw new Error(`not a uuid: ${sourceId}`);
  const h = createHash("md5").update(Buffer.concat([NAMESPACE_BYTES, Buffer.from(id, "utf8")])).digest("hex");
  const variant = "89ab"[parseInt(h[16], 16) & 3];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-3${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Ruling R14: the demo holds a deterministic ~50% sample of the source players.
 * A value (player id, or the phone / e-mail / event key of a row with no
 * player) is in the sample when the first hex digit of md5("demo-sample:" +
 * lower(value)) is 0–7. Stable across reruns; the SQL twin is
 * `pg_temp.demo_in_sample` (sql-rewrite.mjs).
 */
export const DEMO_SAMPLE_SALT = "demo-sample:";
export function inDemoSample(value) {
  if (value === null || value === undefined) return false;
  return md5(`${DEMO_SAMPLE_SALT}${String(value).toLowerCase()}`)[0] < "8";
}

/** `table` names the column's table for readability; the derivation is per id (see demoUuid). */
export function remapId(table, sourceId) {
  if (!table) throw new Error("remapId: table is required");
  return demoUuid(sourceId);
}

/** Regenerated provider / idempotency id: same (secret, source value) → same demo value. */
export function demoProviderId(value, secret = "") {
  if (value === null || value === undefined) return null;
  return `demo${md5(`${secret}:pid:${value}`).slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Faker
// ---------------------------------------------------------------------------

export function makeFaker(seed) {
  let counter = 0;
  const pool = [];
  const next = () => {
    if (!pool.length) {
      const digest = createHash("sha256").update(`${seed}:${counter++}`).digest();
      for (let i = 0; i < 32; i += 4) pool.push(digest.readUInt32BE(i));
    }
    return pool.shift();
  };
  return {
    uint: next,
    int: (n) => next() % n,
    pick: (list) => list[next() % list.length],
    digits: (n) => Array.from({ length: n }, () => next() % 10).join(""),
    hex: (n) => Array.from({ length: n }, () => (next() % 16).toString(16)).join(""),
  };
}

export const FIRST_NAMES = [
  "Ana", "Bruno", "Camila", "Diego", "Eduarda", "Felipe", "Gabriela", "Heitor", "Isabela",
  "Jonas", "Larissa", "Lucas", "Mariana", "Nicolas", "Olivia", "Pedro", "Rafaela", "Samuel",
  "Tatiane", "Vinicius", "Yasmin", "Arthur", "Beatriz", "Caio", "Daniela", "Enzo", "Fernanda",
  "Gustavo", "Helena", "Igor", "Julia", "Leonardo", "Manuela", "Otavio", "Paula", "Renan",
  "Sabrina", "Thiago", "Valentina", "Wesley", "Alice", "Benicio", "Clara", "Davi", "Elisa",
  "Fabio", "Giovana", "Henrique", "Ingrid", "Kaique",
];
export const LAST_NAMES = [
  "Almeida", "Barbosa", "Cardoso", "Dias", "Esteves", "Freitas", "Gomes", "Henriques", "Ibanez",
  "Jardim", "Lacerda", "Moraes", "Nogueira", "Otero", "Pacheco", "Queiroz", "Rezende", "Siqueira",
  "Teixeira", "Uchoa", "Vasconcelos", "Xavier", "Zanetti", "Amaral", "Brandao", "Castilho",
  "Damasceno", "Fontes", "Guimaraes", "Leal", "Macedo", "Novaes", "Pires", "Rangel", "Sales",
  "Tavares", "Valente", "Bittencourt", "Correa", "Duarte",
];

const asciiSlug = (value) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

export function cpfCheckDigits(nineDigits) {
  const digits = nineDigits.split("").map(Number);
  const dv = (list, weightStart) => {
    const sum = list.reduce((acc, d, i) => acc + d * (weightStart - i), 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const d1 = dv(digits, 10);
  const d2 = dv([...digits, d1], 11);
  return `${d1}${d2}`;
}

export function isValidCpf(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  return cpfCheckDigits(digits.slice(0, 9)) === digits.slice(9);
}

const onlyDigits = (value) => String(value ?? "").replace(/\D/g, "");

/** National form (DDD + number) of a Brazilian phone: drops a leading 55 country code. */
export function nationalDigits(value) {
  const d = onlyDigits(value);
  return (d.length === 12 || d.length === 13) && d.startsWith("55") ? d.slice(2) : d;
}

/** Digit forms a phone can appear as in text: full, national, with 55, last 8–11 digits. */
export function phoneForms(value) {
  const d = onlyDigits(value);
  if (d.length < 8) return [];
  const nat = nationalDigits(d);
  const forms = new Set([d, nat, `55${nat}`]);
  for (const n of [8, 9, 10, 11]) if (nat.length >= n) forms.add(nat.slice(-n));
  return [...forms].filter((f) => f.length >= 8 && f.length <= 13);
}

function shiftDate(isoDate, faker) {
  if (!isoDate) return null;
  let offset = faker.int(1461) - 730;
  if (offset === 0) offset = 1;
  const date = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** Fake affiliate code, consistent (within a run) across every player of the same source affiliate. */
export function fakeAffiliate(value, secret = "") {
  if (value === null || value === undefined || value === "") return value ?? null;
  return `AFDEMO${md5(`${secret}:affiliate:${value}`).slice(0, 8).toUpperCase()}`;
}

/** Fake expert name, consistent (within a run) across every player of the same source expert. */
export function fakeExpert(value, secret = "", avoidNames = null) {
  if (value === null || value === undefined || value === "") return value ?? null;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const faker = makeFaker(`${secret}:expert:${value}#${attempt}`);
    const name = `${faker.pick(FIRST_NAMES)} ${faker.pick(LAST_NAMES)}`;
    if (!avoidNames || !exposedNamePairs(name).some((b) => avoidNames.has(b))) return name;
  }
  throw new Error("fakeExpert: no free name");
}

// ---------------------------------------------------------------------------
// Name needles (fix round, item 7): the first two significant words of a
// real multi-word name are a scan needle; text is tokenized the same way in
// SQL (pii-scan.mjs). Words: lower case, split on anything but a-z and the
// Latin-1 accented letters, at least 3 letters, minus NAME_STOPWORDS.
// ---------------------------------------------------------------------------

export const NAME_SPLIT = "[^a-zà-öø-ÿ]+";
export const NAME_STOPWORDS = ["das", "dos", "del", "von", "van"];
/** Placeholder-ish words: a real name containing one is too generic to be a needle. */
const NAME_JUNK = new Set([
  "teste", "test", "cliente", "jogador", "usuario", "usuário", "nome", "sobrenome", "sem", "informado",
  "null", "undefined", "demo", "casa", "sorte", "alta", "lead", "player",
]);

export function nameWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(new RegExp(NAME_SPLIT))
    .filter((w) => w.length >= 3 && !NAME_STOPWORDS.includes(w));
}

/** Consecutive significant-word pairs of a text. */
export function nameBigrams(text) {
  const words = nameWords(text);
  return words.slice(1).map((w, i) => `${words[i]} ${w}`);
}

/**
 * Every name bigram a fake identity can expose anywhere in the demo: all
 * ordered pairs of its name words (a 3-word "First Mid Last" can surface as
 * "first last" through partial rewrites, "last first" too) and the bigrams of
 * its e-mail (first.last123@example.com tokenizes to "first last").
 */
export function exposedNamePairs(...texts) {
  const out = new Set();
  for (const text of texts) {
    if (!text) continue;
    const words = nameWords(text);
    for (let i = 0; i < words.length; i += 1)
      for (let j = 0; j < words.length; j += 1) if (i !== j) out.add(`${words[i]} ${words[j]}`);
  }
  return [...out];
}

/** Needle of a real name: its first two significant words, or null. */
export function nameNeedle(name) {
  const words = nameWords(name);
  if (words.length < 2 || NAME_JUNK.has(words[0]) || NAME_JUNK.has(words[1])) return null;
  return `${words[0]} ${words[1]}`;
}

/** Fake, non-routable phone (+55 11 900xx-xxxx). */
export function fakePhone(seed, attempt = 0) {
  return FAKE_PHONE_PREFIX + makeFaker(`phone:${seed}#${attempt}`).digits(6);
}

function fakeCpf(faker, sourceFormat) {
  let base;
  do base = faker.digits(9);
  while (/^(\d)\1{8}$/.test(base));
  const digits = base + cpfCheckDigits(base);
  return /\D/.test(sourceFormat)
    ? `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
    : digits;
}

/**
 * Fake identity for one source player, deterministic per (player id, attempt).
 * Empty source fields stay empty so coverage rates (with e-mail, with CPF…) are kept.
 */
export function fakePlayer(source, attempt = 0, { secret = "", avoidNames = null } = {}) {
  for (let extra = 0; ; extra += 1) {
    const faker = makeFaker(`player:${source.id}#${attempt}#${extra}`);
    const first = faker.pick(FIRST_NAMES);
    const last = faker.pick(LAST_NAMES);
    const nome = faker.int(3) === 0 ? `${first} ${faker.pick(LAST_NAMES)} ${last}` : `${first} ${last}`;
    const fake = {
      nome,
      telefone: source.telefone ? FAKE_PHONE_PREFIX + faker.digits(6) : (source.telefone ?? null),
      email: source.email
        ? `${asciiSlug(first)}.${asciiSlug(last)}${faker.int(100000)}@example.com`
        : (source.email ?? null),
      cpf: source.cpf ? fakeCpf(faker, source.cpf) : (source.cpf ?? null),
      data_nascimento: shiftDate(source.data_nascimento, faker),
      player_external_id: source.player_external_id
        ? `DEMO${faker.digits(8)}`
        : (source.player_external_id ?? null),
      affiliate_id: fakeAffiliate(source.affiliate_id, secret),
      expert: fakeExpert(source.expert, secret, avoidNames),
    };
    const sameAsSource =
      (fake.telefone && nationalDigits(fake.telefone) === nationalDigits(source.telefone)) ||
      (fake.cpf && onlyDigits(fake.cpf) === onlyDigits(source.cpf)) ||
      (fake.email && fake.email === String(source.email ?? "").toLowerCase()) ||
      (fake.player_external_id && fake.player_external_id === source.player_external_id) ||
      new Set(String(source.nome ?? "").toLowerCase().split(/\s+/)).has(first.toLowerCase());
    if (!sameAsSource) return fake;
  }
}

/**
 * Fake identities for a whole tenant: phones, e-mails, CPFs and external ids are
 * unique, and no digit form of a fake phone/CPF equals a digit form in
 * `avoidForms` (the real phones/CPFs the PII scan looks for), so the scan never
 * flags a fake value. Deterministic for the same input set.
 */
export function fakePlayers(players, { avoidForms = new Set(), avoidNames = null, secret = "" } = {}) {
  const used = new Set();
  const out = new Map();
  const sorted = [...players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const player of sorted) {
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 1000) throw new Error(`fakePlayers: no free identity for ${player.id}`);
      const fake = fakePlayer(player, attempt, { secret, avoidNames });
      // Never a fake name that is also a real name needle (the scan would flag it).
      if (avoidNames && exposedNamePairs(fake.nome, fake.email).some((b) => avoidNames.has(b))) continue;
      const keys = [
        fake.telefone && `t:${nationalDigits(fake.telefone)}`,
        fake.email && `e:${fake.email}`,
        fake.cpf && `c:${onlyDigits(fake.cpf)}`,
        fake.player_external_id && `x:${fake.player_external_id}`,
      ].filter(Boolean);
      const forms = [...phoneForms(fake.telefone), ...(fake.cpf ? [onlyDigits(fake.cpf)] : [])];
      if (keys.some((k) => used.has(k)) || forms.some((f) => avoidForms.has(f))) continue;
      for (const k of keys) used.add(k);
      for (const f of phoneForms(fake.telefone)) used.add(`t:${f}`);
      out.set(player.id, fake);
      break;
    }
  }
  return out;
}

/** Fake phones for phones that belong to no player (staff tests, unresolved recipients…). */
export function fakeLoosePhones(nationals, { avoidForms = new Set(), used = new Set(), secret = "" } = {}) {
  const out = new Map();
  for (const nat of [...new Set(nationals)].sort()) {
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 1000) throw new Error(`fakeLoosePhones: no free phone for ${nat}`);
      const phone = fakePhone(`${secret}:${nat}`, attempt);
      const forms = phoneForms(phone);
      if (used.has(`t:${nationalDigits(phone)}`) || forms.some((f) => avoidForms.has(f))) continue;
      for (const f of forms) used.add(`t:${f}`);
      out.set(nat, phone);
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text rewriting
// ---------------------------------------------------------------------------

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Hosts that must never become needles (our replacements and infra). */
const SAFE_HOSTS = ["example.com", DEMO_DOMAIN, "betleads.invalid"];

export function normalizeHosts(hosts, exclude = []) {
  const skip = new Set([...SAFE_HOSTS, ...exclude].map((h) => h.toLowerCase()));
  const out = new Set();
  for (const raw of hosts ?? []) {
    const host = String(raw ?? "").trim().toLowerCase().replace(/^www\./, "");
    if (!host.includes(".") || /^[0-9.]+$/.test(host) || !/^[a-z0-9.-]+$/.test(host)) continue;
    if ([...skip].some((s) => host === s || host.endsWith(`.${s}`) || s.endsWith(`.${host}`)))
      continue;
    out.add(host);
  }
  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/**
 * Ordered generic rules shared with SQL. `pattern` uses the regex subset that
 * JavaScript and PostgreSQL AREs read the same way; `js`/`sql` are the
 * replacement strings in each dialect.
 */
export function genericRules({ hosts = [], brandNames = [] } = {}) {
  const rules = [
    {
      name: "email",
      pattern: "[A-Za-z0-9._%+-]+@(?!example\\.com)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
      flags: "gi",
      js: "oculto@example.com",
      sql: "oculto@example.com",
    },
    {
      name: "query-value",
      pattern: "((?:[?&]|&amp;)(?!utm_)[A-Za-z0-9_.-]+=)(?![{%])[^&#\\s\"'<>]+",
      flags: "gi",
      js: "$1demo",
      sql: "\\1demo",
    },
  ];
  for (const host of hosts) {
    rules.push({
      name: `host:${host}`,
      pattern: `(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*${escapeRegex(host)}(?![A-Za-z0-9-])`,
      flags: "gi",
      js: DEMO_DOMAIN,
      sql: DEMO_DOMAIN,
    });
  }
  rules.push({ name: "brand-upper", pattern: "SORTE\\s+ALTA", flags: "g", js: "CASA DEMO", sql: "CASA DEMO" });
  for (const name of brandNames) {
    const trimmed = String(name ?? "").trim();
    if (trimmed.length < 4) continue;
    rules.push({
      name: `brand-name:${trimmed}`,
      pattern: escapeRegex(trimmed).replace(/\s+/g, "\\s+"),
      flags: "gi",
      js: DEMO_BRAND,
      sql: DEMO_BRAND,
    });
  }
  rules.push(
    { name: "brand", pattern: "sorte\\s+alta", flags: "gi", js: DEMO_BRAND, sql: DEMO_BRAND },
    { name: "brand-sep", pattern: "sorte[._-]alta", flags: "gi", js: "casa-demo", sql: "casa-demo" },
    { name: "brand-joined", pattern: "sortealta", flags: "gi", js: "casademo", sql: "casademo" },
    { name: "slug", pattern: "pixpgf", flags: "gi", js: DEMO_SLUG, sql: DEMO_SLUG },
  );
  return rules;
}

const STOPWORDS = new Set(["da", "de", "do", "das", "dos", "e", "di", "du"]);
const LETTER = "\\p{L}\\p{N}";

function caseLike(sample, replacement) {
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return replacement.toUpperCase();
  if (sample === sample.toLowerCase()) return replacement.toLowerCase();
  return replacement;
}

function wordRegex(word) {
  return new RegExp(`(?<![${LETTER}])${escapeRegex(word)}(?![${LETTER}])`, "giu");
}

function phoneRegex(value) {
  const nat = nationalDigits(value);
  if (nat.length < 8) return null;
  const body = nat.split("").map(escapeRegex).join("[\\s().-]*");
  return new RegExp(`(?<![0-9])(?:\\+?55[\\s().-]*)?\\(?${body}(?![0-9])`, "g");
}

function cpfRegex(value) {
  const d = onlyDigits(value);
  if (d.length !== 11) return null;
  return new RegExp(`(?<![0-9])${d.split("").join("[\\s.-]*")}(?![0-9])`, "g");
}

function playerReplacers({ source, fake }) {
  // Identifiers first (an e-mail like maria.souza@… must not be touched by the
  // name rules), names last.
  const out = [];
  if (source.email && fake.email)
    out.push([new RegExp(escapeRegex(String(source.email)), "gi"), () => fake.email]);
  const phone = source.telefone && fake.telefone && phoneRegex(source.telefone);
  if (phone) out.push([phone, () => fake.telefone]);
  const cpf = source.cpf && fake.cpf && cpfRegex(source.cpf);
  if (cpf) out.push([cpf, () => fake.cpf]);
  if (source.player_external_id && fake.player_external_id && String(source.player_external_id).length >= 4)
    out.push([
      new RegExp(`(?<![A-Za-z0-9])${escapeRegex(String(source.player_external_id))}(?![A-Za-z0-9])`, "g"),
      () => fake.player_external_id,
    ]);
  const sourceParts = String(source.nome ?? "").trim().split(/\s+/).filter(Boolean);
  const fakeParts = String(fake.nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (sourceParts.length > 1) out.push([wordRegex(sourceParts.join(" ")), () => fake.nome]);
  sourceParts.forEach((part, index) => {
    if (part.length < 3 || STOPWORDS.has(part.toLowerCase())) return;
    const replacement = index === 0 ? fakeParts[0] : fakeParts[fakeParts.length - 1];
    out.push([wordRegex(part), (match) => caseLike(match, replacement)]);
  });
  return out;
}

/**
 * Rewrite context. `players` = [{ source, fake }] whose identity may appear in
 * the text; `exact` = [[from, to]] literal replacements applied first (storage
 * paths…); `imageUrl` = placeholder every image reference points to.
 */
export function makeRewriteContext({
  sourceTenantId,
  demoTenantId,
  hosts = [],
  brandNames = [],
  exact = [],
  players = [],
  imageUrl = null,
  phoneMap = null,
  emailMap = null,
  shortHosts = [],
  shortMap = null,
  secret = "",
} = {}) {
  const normalizedHosts = normalizeHosts(hosts);
  const normalizedShortHosts = normalizeHosts(shortHosts);
  const shortPattern = shortLinkPattern(normalizedShortHosts);
  return {
    secret,
    shortHosts: normalizedShortHosts,
    shortMap,
    shortRegex: shortPattern ? new RegExp(shortPattern, "gi") : null,
    sourceTenantId: sourceTenantId?.toLowerCase() ?? null,
    demoTenantId: demoTenantId?.toLowerCase() ?? null,
    hosts: normalizedHosts,
    brandNames,
    exact: [...exact].sort((a, b) => b[0].length - a[0].length),
    players,
    imageUrl,
    phoneMap,
    emailMap,
    rules: genericRules({ hosts: normalizedHosts, brandNames }).map((rule) => ({
      ...rule,
      regex: new RegExp(rule.pattern, rule.flags),
    })),
    playerReplacers: players.flatMap(playerReplacers),
  };
}

/** Same context with a different set of players (per-row rewriting). */
export function withPlayers(ctx, players) {
  return { ...ctx, players, playerReplacers: players.flatMap(playerReplacers) };
}

export function remapUuidIn(ctx, uuid) {
  const lower = uuid.toLowerCase();
  if (ctx.sourceTenantId && lower === ctx.sourceTenantId && ctx.demoTenantId) return ctx.demoTenantId;
  return demoUuid(lower);
}

const PHONE_CANDIDATE = /(?<![0-9])\+?[0-9][0-9 ().-]{6,18}[0-9](?![0-9])/g;
const EMAIL_CANDIDATE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IMAGE_URL = /https?:\/\/[^\s"'<>()]+?\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?[^\s"'<>()]*)?(?=$|[\s"'<>()])/gi;
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi;
const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;

// ---------------------------------------------------------------------------
// Short links (fix round, item 1): every short link of a short-link host is
// replaced by https://demo.betleads.invalid/<code>. Known links (the source's
// tracked_links) get the code derived from their remapped link id; unknown
// ones a code keyed with the run secret. Never the real path.
// ---------------------------------------------------------------------------

/** Code of a tracked link in the demo: from its remapped (demo) id, not the real path. */
export function demoShortPath(sourceLinkId) {
  return `dm${md5(`short:${demoUuid(sourceLinkId)}`).slice(0, 12)}`;
}

export const shortKey = (host, path) => `${String(host).toLowerCase().replace(/^www\./, "")}/${path}`;

/** Regex source (JS and PostgreSQL ARE) matching a short link of `hosts`; groups: host, path. */
export function shortLinkPattern(hosts) {
  if (!hosts?.length) return null;
  return `(?<![A-Za-z0-9.-])(?:https?://)?(?:www\\.)?(${hosts.map(escapeRegex).join("|")})/([A-Za-z0-9_-]+)`;
}

/** Source short links → { key: `${host}/${path}`, dst } for the demo. */
export function shortLinkMap(links) {
  const out = new Map();
  for (const { id, short_url: shortUrl } of links) {
    let url;
    try {
      url = new URL(String(shortUrl));
    } catch {
      continue;
    }
    const path = url.pathname.replace(/^\/+/, "").split("/")[0];
    if (!path) continue;
    out.set(shortKey(url.hostname, path), `https://${DEMO_DOMAIN}/${demoShortPath(id)}`);
  }
  return out;
}

function shortTarget(ctx, host, path) {
  const key = shortKey(host, path);
  return ctx.shortMap?.get(key) ?? `https://${DEMO_DOMAIN}/dx${md5(`${ctx.secret}:short:${key}`).slice(0, 12)}`;
}

/** Generic rules only (the part shared with SQL `pg_temp.demo_rw`). */
export function rewriteGeneric(text, ctx) {
  if (text === null || text === undefined) return text ?? null;
  let out = String(text);
  if (ctx.shortRegex) out = out.replace(ctx.shortRegex, (_m, host, path) => shortTarget(ctx, host, path));
  out = out.replace(new RegExp(UUID_PATTERN, "gi"), (m) => remapUuidIn(ctx, m));
  for (const rule of ctx.rules) out = out.replace(rule.regex, rule.js);
  return out;
}

export function rewriteText(text, ctx) {
  if (text === null || text === undefined) return text ?? null;
  let out = String(text);
  const protectedValues = [];
  const protect = (value) => {
    protectedValues.push(value);
    return `\u0000${protectedValues.length - 1}\u0000`;
  };
  if (ctx.imageUrl) {
    out = out
      .replace(IMG_SRC, (_m, head, quote) => `${head}${quote}${protect(ctx.imageUrl)}${quote}`)
      .replace(DATA_IMAGE, () => protect(ctx.imageUrl))
      .replace(IMAGE_URL, () => protect(ctx.imageUrl));
  }
  for (const [from, to] of ctx.exact) if (from) out = out.split(from).join(protect(to));
  for (const [regex, replace] of ctx.playerReplacers) out = out.replace(regex, (m) => protect(replace(m)));
  if (ctx.phoneMap?.size)
    out = out.replace(PHONE_CANDIDATE, (m) => {
      const fake = ctx.phoneMap.get(nationalDigits(m));
      return fake ? protect(fake) : m;
    });
  if (ctx.emailMap?.size)
    out = out.replace(EMAIL_CANDIDATE, (m) => {
      const fake = ctx.emailMap.get(m.toLowerCase());
      return fake ? protect(fake) : m;
    });
  out = rewriteGeneric(out, ctx);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => protectedValues[Number(i)]);
}

/** rewriteText over every string (and key) of a JSON value. */
export function rewriteJson(value, ctx) {
  if (typeof value === "string") return rewriteText(value, ctx);
  if (Array.isArray(value)) return value.map((item) => rewriteJson(item, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[rewriteText(key, ctx)] = rewriteJson(item, ctx);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// JSON scrubbing
// ---------------------------------------------------------------------------

/** Turns ["a", "b.c"] into { a: true, b: { c: true } }. */
export function keepTree(keepKeys) {
  const tree = {};
  for (const path of keepKeys ?? []) {
    const parts = String(path).split(".");
    let node = tree;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) node[part] = node[part] && node[part] !== true ? node[part] : true;
      else {
        if (node[part] === true || !node[part]) node[part] = {};
        node = node[part];
      }
    });
  }
  return tree;
}

function scrubWithTree(value, tree) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, rule] of Object.entries(tree)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    out[key] = rule === true ? value[key] : scrubWithTree(value[key], rule);
  }
  return out;
}

/** Keeps only `keepKeys` (dotted paths allowed) of a JSON object; anything else → {}. */
export function scrubJson(value, keepKeys) {
  return scrubWithTree(value, keepTree(keepKeys));
}
