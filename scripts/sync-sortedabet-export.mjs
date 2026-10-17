// Sincroniza a exportação do painel da Sorte da Bet (usuários + faturas pagas)
// com o tenant `sorte-da-bet`.
//
//   node --env-file=.env scripts/sync-sortedabet-export.mjs \
//     --users base/sortedabet_usuarios_2026-10-16.csv \
//     --invoices base/sortedabet_depositos_2026-10-16.csv [--apply]
//
// Sem --apply apenas mostra o plano. Contas `admin` e `affiliate` são da
// operação da casa e ficam de fora (use --include-staff para incluí-las).
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const INCLUDE_STAFF = process.argv.includes("--include-staff");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const TENANT_SLUG = option("--tenant", "sorte-da-bet");
const USERS_FILE = option("--users", "base/sortedabet_usuarios_2026-10-16.csv");
const INVOICES_FILE = option("--invoices", "base/sortedabet_depositos_2026-10-16.csv");
const STAFF_ROLES = new Set(["admin", "affiliate"]);
// A fatura do CSV leva o instante da criação; o deposit_created do webhook
// chega com poucos milissegundos de diferença.
const MATCH_WINDOW_MS = 15_000;
// `time` do webhook vem com o relógio de Brasília lido como UTC.
const BRASILIA_OFFSET_MS = 3 * 3_600_000;
const PAGE_SIZE = 1000;

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

function readCsv(file) {
  const lines = fs
    .readFileSync(path.resolve(process.cwd(), file), "utf8")
    .trim()
    .split(/\n/);
  const headers = parseCsvLine(lines[0].replace(/^﻿/, ""));
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, (values[index] ?? "").trim()]));
  });
}

function normalizeBrazilianPhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const local = digits.startsWith("55") && (digits.length === 12 || digits.length === 13)
    ? digits.slice(2)
    : digits;
  if (!/^[1-9]{2}(?:9\d{8}|[2-8]\d{7})$/.test(local)) return null;
  return `+55${local}`;
}

function validCpf(value) {
  const digits = String(value ?? "").replace(/\D/g, "").padStart(11, "0");
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return null;
  const check = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (length + 1 - index);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]) ? digits : null;
}

