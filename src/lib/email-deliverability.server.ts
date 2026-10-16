// Helpers de deliverability — TODOS aditivos. Não alteram o motor de disparo.
//
// O que faz:
// 1. `isSuppressed(email, tenantId)` — true se o endereço está na suppression list
//    da casa (ou global). Fail-closed: erro de consulta lança.
// 2. `getOrCreateUnsubscribeToken(email, tenantId)` — gera/recupera token único.
// 3. `augmentEmailHtml(html, { email, tenantId, baseUrl })` — injeta:
//      - rodapé com link "Descadastrar" (token único por destinatário)
//      - marcador invisível único por destinatário (anti-fingerprint em massa)
// 4. `suppressEmail(email, reason, tenantId?)` — adiciona à suppression list da casa
//    e revoga o consentimento com auditoria. Lança em erro.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeConsentSubject } from "./consent.server";

const APP_BASE_URL = (
  process.env.PUBLIC_APP_URL ||
  process.env.VITE_PUBLIC_APP_URL ||
  "https://betleads.io"
).replace(/\/+$/, "");

// Cache simples em memória pra reduzir hit no banco em rajadas de envio.
// Curto o suficiente pra não atrapalhar descadastros recentes (60s).
const suppressionCache = new Map<string, { v: boolean; t: number }>();
const SUPPRESSION_TTL_MS = 60_000;

function norm(email: string): string {
  return (email || "").trim().toLowerCase();
}

/** Test-only: forget cached lookups so each test reads the database. */
export function __resetSuppressionCacheForTests() {
  suppressionCache.clear();
}

/**
 * True if the address is suppressed for this tenant (or globally).
 * Fail-closed (QA-03): a lookup error THROWS — callers must not send and should
 * retry later. E-mails are stored normalized (migration 20261017110000), so the
 * comparison is exact: no ilike, no `_`/`%` wildcards (QA-18).
 */
export async function isSuppressed(email: string, tenantId?: string | null): Promise<boolean> {
  const normalized = norm(email);
  const key = `${tenantId ?? "global"}:${normalized}`;
  if (!normalized) return false;
  const cached = suppressionCache.get(key);
  const now = Date.now();
  if (cached && now - cached.t < SUPPRESSION_TTL_MS) return cached.v;
  let query = supabaseAdmin.from("suppressed_emails").select("id").eq("email", normalized);
  // Without a tenant every row counts (most conservative).
  if (tenantId) query = query.or(`tenant_id.eq.${tenantId},tenant_id.is.null`);
  const { data, error } = await query.limit(1);
  if (error) throw new Error(`Falha ao consultar lista de supressao de e-mail: ${error.message}`);
  const v = (data?.length ?? 0) > 0;
  suppressionCache.set(key, { v, t: now });
  return v;
}

/**
 * Adds the address to the suppression list of the tenant (or the global list
 * when tenantId is null) and, for a tenant, revokes the e-mail consent with an
 * audit row. Throws on any database error so the caller can tell the user the
 * opt-out did not go through (QA-01).
 */
