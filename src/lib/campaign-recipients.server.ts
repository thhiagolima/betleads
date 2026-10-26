// ENV-06 — resolves campaign recipients to tenant players by normalized phone,
// in bounded chunks (`telefone = ANY(...)` via PostgREST `in`), instead of
// loading the whole player table with `.range(0, 49_999)`.
import {
  campaignPhoneKey,
  smsConsentSubject,
  type RecipientAssignment,
  type RecipientResolution,
  type ResolvedRecipient,
  type UnresolvedReason,
  type UnresolvedRecipient,
} from "./campaign-recipients";

/* eslint-disable @typescript-eslint/no-explicit-any -- accepts the admin client or a test double. */
export type CampaignDb = { from: (table: string) => any };

/** Values per `in(...)` filter: keeps the PostgREST URL short and every page below max_rows. */
export const RESOLUTION_CHUNK_SIZE = 300;
const RESOLUTION_PARALLELISM = 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Statuses of an SMS log that the provider accepted (same set as sendSmsInternal). */
export const ACCEPTED_SMS_STATUSES = ["sent", "delivered", "enviado", "entregue"];

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function forEachChunk<T>(
  items: readonly T[],
  size: number,
  fn: (part: T[]) => Promise<void>,
): Promise<void> {
  const parts = chunk(items, size);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(RESOLUTION_PARALLELISM, parts.length) },
    async () => {
      while (next < parts.length) {
        const part = parts[next++];
        await fn(part);
      }
    },
  );
  await Promise.all(workers);
}

export type CampaignRecipientInput = { phone: string; playerId?: string | null };

/**
 * Splits campaign inputs into recipients that map to a player of this tenant and
 * recipients that will not be sent, each with a reason. Never throws because of
 * unresolved recipients; throws only on database errors.
 *
 * - A client-supplied playerId is honored only if the player belongs to the
 *   tenant, and then the SMS goes to that player's stored phone (the
 *   client-supplied phone is ignored).
 * - Phones are matched against `players.telefone`, which the
 *   `trg_players_normalize_phone` trigger stores as E.164 (`+55...`).
 * - When several players share a phone, the most recently updated wins (deterministic).
 * - `sem_consentimento`: an SMS consent explicitly revoked (`channel_consents`).
 * - `grupo_controle`: the player is in an open journey control group (F3); a
 *   mass campaign would contaminate the measurement. Individual sends (one
 *   recipient) are not affected.
 * - The same player listed twice is sent once (`duplicates`).
 */
