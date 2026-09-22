import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_CSV_PATH = "C:/Users/ander/Downloads/sortealta_usuarios_2026-09-18.csv";
const DEFAULT_TENANT_ID = "03b73a96-aef7-414d-94fc-93a996f8256b";
const IMPORT_NAME = "sortealta_usuarios_2026-09-18";
const BATCH_SIZE = 400;

loadDotEnv(path.resolve(process.cwd(), ".env"));
loadDotEnv(path.resolve(process.cwd(), ".env.local"));

const args = parseArgs(process.argv.slice(2));
const apply = Boolean(args.apply);
const csvPath = path.resolve(String(args.file ?? DEFAULT_CSV_PATH));
const tenantId = String(args.tenant ?? process.env.IMPORT_TENANT_ID ?? DEFAULT_TENANT_ID);

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Configure SUPABASE_URL e SUPABASE_SECRET_KEY ou SUPABASE_SERVICE_ROLE_KEY.");
}

if (!fs.existsSync(csvPath)) {
  throw new Error(`CSV nao encontrado: ${csvPath}`);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const rawRows = parseCsv(fs.readFileSync(csvPath, "utf8"));
const rows = normalizeRows(rawRows);
const existingPlayers = await fetchAllPlayers(tenantId);
const existingAttributions = await fetchAttributionKeys(tenantId);
const plan = buildImportPlan(rows, existingPlayers, existingAttributions);

printSummary(plan, { apply, csvPath, tenantId });

if (!apply) {
  console.log("\nDry-run concluido. Rode novamente com --apply para gravar no Supabase.");
  process.exit(0);
}

const result = await applyPlan(plan, tenantId);
const validation = await validateImport(rows, tenantId);

console.log("\nImportacao concluida:");
console.log(
  JSON.stringify(
    {
      insertedPlayers: result.insertedPlayers,
      updatedPlayers: result.updatedPlayers,
      upsertedAttributions: result.upsertedAttributions,
      validation,
    },
    null,
    2,
  ),
);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function normalizeRows(csvRows) {
  const [rawHeader, ...dataRows] = csvRows;
  const header = rawHeader.map((column) => column.replace(/^\uFEFF/, "").trim());

  return dataRows
    .filter((row) => row.some((value) => String(value ?? "").trim() !== ""))
    .map((row, index) => {
      const raw = Object.fromEntries(header.map((key, i) => [key, String(row[i] ?? "").trim()]));
      const externalId = raw.id;
      const email = normalizeEmail(raw.email);
      const telefone = normalizePhone(raw.telefone);
      const cadastro = parseDate(raw.cadastro);
      const primeiroDeposito = parseDate(raw.primeiro_deposito);
      const ultimoDeposito = parseDate(raw.ultimo_deposito);
      const totalDepositado = parseMoney(raw.total_depositado);
      const depositos = Number.parseInt(raw.depositos || "0", 10) || 0;
      const utmSource = raw.origem || null;
      const utmCampaign = raw.campanha || null;
      const utmContent = raw.criativo || null;

      return {
        rowNumber: index + 2,
        raw,
        externalId,
        nome: raw.nome || null,
        telefone,
        email,
        totalDepositado,
        depositos,
        cadastro,
        primeiroDeposito,
        ultimoDeposito,
        origem: raw.origem || null,
        utmSource,
        utmMedium: utmSource ? "paid" : null,
        utmCampaign,
        utmContent,
        utmId: isLikelyNumericId(utmContent) ? utmContent : null,
      };
    });
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  return email || null;
}

function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("55")) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function phoneKeys(value) {
  const phone = normalizePhone(value);
  if (!phone) return [];
  const keys = new Set([phone]);
  if (phone.startsWith("55")) keys.add(phone.slice(2));
  return [...keys];
}