export async function suppressEmail(
  email: string,
  reason: "unsubscribe" | "complaint" | "bounce_hard" | "manual" | "repeated_failures",
  tenantId?: string | null,
  notes?: string,
): Promise<void> {
  const key = norm(email);
  if (!key) return;
  const { error: suppressError } = await supabaseAdmin
    .from("suppressed_emails")
    .upsert(
      { email: key, reason, tenant_id: tenantId ?? null, notes: notes ?? null },
      { onConflict: "tenant_id,email" },
    );
  if (suppressError)
    throw new Error(`Falha ao gravar supressao de e-mail: ${suppressError.message}`);
  if (tenantId) {
    const db = supabaseAdmin as any;
    const subject = normalizeConsentSubject("email", key);
    const { data: previous, error: previousError } = await db
      .from("channel_consents")
      .select("status")
      .eq("tenant_id", tenantId)
      .eq("channel", "email")
      .eq("subject", subject)
      .maybeSingle();
    if (previousError)
      throw new Error(`Falha ao ler consentimento de e-mail: ${previousError.message}`);
    const { data: consent, error: consentError } = await db
      .from("channel_consents")
      .upsert(
        {
          tenant_id: tenantId,
          channel: "email",
          subject,
          status: "revoked",
          reason,
          source: "unsubscribe",
          occurred_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,channel,subject" },
      )
      .select("id")
      .single();
    if (consentError)
      throw new Error(`Falha ao revogar consentimento de e-mail: ${consentError.message}`);
    const { error: auditError } = await db.from("channel_consent_audit").insert({
      tenant_id: tenantId,
      consent_id: consent?.id ?? null,
      channel: "email",
      subject,
      previous_status: previous?.status ?? null,
      new_status: "revoked",
      reason,
      source: "unsubscribe",
    });
    if (auditError)
      throw new Error(`Falha ao auditar revogacao de e-mail: ${auditError.message}`);
  }
  suppressionCache.set(`${tenantId ?? "global"}:${key}`, { v: true, t: Date.now() });
}

function randomToken(): string {
  // base36 + crypto.randomUUID() — curto, URL-safe.
  return crypto.randomUUID().replace(/-/g, "");
}

async function findUnsubscribeToken(key: string, tenantId: string | null): Promise<string | null> {
  let query = supabaseAdmin.from("email_unsubscribe_tokens").select("token").eq("email", key);
  query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0]?.token as string | undefined) ?? null;
}

/**
 * Token of the unsubscribe link, one per (tenant, e-mail): the link opts the
 * address out of THIS tenant only (SEC-18).
 */
export async function getOrCreateUnsubscribeToken(
  email: string,
  tenantId?: string | null,
): Promise<string | null> {
  const key = norm(email);
  if (!key) return null;
  const tenant = tenantId ?? null;
  try {
    const existing = await findUnsubscribeToken(key, tenant);
    if (existing) return existing;
    const token = randomToken();
    const { data: inserted, error } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .insert({ token, email: key, tenant_id: tenant })
      .select("token")
      .single();
    if (error) return await findUnsubscribeToken(key, tenant);
    return (inserted?.token as string) ?? null;
  } catch (e) {
    console.warn("getOrCreateUnsubscribeToken falhou", e);
    return null;
  }
}

function buildFooterHtml(unsubscribeUrl: string): string {
  // Rodapé sóbrio, neutro, sem emoji. Cor cinza claro.
  return (
    `<div style="margin-top:32px;padding:20px 24px;border-top:1px solid #e5e7eb;` +
    `font:12px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;text-align:center;line-height:1.6">` +
    `Você recebeu este email porque está cadastrado em nossa lista.` +
    `<br />Se não quiser mais receber, ` +
    `<a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline">clique aqui para descadastrar</a>.` +
    `</div>`
  );
}

function buildInvisibleMarker(email: string): string {
  // Marcador único por destinatário — quebra fingerprint idêntico em massa.
  // Comentário HTML é ignorado pelos clientes de email mas entra no corpo.
  const seed = `${email}|${Date.now()}|${Math.random().toString(36).slice(2, 10)}`;
  return `<!--m:${seed}-->`;
}

/**
 * Aplica melhorias de deliverability no HTML do email.
 * - Injeta rodapé com link de descadastro (se conseguiu gerar token).
 * - Injeta marcador invisível único por destinatário.
 *
 * Se algo falhar, retorna o HTML original (fail-open). Nunca quebra o envio.
 */
export async function augmentEmailHtml(
  html: string,
  opts: { email: string; tenantId?: string | null },
): Promise<{ html: string; unsubscribeUrl: string | null }> {
  if (!html) return { html, unsubscribeUrl: null };
  let unsubscribeUrl: string | null = null;
  try {
    const token = await getOrCreateUnsubscribeToken(opts.email, opts.tenantId ?? null);
    if (token) unsubscribeUrl = `${APP_BASE_URL}/u/${token}`;
  } catch {
    /* fail-open */
  }

  const marker = buildInvisibleMarker(opts.email);
  const footer = unsubscribeUrl ? buildFooterHtml(unsubscribeUrl) : "";

  // Injeção antes de </body> se existir; senão concatena no fim.
  let out = html;
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${footer}${marker}</body>`);
  } else {
    out = `${out}${footer}${marker}`;
  }
  return { html: out, unsubscribeUrl };
}

export function getAppBaseUrl(): string {
  return APP_BASE_URL;
}
