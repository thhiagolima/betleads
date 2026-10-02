import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const ROOT = process.cwd();
const BASE = path.join(ROOT, "base");
const TENANT_SLUG = "pixpgf";
const PAGE_SIZE = 1000;
const WRITE_BATCH = 300;

function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(value);
      value = "";
    } else value += char;
  }
  cells.push(value.replace(/\r$/, ""));
  return cells;
}

function readCsv(filename) {
  const lines = fs.readFileSync(path.join(BASE, filename), "utf8").trim().split(/\n/);
  const headers = parseCsvLine(lines[0].replace(/^\uFEFF/, ""));
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function number(value) {
  const parsed = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function isNewerOrEqual(source, current) {
  if (!current) return true;
  const sourceTime = Date.parse(source ?? "");
  const currentTime = Date.parse(current ?? "");
  return Number.isFinite(sourceTime) && (!Number.isFinite(currentTime) || sourceTime >= currentTime);
}

function assertUniqueAndPresent(rows, key, label) {
  const seen = new Set();
  for (const row of rows) {
    const value = String(row[key] ?? "").trim();
    if (!value) throw new Error(`${label}: encontrado registro sem ${key}.`);
    if (seen.has(value)) throw new Error(`${label}: ${key} duplicado (${value}).`);
    seen.add(value);
  }
  return seen;
}

function mapDepositStatus(status) {
  if (status === "completed") return "aprovado";
  if (status === "failed") return "falhou";
  return "pendente";
}

function mapWithdrawalStatus(status) {
  if (status === "completed") return "aprovado";
  if (status === "cancelled") return "falhou";
  return "pendente";
}

function shouldApplyTransaction(sourceStatus, sourceUpdatedAt, current) {
  if (!current) return true;
  const currentStatus = String(current.status ?? "");
  if (currentStatus === "aprovado" && sourceStatus !== "aprovado") return false;
  if (currentStatus === "falhou" && sourceStatus === "pendente") return false;
  return isNewerOrEqual(sourceUpdatedAt, current.updated_at);
}

async function fetchAll(supabase, table, columns, tenantId) {
  const output = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq("tenant_id", tenantId)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    output.push(...(data ?? []));
    if ((data ?? []).length < PAGE_SIZE) return output;
  }
}

async function writeInBatches(supabase, table, rows, onConflict = null, ignoreDuplicates = false) {
  if (!rows.length) return;
  for (let offset = 0; offset < rows.length; offset += WRITE_BATCH) {
    const batch = rows.slice(offset, offset + WRITE_BATCH);
    const query = onConflict
      ? supabase.from(table).upsert(batch, { onConflict, ignoreDuplicates })
      : supabase.from(table).insert(batch);
    const { error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL e SUPABASE_SECRET_KEY são obrigatórias");
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const [{ data: tenant, error: tenantError }, users, deposits, withdrawals] = await Promise.all([
    supabase.from("tenants").select("id,nome,slug").eq("slug", TENANT_SLUG).single(),
    Promise.resolve(readCsv("sortealta_usuarios_2026-10-01.csv")),
    Promise.resolve(readCsv("sortealta_depositos_2026-10-01.csv")),
    Promise.resolve(readCsv("sortealta_saques_2026-10-01.csv")),
  ]);
  if (tenantError) throw new Error(`Tenant ${TENANT_SLUG}: ${tenantError.message}`);

  const sourcePlayerIds = assertUniqueAndPresent(users, "user_id", "Usuários");
  const sourceDepositIds = assertUniqueAndPresent(deposits, "deposit_id", "Depósitos");
  const sourceWithdrawalIds = assertUniqueAndPresent(withdrawals, "withdrawal_id", "Saques");
  const orphanDeposit = deposits.find((row) => !sourcePlayerIds.has(String(row.user_id ?? "").trim()));
  const orphanWithdrawal = withdrawals.find(
    (row) => !sourcePlayerIds.has(String(row.user_id ?? "").trim()),
  );
  if (orphanDeposit) throw new Error(`Depósitos: usuário ausente na exportação (${orphanDeposit.user_id}).`);
  if (orphanWithdrawal) throw new Error(`Saques: usuário ausente na exportação (${orphanWithdrawal.user_id}).`);

  const [currentPlayers, currentDeposits, currentWithdrawals] = await Promise.all([
    fetchAll(supabase, "players", "id,player_external_id,updated_at", tenant.id),
    fetchAll(supabase, "deposits", "id,external_id,status,updated_at", tenant.id),
    fetchAll(supabase, "withdrawals", "id,external_id,status,updated_at", tenant.id),
  ]);
  const playersByExternalId = new Map(currentPlayers.filter((row) => row.player_external_id).map((row) => [row.player_external_id, row]));
  const depositsByExternalId = new Map(currentDeposits.filter((row) => row.external_id).map((row) => [row.external_id, row]));
  const withdrawalsByExternalId = new Map(currentWithdrawals.filter((row) => row.external_id).map((row) => [row.external_id, row]));

  // A exportação traz o snapshot consolidado da casa e é a fonte de verdade
  // para os players que ela contém. Jogadores ausentes no CSV permanecem
  // intocados, mas os presentes precisam receber os totais absolutos do arquivo
  // para não perpetuar valores parciais calculados por webhooks anteriores.
  const sourcePlayerRows = users.filter((source) =>
    isNewerOrEqual(iso(source.data_atualizacao), playersByExternalId.get(source.user_id)),
  );
  const playerRows = sourcePlayerRows.map((source) => ({
      tenant_id: tenant.id,
      player_external_id: source.user_id,
      nome: source.nome.trim() || "Novo player",
      telefone: source.telefone.trim() || null,
      email: source.email.trim() || null,
      cpf: source.cpf.trim() || null,
      data_nascimento: source.data_nascimento.trim() || null,
      pais: source.pais.trim() || null,
      status: source.status.trim() || "ativo",
      created_at: iso(source.data_cadastro),
      updated_at: iso(source.data_atualizacao),
      ultimo_login: iso(source.ultimo_login),
      ultimo_jogo: iso(source.ultimo_jogo),
      ftd_em: iso(source.primeiro_deposito_em),
      ultimo_deposito: iso(source.ultimo_deposito_em),
      ultimo_saque: iso(source.ultimo_saque_em),
      saldo_carteira: number(source.saldo_real),
      saldo_bonus: number(source.saldo_bonus),
      saldo_bloqueado: number(source.saldo_bloqueado),
      total_depositado: number(source.total_depositado),
      total_sacado: number(source.total_sacado),
      total_apostado: number(source.total_apostado),
      total_cashback_paid: number(source.total_cashback),
      affiliate_id: source.afiliado_id.trim() || null,
      origem: source.origem.trim() || null,
      utm_source: source.utm_source.trim() || null,
      utm_medium: source.utm_medium.trim() || null,
      utm_campaign: source.utm_campaign.trim() || null,
      utm_content: source.utm_content.trim() || null,
      utm_term: source.utm_term.trim() || null,
      utm_id: source.utm_id.trim() || null,
    }));

  const sourceDepositRows = deposits.filter((source) => shouldApplyTransaction(mapDepositStatus(source.status), iso(source.data_atualizacao), depositsByExternalId.get(source.deposit_id)));
  const sourceWithdrawalRows = withdrawals.filter((source) => shouldApplyTransaction(mapWithdrawalStatus(source.status), iso(source.data_atualizacao), withdrawalsByExternalId.get(source.withdrawal_id)));
  const planned = {
    tenant: tenant.nome,
    mode: APPLY ? "apply" : "dry-run",
    players: {
      source: users.length,
      existing_in_database: currentPlayers.length,
      insert: users.filter((row) => !playersByExternalId.has(row.user_id)).length,
      update_from_snapshot: playerRows.filter((row) => playersByExternalId.has(row.player_external_id)).length,
      unchanged_or_older: users.length - playerRows.length,
    },
    deposits: {
      source: deposits.length,
      existing_in_database: currentDeposits.length,
      insert: [...sourceDepositIds].filter((id) => !depositsByExternalId.has(id)).length,
      update: sourceDepositRows.filter((row) => depositsByExternalId.has(row.deposit_id)).length,
      unchanged_or_older: deposits.length - sourceDepositRows.length,
    },
    withdrawals: {
      source: withdrawals.length,
      existing_in_database: currentWithdrawals.length,
      insert: [...sourceWithdrawalIds].filter((id) => !withdrawalsByExternalId.has(id)).length,
      update: sourceWithdrawalRows.filter((row) => withdrawalsByExternalId.has(row.withdrawal_id)).length,
      unchanged_or_older: withdrawals.length - sourceWithdrawalRows.length,
    },
  };
  console.log(JSON.stringify(planned, null, 2));
  if (VERIFY) {
    const missingPlayers = users.filter((row) => !playersByExternalId.has(row.user_id)).length;
    const missingDeposits = deposits.filter((row) => !depositsByExternalId.has(row.deposit_id)).length;
    const missingWithdrawals = withdrawals.filter(
      (row) => !withdrawalsByExternalId.has(row.withdrawal_id),
    ).length;
    const depositStatusMismatch = sourceDepositRows.filter(
      (row) => depositsByExternalId.get(row.deposit_id)?.status !== mapDepositStatus(row.status),
    ).length;
    const withdrawalStatusMismatch = sourceWithdrawalRows.filter(
      (row) => withdrawalsByExternalId.get(row.withdrawal_id)?.status !== mapWithdrawalStatus(row.status),
    ).length;
    console.log(
      JSON.stringify(
        {
          verification: {
            source_ids_missing: {
              players: missingPlayers,
              deposits: missingDeposits,
              withdrawals: missingWithdrawals,
            },
            current_snapshot_status_mismatch: {
              deposits: depositStatusMismatch,
              withdrawals: withdrawalStatusMismatch,
            },
          },
        },
        null,
        2,
      ),
    );
    if (!APPLY) return;
  }
  if (!APPLY) return;

  const existingPlayerRows = playerRows
    .filter((row) => playersByExternalId.has(row.player_external_id))
    .map((row) => ({ ...row, id: playersByExternalId.get(row.player_external_id).id }));
  const newPlayerRows = playerRows.filter((row) => !playersByExternalId.has(row.player_external_id));
  // A casa continua recebendo webhooks enquanto o snapshot é importado.
  // Se um jogador chegar neste intervalo, preservamos a versão recém-chegada.
  await writeInBatches(supabase, "players", newPlayerRows, "tenant_id,player_external_id", true);
  await writeInBatches(supabase, "players", existingPlayerRows, "id");
  const refreshedPlayers = await fetchAll(supabase, "players", "id,player_external_id", tenant.id);
  const playerIds = new Map(refreshedPlayers.filter((row) => row.player_external_id).map((row) => [row.player_external_id, row.id]));
  const depositRows = sourceDepositRows.map((source) => ({
    tenant_id: tenant.id,
    player_id: playerIds.get(source.user_id),
    external_id: source.deposit_id,
    valor: number(source.valor),
    metodo: source.metodo.trim() || null,
    status: mapDepositStatus(source.status),
    provider_status: source.status,
    created_at: iso(source.data_criacao),
    updated_at: iso(source.data_atualizacao),
    completed_at: iso(source.data_aprovacao),
  })).filter((row) => row.player_id);
  const withdrawalRows = sourceWithdrawalRows.map((source) => ({
    tenant_id: tenant.id,
    player_id: playerIds.get(source.user_id),
    external_id: source.withdrawal_id,
    valor: number(source.valor),
    metodo: source.metodo.trim() || null,
    status: mapWithdrawalStatus(source.status),
    provider_status: source.status,
    created_at: iso(source.data_criacao),
    updated_at: iso(source.data_atualizacao),
    completed_at: iso(source.data_aprovacao),
  })).filter((row) => row.player_id);
  const existingDepositRows = depositRows
    .filter((row) => depositsByExternalId.has(row.external_id))
    .map((row) => ({ ...row, id: depositsByExternalId.get(row.external_id).id }));
  const newDepositRows = depositRows.filter((row) => !depositsByExternalId.has(row.external_id));
  const existingWithdrawalRows = withdrawalRows
    .filter((row) => withdrawalsByExternalId.has(row.external_id))
    .map((row) => ({ ...row, id: withdrawalsByExternalId.get(row.external_id).id }));
  const newWithdrawalRows = withdrawalRows.filter((row) => !withdrawalsByExternalId.has(row.external_id));
  await writeInBatches(supabase, "deposits", newDepositRows);
  await writeInBatches(supabase, "deposits", existingDepositRows, "id");
  await writeInBatches(supabase, "withdrawals", newWithdrawalRows);
  await writeInBatches(supabase, "withdrawals", existingWithdrawalRows, "id");

  const [afterPlayers, afterDeposits, afterWithdrawals] = await Promise.all([
    fetchAll(supabase, "players", "id", tenant.id),
    fetchAll(supabase, "deposits", "id", tenant.id),
    fetchAll(supabase, "withdrawals", "id", tenant.id),
  ]);
  console.log(JSON.stringify({ completed: true, players: afterPlayers.length, deposits: afterDeposits.length, withdrawals: afterWithdrawals.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