function parseMoney(value) {
  const normalized = String(value ?? "")
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function parseDate(value) {
  const date = String(value ?? "").trim();
  if (!date) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Date(`${date}T00:00:00-03:00`).toISOString();
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isLikelyNumericId(value) {
  return /^\d{10,}$/.test(String(value ?? "").trim());
}

async function fetchAllPlayers(tenantId) {
  const players = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("players")
      .select(
        "id, tenant_id, player_external_id, nome, email, telefone, total_depositado, ftd_em, ultimo_deposito, created_at",
      )
      .eq("tenant_id", tenantId)
      .range(from, from + 999);

    if (error) throw error;
    players.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return players;
}

async function fetchAttributionKeys(tenantId) {
  const keys = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("player_attributions")
      .select("tenant_id, player_id, event_type")
      .eq("tenant_id", tenantId)
      .range(from, from + 999);

    if (error) throw error;
    for (const row of data ?? []) keys.add(`${row.tenant_id}:${row.player_id}:${row.event_type}`);
    if (!data || data.length < 1000) break;
  }
  return keys;
}

function buildImportPlan(rows, players, existingAttributions) {
  const byExternalId = new Map();
  const byEmail = new Map();
  const phoneMap = new Map();
  const csvExternalIds = new Map();
  const csvEmails = new Map();
  const csvPhones = new Map();

  for (const player of players) {
    if (player.player_external_id) byExternalId.set(player.player_external_id, player);
    const email = normalizeEmail(player.email);
    if (email) byEmail.set(email, player);
    for (const phoneKey of phoneKeys(player.telefone)) {
      if (!phoneMap.has(phoneKey)) phoneMap.set(phoneKey, []);
      phoneMap.get(phoneKey).push(player);
    }
  }

  for (const row of rows) {
    increment(csvExternalIds, row.externalId);
    increment(csvEmails, row.email);
    for (const phoneKey of phoneKeys(row.telefone)) increment(csvPhones, phoneKey);
  }

  const inserts = [];
  const updates = [];
  const skipped = [];
  const duplicateExternalIds = [...csvExternalIds].filter(([, count]) => count > 1);
  const duplicateEmails = [...csvEmails].filter(([key, count]) => key && count > 1);
  const duplicatePhones = [...csvPhones].filter(([key, count]) => key && !key.startsWith("55") && count > 1);

  for (const row of rows) {
    if (!row.externalId) {
      skipped.push({ row, reason: "missing_external_id" });
      continue;
    }

    const match = findExistingPlayer(row, byExternalId, byEmail, phoneMap);
    if (match) {
      updates.push({
        row,
        player: match.player,
        matchBy: match.matchBy,
        patch: buildPlayerPatch(row, match.player),
      });
      continue;
    }

    inserts.push({
      row,
      values: buildPlayerInsert(row),
    });
  }

  return {
    rows,
    existingPlayers: players.length,
    existingAttributions,
    inserts,
    updates,
    skipped,
    duplicateExternalIds,
    duplicateEmails,
    duplicatePhones,
  };
}

function increment(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function findExistingPlayer(row, byExternalId, byEmail, phoneMap) {
  if (row.externalId && byExternalId.has(row.externalId)) {
    return { player: byExternalId.get(row.externalId), matchBy: "external_id" };
  }

  if (row.email && byEmail.has(row.email)) {
    return { player: byEmail.get(row.email), matchBy: "email" };
  }

  for (const phoneKey of phoneKeys(row.telefone)) {
    const matches = phoneMap.get(phoneKey) ?? [];
    if (matches.length === 1) return { player: matches[0], matchBy: "phone" };
  }

  return null;
}

function buildPlayerInsert(row) {
  return {
    tenant_id: tenantId,
    player_external_id: row.externalId,
    nome: row.nome,
    email: row.email,
    telefone: row.telefone,
    origem: row.origem,
    status: "ativo",
    risco: "baixo",
    tags: [],
    total_depositado: row.totalDepositado,
    ftd_em: row.primeiroDeposito,
    ultimo_deposito: row.ultimoDeposito,
    created_at: row.cadastro ?? undefined,
    utm_source: row.utmSource,
    utm_medium: row.utmMedium,
    utm_campaign: row.utmCampaign,
    utm_content: row.utmContent,
    utm_id: row.utmId,
    updated_at: new Date().toISOString(),
  };
}

function buildPlayerPatch(row, player) {
  const patch = {
    updated_at: new Date().toISOString(),
    player_external_id: player.player_external_id ?? row.externalId,
    nome: chooseText(player.nome, row.nome, { replaceNovoPlayer: true }),
    email: chooseText(player.email, row.email),
    telefone: chooseText(player.telefone, row.telefone),
    origem: row.origem ?? undefined,
    total_depositado: Math.max(Number(player.total_depositado ?? 0), row.totalDepositado),
    ftd_em: earliestDate(player.ftd_em, row.primeiroDeposito),
    ultimo_deposito: latestDate(player.ultimo_deposito, row.ultimoDeposito),
    utm_source: row.utmSource ?? undefined,
    utm_medium: row.utmMedium ?? undefined,
    utm_campaign: row.utmCampaign ?? undefined,
    utm_content: row.utmContent ?? undefined,
    utm_id: row.utmId ?? undefined,
  };

  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function chooseText(current, incoming, options = {}) {
  if (!incoming) return undefined;
  if (!current) return incoming;
  if (options.replaceNovoPlayer && String(current).trim().toLowerCase() === "novo player") return incoming;
  return undefined;
}

function earliestDate(current, incoming) {
  if (!incoming) return undefined;
  if (!current) return incoming;
  return new Date(incoming).getTime() < new Date(current).getTime() ? incoming : current;
}

function latestDate(current, incoming) {
  if (!incoming) return undefined;
  if (!current) return incoming;
  return new Date(incoming).getTime() > new Date(current).getTime() ? incoming : current;
}

function buildAttribution(row, playerId) {
  return {
    tenant_id: tenantId,
    player_id: playerId,
    event_id: row.externalId,
    event_type: "signup",
    provider: row.origem ?? "csv",
    utm_source: row.utmSource,
    utm_medium: row.utmMedium,
    utm_campaign: row.utmCampaign,
    utm_content: row.utmContent,
    utm_id: row.utmId,
    raw_payload: {
      import_name: IMPORT_NAME,
      source_file: path.basename(csvPath),
      row_number: row.rowNumber,
      raw: row.raw,
      normalized: {
        telefone: row.telefone,
        email: row.email,
        total_depositado: row.totalDepositado,
        depositos: row.depositos,
      },
    },
    match_status: row.utmCampaign || row.utmContent || row.utmId ? "orphan_campaign" : "missing_utm",
    match_confidence: 0,
    captured_at: row.cadastro ?? new Date().toISOString(),
  };
}

async function applyPlan(plan, tenantId) {
  const playerIdsByExternalId = new Map();
  let insertedPlayers = 0;
  let updatedPlayers = 0;
  let upsertedAttributions = 0;

  for (const batch of chunks(plan.inserts, BATCH_SIZE)) {
    const { data, error } = await supabase
      .from("players")
      .insert(batch.map((item) => item.values))
      .select("id, player_external_id");

    if (error) throw error;
    insertedPlayers += data?.length ?? 0;
    for (const player of data ?? []) playerIdsByExternalId.set(player.player_external_id, player.id);
  }

  for (const item of plan.updates) {
    const { data, error } = await supabase
      .from("players")
      .update(item.patch)
      .eq("tenant_id", tenantId)
      .eq("id", item.player.id)
      .select("id, player_external_id")
      .single();

    if (error) throw error;
    updatedPlayers += 1;
    playerIdsByExternalId.set(item.row.externalId, data.id);
  }

  const attributionRows = [];
  for (const item of plan.inserts) {
    const playerId = playerIdsByExternalId.get(item.row.externalId);
    if (playerId) attributionRows.push(buildAttribution(item.row, playerId));
  }
  for (const item of plan.updates) {
    attributionRows.push(buildAttribution(item.row, item.player.id));
  }

  for (const batch of chunks(attributionRows, BATCH_SIZE)) {
    const { data, error } = await supabase
      .from("player_attributions")
      .upsert(batch, { onConflict: "tenant_id,player_id,event_type" })
      .select("id");

    if (error) throw error;
    upsertedAttributions += data?.length ?? batch.length;
  }

  return { insertedPlayers, updatedPlayers, upsertedAttributions };
}

async function validateImport(rows, tenantId) {
  const expectedExternalIds = rows.map((row) => row.externalId).filter(Boolean);
  let matchedPlayers = 0;
  let matchedAttributions = 0;

  for (const batch of chunks(expectedExternalIds, 200)) {
    const { data: players, error: playersError } = await supabase
      .from("players")
      .select("id, player_external_id")
      .eq("tenant_id", tenantId)
      .in("player_external_id", batch);

    if (playersError) throw playersError;
    matchedPlayers += players?.length ?? 0;

    const playerIds = (players ?? []).map((player) => player.id);
    if (playerIds.length === 0) continue;

    const { data: attributions, error: attributionsError } = await supabase
      .from("player_attributions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("event_type", "signup")
      .in("player_id", playerIds);

    if (attributionsError) throw attributionsError;
    matchedAttributions += attributions?.length ?? 0;
  }

  const { count: totalPlayers, error: countError } = await supabase
    .from("players")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);

  if (countError) throw countError;

  return {
    expectedRows: expectedExternalIds.length,
    matchedPlayers,
    matchedAttributions,
    tenantPlayersTotal: totalPlayers,
  };
}

function chunks(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

function printSummary(plan, context) {
  const updateMatches = countBy(plan.updates.map((item) => item.matchBy));
  console.log(
    JSON.stringify(
      {
        mode: context.apply ? "apply" : "dry-run",
        csvPath: context.csvPath,
        tenantId: context.tenantId,
        csvRows: plan.rows.length,
        existingPlayers: plan.existingPlayers,
        inserts: plan.inserts.length,
        updates: plan.updates.length,
        skipped: plan.skipped.length,
        updateMatches,
        duplicateExternalIds: plan.duplicateExternalIds.length,
        duplicateEmails: plan.duplicateEmails.length,
        duplicatePhones: plan.duplicatePhones.map(([phone, count]) => ({ phone, count })),
      },
      null,
      2,
    ),
  );

  if (plan.skipped.length > 0) {
    console.log("\nLinhas ignoradas:");
    console.table(plan.skipped.map((item) => ({ rowNumber: item.row.rowNumber, reason: item.reason })));
  }
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