export async function resolveCampaignRecipients(
  db: CampaignDb,
  tenantId: string,
  inputs: readonly CampaignRecipientInput[],
  options: { chunkSize?: number; checkConsent?: boolean; excludeHoldout?: boolean } = {},
): Promise<RecipientResolution> {
  const chunkSize = Math.max(1, options.chunkSize ?? RESOLUTION_CHUNK_SIZE);
  const rows = inputs.map((input) => ({
    raw: String(input.phone ?? "").trim(),
    normalized: campaignPhoneKey(input.phone),
    claimed:
      typeof input.playerId === "string" && UUID_RE.test(input.playerId) ? input.playerId : null,
  }));

  // 1. Client-supplied player ids must belong to this tenant.
  const owned = new Map<string, string | null>();
  const claimedIds = Array.from(new Set(rows.map((r) => r.claimed).filter(Boolean))) as string[];
  await forEachChunk(claimedIds, chunkSize, async (ids) => {
    const { data, error } = await db
      .from("players")
      .select("id,telefone")
      .eq("tenant_id", tenantId)
      .in("id", ids);
    if (error) throw new Error(`Falha ao validar jogadores da campanha: ${error.message}`);
    for (const p of (data ?? []) as Array<{ id: string; telefone: string | null }>) {
      owned.set(p.id, p.telefone ?? null);
    }
  });

  // 2. Phone lookup for everything not already tied to an owned player.
  const phones = Array.from(
    new Set(
      rows
        .filter((r) => !(r.claimed && owned.has(r.claimed)) && r.normalized)
        .map((r) => r.normalized as string),
    ),
  );
  const byPhone = new Map<string, { id: string; updatedAt: string }>();
  await forEachChunk(phones, chunkSize, async (part) => {
    const { data, error } = await db
      .from("players")
      .select("id,telefone,updated_at")
      .eq("tenant_id", tenantId)
      .in("telefone", part);
    if (error) throw new Error(`Falha ao resolver destinatários da campanha: ${error.message}`);
    for (const p of (data ?? []) as Array<{
      id: string;
      telefone: string | null;
      updated_at: string | null;
    }>) {
      if (!p.telefone) continue;
      const candidate = { id: p.id, updatedAt: p.updated_at ?? "" };
      const current = byPhone.get(p.telefone);
      if (
        !current ||
        candidate.updatedAt > current.updatedAt ||
        (candidate.updatedAt === current.updatedAt && candidate.id < current.id)
      ) {
        byPhone.set(p.telefone, candidate);
      }
    }
  });

  // 3. Classify in input order.
  type Classified =
    | { kind: "resolved"; phone: string; playerId: string }
    | { kind: "unresolved"; phone: string; reason: UnresolvedReason };
  const classified: Classified[] = rows.map((r) => {
    if (r.claimed && owned.has(r.claimed)) {
      // I7: always the player's own stored phone, never the client-supplied
      // one (a tenant player id must not route an SMS to an arbitrary number).
      const phone = campaignPhoneKey(owned.get(r.claimed));
      return phone
        ? { kind: "resolved", phone, playerId: r.claimed }
        : { kind: "unresolved", phone: r.raw.slice(0, 40), reason: "telefone_invalido" };
    }
    if (!r.normalized)
      return { kind: "unresolved", phone: r.raw.slice(0, 40), reason: "telefone_invalido" };
    const hit = byPhone.get(r.normalized);
    return hit
      ? { kind: "resolved", phone: r.normalized, playerId: hit.id }
      : { kind: "unresolved", phone: r.normalized, reason: "sem_cadastro" };
  });

  // 4. Explicitly revoked SMS consent (same rule sendSmsInternal applies at send time).
  if (options.checkConsent !== false) {
    const subjects = Array.from(
      new Set(
        classified.filter((c) => c.kind === "resolved").map((c) => smsConsentSubject(c.phone)),
      ),
    );
    const revoked = new Set<string>();
    await forEachChunk(subjects, chunkSize, async (part) => {
      const { data, error } = await db
        .from("channel_consents")
        .select("subject")
        .eq("tenant_id", tenantId)
        .eq("channel", "sms")
        .eq("status", "revoked")
        .in("subject", part);
      if (error) throw new Error(`Falha ao validar consentimento da campanha: ${error.message}`);
      for (const row of (data ?? []) as Array<{ subject: string }>) revoked.add(row.subject);
    });
    if (revoked.size > 0) {
      for (let i = 0; i < classified.length; i++) {
        const c = classified[i];
        if (c.kind === "resolved" && revoked.has(smsConsentSubject(c.phone))) {
          classified[i] = { kind: "unresolved", phone: c.phone, reason: "sem_consentimento" };
        }
      }
    }
  }

  // 4b. Journey control groups stay out of mass campaigns (one recipient = an
  // individual send, a deliberate operator choice).
  if (options.excludeHoldout ?? inputs.length > 1) {
    const playerIds = Array.from(
      new Set(
        classified
          .filter((c): c is Extract<Classified, { kind: "resolved" }> => c.kind === "resolved")
          .map((c) => c.playerId),
      ),
    );
    const holdout = new Set<string>();
    await forEachChunk(playerIds, chunkSize, async (part) => {
      const { data, error } = await db
        .from("journey_enrollments")
        .select("player_id")
        .eq("tenant_id", tenantId)
        .eq("is_holdout", true)
        .in("status", ["active", "waiting", "paused_by_priority"])
        .in("player_id", part);
      // The column ships with a migration; until then nobody is excluded.
      if (error && isMissingColumnError(error)) return;
      if (error) throw new Error(`Falha ao validar grupo de controle: ${error.message}`);
      for (const row of (data ?? []) as Array<{ player_id: string }>) holdout.add(row.player_id);
    });
    if (holdout.size > 0) {
      for (let i = 0; i < classified.length; i++) {
        const c = classified[i];
        if (c.kind === "resolved" && holdout.has(c.playerId)) {
          classified[i] = { kind: "unresolved", phone: c.phone, reason: "grupo_controle" };
        }
      }
    }
  }

  // 5. One message per player; one report row per (phone, reason).
  const resolved: ResolvedRecipient[] = [];
  const unresolved: UnresolvedRecipient[] = [];
  const seenPlayers = new Set<string>();
  const seenUnresolved = new Set<string>();
  let duplicates = 0;
  for (const c of classified) {
    if (c.kind === "resolved") {
      if (seenPlayers.has(c.playerId)) {
        duplicates++;
        continue;
      }
      seenPlayers.add(c.playerId);
      resolved.push({ phone: c.phone, playerId: c.playerId });
    } else {
      const key = `${c.reason}|${c.phone}`;
      if (seenUnresolved.has(key)) {
        duplicates++;
        continue;
      }
      seenUnresolved.add(key);
      unresolved.push({ phone: c.phone, reason: c.reason });
    }
  }
  const assignments: RecipientAssignment[] = classified.map((c) =>
    c.kind === "resolved"
      ? { phone: c.phone, playerId: c.playerId, reason: null }
      : { phone: c.phone, playerId: null, reason: c.reason },
  );
  return { resolved, unresolved, duplicates, assignments };
}