function number(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

const isPlaceholderName = (nome) => !nome || nome === "Novo player";

async function fetchAll(supabase, table, columns, apply) {
  const output = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await apply(supabase.from(table).select(columns))
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    output.push(...(data ?? []));
    if ((data ?? []).length < PAGE_SIZE) return output;
  }
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL e SUPABASE_SECRET_KEY são obrigatórios.");
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id,nome,slug")
    .eq("slug", TENANT_SLUG)
    .single();
  if (tenantError) throw new Error(`Tenant ${TENANT_SLUG}: ${tenantError.message}`);
  const byTenant = (query) => query.eq("tenant_id", tenant.id);

  const allUsers = readCsv(USERS_FILE);
  const staffIds = new Set(
    allUsers.filter((user) => STAFF_ROLES.has(user["Tipo de acesso"])).map((user) => user.ID),
  );
  const users = INCLUDE_STAFF ? allUsers : allUsers.filter((user) => !staffIds.has(user.ID));
  const userIds = new Set(users.map((user) => user.ID));
  const allInvoices = readCsv(INVOICES_FILE);
  const invoices = allInvoices.filter(
    (invoice) => invoice.Status === "paid" && userIds.has(invoice["User ID"]),
  );
  const orphanInvoices = allInvoices.filter(
    (invoice) => !allUsers.some((user) => user.ID === invoice["User ID"]),
  );
  if (orphanInvoices.length) {
    throw new Error(`Faturas sem usuário na exportação: ${orphanInvoices.length}`);
  }

  const [players, deposits, logs] = await Promise.all([
    fetchAll(
      supabase,
      "players",
      "id,player_external_id,nome,telefone,cpf,affiliate_id,ultimo_login",
      byTenant,
    ),
    fetchAll(supabase, "deposits", "id,external_id,status", byTenant),
    fetchAll(supabase, "webhook_logs", "id,evento,payload,created_at", (query) =>
      byTenant(query).in("evento", ["login", "deposito-pendente", "deposito-aprovado"]),
    ),
  ]);
  const playersByExternalId = new Map(players.map((player) => [player.player_external_id, player]));
  const depositsByExternalId = new Map(deposits.map((deposit) => [deposit.external_id, deposit]));

  // Ids reais das faturas, vindos dos webhooks que já chegaram (inclusive os
  // que falharam), para não criar um segundo depósito quando forem reprocessados.
  const webhookInvoices = new Map();
  const lastLoginByUser = new Map();
  for (const log of logs) {
    const payload = log.payload ?? {};
    const userId = payload.user?.id;
    if (!userId) continue;
    const eventAt = Number.isFinite(Number(payload.time))
      ? Number(payload.time) + BRASILIA_OFFSET_MS
      : Date.parse(log.created_at);
    if (log.evento === "login") {
      if (!lastLoginByUser.has(userId) || lastLoginByUser.get(userId) < eventAt) {
        lastLoginByUser.set(userId, eventAt);
      }
      continue;
    }
    const invoiceId = payload.internal_id ?? payload.external_id;
    if (!invoiceId) continue;
    const entry = webhookInvoices.get(invoiceId) ?? {
      invoiceId,
      userId,
      amount: number(payload.amount),
      createdAt: null,
      paidAt: null,
    };
    if (log.evento === "deposito-pendente") entry.createdAt = eventAt;
    if (log.evento === "deposito-aprovado") entry.paidAt = eventAt;
    webhookInvoices.set(invoiceId, entry);
  }
  const claimedInvoiceIds = new Set();
  const matchWebhookInvoice = (invoice) => {
    const at = Date.parse(invoice.Data);
    const amount = number(invoice.Valor);
    let best = null;
    for (const entry of webhookInvoices.values()) {
      if (claimedInvoiceIds.has(entry.invoiceId)) continue;
      if (entry.userId !== invoice["User ID"] || Math.abs(entry.amount - amount) > 0.005) continue;
      const reference = entry.createdAt ?? entry.paidAt;
      const distance = Math.abs(reference - at);
      if (distance <= MATCH_WINDOW_MS && (!best || distance < best.distance)) {
        best = { entry, distance };
      }
    }
    if (best) claimedInvoiceIds.add(best.entry.invoiceId);
    return best?.entry ?? null;
  };

  const depositRows = invoices.map((invoice) => {
    const match = matchWebhookInvoice(invoice);
    const createdAt = new Date(Date.parse(invoice.Data)).toISOString();
    return {
      userId: invoice["User ID"],
      external_id: match?.invoiceId ?? `csv:${invoice["User ID"]}:${createdAt}`,
      matched_webhook: Boolean(match),
      valor: number(invoice.Valor),
      created_at: createdAt,
      completed_at: match?.paidAt ? new Date(match.paidAt).toISOString() : createdAt,
    };
  });

  const totalsByUser = new Map();
  for (const row of depositRows) {
    const totals = totalsByUser.get(row.userId) ?? { total: 0, first: null, last: null };
    totals.total += row.valor;
    if (!totals.first || row.completed_at < totals.first) totals.first = row.completed_at;
    if (!totals.last || row.completed_at > totals.last) totals.last = row.completed_at;
    totalsByUser.set(row.userId, totals);
  }

  const newPlayers = [];
  const playerUpdates = [];
  for (const user of users) {
    const current = playersByExternalId.get(user.ID);
    const totals = totalsByUser.get(user.ID);
    const lastLogin = lastLoginByUser.get(user.ID);
    const financial = {
      saldo_carteira: number(user["Saldo BRL"]),
      total_depositado: Math.round((totals?.total ?? 0) * 100) / 100,
      ftd_em: totals?.first ?? null,
      ultimo_deposito: totals?.last ?? null,
    };
    if (!current) {
      newPlayers.push({
        tenant_id: tenant.id,
        player_external_id: user.ID,
        nome: user["Nome completo"] || "Novo player",
        email: user.Email || null,
        telefone: normalizeBrazilianPhone(user.Telefone),
        cpf: validCpf(user.Documento),
        affiliate_id: user.Afiliado || null,
        status: "ativo",
        created_at: user["Criado em"],
        updated_at: new Date().toISOString(),
        ultimo_login: lastLogin ? new Date(lastLogin).toISOString() : null,
        ...financial,
      });
      continue;
    }
    // Só completa o que falta ou que a exportação conhece melhor que o webhook;
    // nunca apaga contato já existente.
    const update = { id: current.id, ...financial, updated_at: new Date().toISOString() };
    if (isPlaceholderName(current.nome) && user["Nome completo"]) update.nome = user["Nome completo"];
    if (!current.cpf && validCpf(user.Documento)) update.cpf = validCpf(user.Documento);
    if (!current.telefone && normalizeBrazilianPhone(user.Telefone)) {
      update.telefone = normalizeBrazilianPhone(user.Telefone);
    }
    if (!current.affiliate_id && user.Afiliado) update.affiliate_id = user.Afiliado;
    // O webhook antigo gravava a data de cadastro como último login.
    if (lastLogin) update.ultimo_login = new Date(lastLogin).toISOString();
    playerUpdates.push(update);
  }

  const newDepositRows = depositRows.filter((row) => !depositsByExternalId.has(row.external_id));
  const pendingToApprove = depositRows.filter(
    (row) => depositsByExternalId.get(row.external_id)?.status === "pendente",
  );

  console.log(
    JSON.stringify(
      {
        tenant: tenant.nome,
        mode: APPLY ? "apply" : "dry-run",
        users: {
          source: allUsers.length,
          staff_excluded: INCLUDE_STAFF ? 0 : staffIds.size,
          insert: newPlayers.length,
          update: playerUpdates.length,
          names_filled: playerUpdates.filter((row) => row.nome).length,
          cpf_filled:
            playerUpdates.filter((row) => row.cpf).length +
            newPlayers.filter((row) => row.cpf).length,
          invalid_phones: users.filter((user) => !normalizeBrazilianPhone(user.Telefone)).length,
        },
        deposits: {
          source_paid: allInvoices.filter((invoice) => invoice.Status === "paid").length,
          staff_excluded: allInvoices.length - invoices.length,
          import: depositRows.length,
          matched_to_webhook_invoice: depositRows.filter((row) => row.matched_webhook).length,
          insert: newDepositRows.length,
          approve_existing_pending: pendingToApprove.length,
          already_present: depositRows.length - newDepositRows.length - pendingToApprove.length,
          total_value: depositRows.reduce((sum, row) => sum + row.valor, 0),
        },
      },
      null,
      2,
    ),
  );
  if (!APPLY) return;

  // Os índices únicos de players/deposits são parciais e o PostgREST não os
  // aceita em ON CONFLICT: relemos o banco logo antes de inserir, porque a casa
  // continua mandando webhooks durante a carga.
  const existingNow = new Set(
    (await fetchAll(supabase, "players", "id,player_external_id", byTenant)).map(
      (player) => player.player_external_id,
    ),
  );
  const playersToInsert = newPlayers.filter((row) => !existingNow.has(row.player_external_id));
  if (playersToInsert.length) {
    const { error } = await supabase.from("players").insert(playersToInsert);
    if (error) throw new Error(`players (insert): ${error.message}`);
  }
  for (const { id, ...update } of playerUpdates) {
    const { error } = await supabase
      .from("players")
      .update(update)
      .eq("id", id)
      .eq("tenant_id", tenant.id);
    if (error) throw new Error(`players (update ${id}): ${error.message}`);
  }

  const refreshed = await fetchAll(supabase, "players", "id,player_external_id", byTenant);
  const playerIds = new Map(refreshed.map((player) => [player.player_external_id, player.id]));
  const insertRows = newDepositRows.map((row) => ({
    tenant_id: tenant.id,
    player_id: playerIds.get(row.userId),
    valor: row.valor,
    status: "aprovado",
    metodo: "pix",
    external_id: row.external_id,
    provider_status: "paid",
    raw_payload: { source: "sortedabet_export", file: path.basename(INVOICES_FILE) },
    created_at: row.created_at,
    completed_at: row.completed_at,
    updated_at: new Date().toISOString(),
  }));
  if (insertRows.some((row) => !row.player_id)) throw new Error("Depósito sem player resolvido.");
  // Um webhook reprocessado pode ter criado a mesma fatura neste meio tempo.
  const depositsNow = new Set(
    (await fetchAll(supabase, "deposits", "id,external_id", byTenant)).map(
      (deposit) => deposit.external_id,
    ),
  );
  const depositsToInsert = insertRows.filter((row) => !depositsNow.has(row.external_id));
  if (depositsToInsert.length) {
    const { error } = await supabase.from("deposits").insert(depositsToInsert);
    if (error) throw new Error(`deposits (insert): ${error.message}`);
  }
  for (const row of pendingToApprove) {
    const { error } = await supabase
      .from("deposits")
      .update({
        status: "aprovado",
        completed_at: row.completed_at,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenant.id)
      .eq("external_id", row.external_id)
      .eq("status", "pendente");
    if (error) throw new Error(`deposits (approve ${row.external_id}): ${error.message}`);
  }

  const [afterPlayers, afterDeposits] = await Promise.all([
    fetchAll(supabase, "players", "id", byTenant),
    fetchAll(supabase, "deposits", "id,status,valor", byTenant),
  ]);
  const approved = afterDeposits.filter((deposit) => deposit.status === "aprovado");
  console.log(
    JSON.stringify({
      completed: true,
      players: afterPlayers.length,
      deposits: afterDeposits.length,
      approved_deposits: approved.length,
      approved_value: approved.reduce((sum, deposit) => sum + Number(deposit.valor), 0),
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