/** Canonical phones (of `phones`) that already belong to a player of the tenant. */
export async function findRegisteredPhones(
  db: CampaignDb,
  tenantId: string,
  phones: readonly string[],
  chunkSize = RESOLUTION_CHUNK_SIZE,
): Promise<Set<string>> {
  const registered = new Set<string>();
  await forEachChunk(Array.from(new Set(phones)), Math.max(1, chunkSize), async (part) => {
    const { data, error } = await db
      .from("players")
      .select("telefone")
      .eq("tenant_id", tenantId)
      .in("telefone", part);
    if (error) throw new Error(`Falha ao verificar jogadores da lista: ${error.message}`);
    for (const row of (data ?? []) as Array<{ telefone: string | null }>) {
      if (row.telefone) registered.add(row.telefone);
    }
  });
  return registered;
}

export type ExternalListResolution = {
  /** Sendable numbers (canonical `+55…`), input order, no duplicates. */
  phones: string[];
  unresolved: UnresolvedRecipient[];
  duplicates: number;
};

/**
 * Recipients of an SMS campaign to an external phone list. Nothing is written:
 * a number that already belongs to a player is left out (`ja_jogador`, the list
 * is for people who have not registered), an invalid one is reported, and an
 * explicitly revoked SMS consent is honored like in player campaigns.
 */
export async function resolveExternalListRecipients(
  db: CampaignDb,
  tenantId: string,
  rawPhones: readonly string[],
  options: { chunkSize?: number } = {},
): Promise<ExternalListResolution> {
  const chunkSize = Math.max(1, options.chunkSize ?? RESOLUTION_CHUNK_SIZE);
  const unresolved: UnresolvedRecipient[] = [];
  const seen = new Set<string>();
  const valid: string[] = [];
  let duplicates = 0;
  for (const raw of rawPhones) {
    const phone = campaignPhoneKey(raw);
    if (!phone) {
      unresolved.push({
        phone: String(raw ?? "")
          .trim()
          .slice(0, 40),
        reason: "telefone_invalido",
      });
      continue;
    }
    if (seen.has(phone)) {
      duplicates++;
      continue;
    }
    seen.add(phone);
    valid.push(phone);
  }

  const registered = await findRegisteredPhones(db, tenantId, valid, chunkSize);
  const revoked = new Set<string>();
  const subjects = valid.filter((p) => !registered.has(p)).map(smsConsentSubject);
  await forEachChunk(subjects, chunkSize, async (part) => {
    const { data, error } = await db
      .from("channel_consents")
      .select("subject")
      .eq("tenant_id", tenantId)
      .eq("channel", "sms")
      .eq("status", "revoked")
      .in("subject", part);
    if (error) throw new Error(`Falha ao validar consentimento da campanha: ${error.message}`);
    for (const row of (data ?? []) as Array<{ subject: string }>) revoked.add(row.subject);
  });

  const phones: string[] = [];
  for (const phone of valid) {
    if (registered.has(phone)) unresolved.push({ phone, reason: "ja_jogador" });
    else if (revoked.has(smsConsentSubject(phone)))
      unresolved.push({ phone, reason: "sem_consentimento" });
    else phones.push(phone);
  }
  return { phones, unresolved, duplicates };
}

/** Column/relation not deployed yet (code may ship before the migration). */
export function isMissingColumnError(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return (
    error.code === "PGRST204" ||
    error.code === "42703" ||
    /column .* does not exist|could not find the .* column/i.test(error.message ?? "")
  );
}

/**
 * Persists the unresolved list of a campaign. Best effort: a missing column
 * (migration 20261015113000 not applied) only logs, it never blocks the send.
 */
export async function persistCampaignUnresolved(
  db: CampaignDb,
  campaignId: string,
  unresolved: readonly UnresolvedRecipient[],
): Promise<boolean> {
  const { error } = await db
    .from("sms_campaigns")
    .update({ unresolved_count: unresolved.length, unresolved_recipients: unresolved })
    .eq("id", campaignId);
  if (!error) return true;
  console.warn("[sms-campaigns] não foi possível registrar destinatários não enviados", {
    campaignId,
    missingColumn: isMissingColumnError(error),
    error: error.message,
  });
  return false;
}

/** Delivery keys that already have a provider-accepted SMS log (dedupe per campaign+player). */
export async function findAcceptedDeliveryKeys(
  db: CampaignDb,
  keys: readonly string[],
): Promise<Set<string>> {
  const accepted = new Set<string>();
  const unique = Array.from(new Set(keys));
  await forEachChunk(unique, RESOLUTION_CHUNK_SIZE, async (part) => {
    const { data, error } = await db
      .from("sms_send_logs")
      .select("idempotency_key")
      .in("idempotency_key", part)
      .in("status", ACCEPTED_SMS_STATUSES);
    if (error) throw new Error(`Falha ao consultar envios anteriores: ${error.message}`);
    for (const row of (data ?? []) as Array<{ idempotency_key: string | null }>) {
      if (row.idempotency_key) accepted.add(row.idempotency_key);
    }
  });
  return accepted;
}
