// Helpers de deliverability — TODOS aditivos. Não alteram o motor de disparo.
//
// O que faz:
// 1. `isSuppressed(email)` — true se o endereço está na suppression list.
// 2. `getOrCreateUnsubscribeToken(email, tenantId)` — gera/recupera token único.
// 3. `augmentEmailHtml(html, { email, tenantId, baseUrl })` — injeta:
//      - rodapé com link "Descadastrar" (token único por destinatário)
//      - marcador invisível único por destinatário (anti-fingerprint em massa)
// 4. `suppressEmail(email, reason, tenantId?)` — adiciona à suppression list.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

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

export async function isSuppressed(email: string): Promise<boolean> {
  const key = norm(email);
  if (!key) return false;
  const cached = suppressionCache.get(key);
  const now = Date.now();
  if (cached && now - cached.t < SUPPRESSION_TTL_MS) return cached.v;
  try {
    const { data } = await supabaseAdmin
      .from("suppressed_emails")
      .select("id")
      .ilike("email", key)
      .limit(1)
      .maybeSingle();
    const v = !!data;
    suppressionCache.set(key, { v, t: now });
    return v;
  } catch (e) {
    // Em caso de erro, NÃO bloqueia o envio (fail-open).
    console.warn("isSuppressed lookup falhou — seguindo envio", e);
    return false;
  }
}

export async function suppressEmail(
  email: string,
  reason: "unsubscribe" | "complaint" | "bounce_hard" | "manual" | "repeated_failures",
  tenantId?: string | null,
  notes?: string,
): Promise<void> {
  const key = norm(email);
  if (!key) return;
  try {
    await supabaseAdmin.from("suppressed_emails").upsert(
      { email: key, reason, tenant_id: tenantId ?? null, notes: notes ?? null },
      { onConflict: "email" },
    );
    suppressionCache.set(key, { v: true, t: Date.now() });
  } catch (e) {
    console.error("suppressEmail falhou", e);
  }
}

function randomToken(): string {
  // base36 + crypto.randomUUID() — curto, URL-safe.
  return crypto.randomUUID().replace(/-/g, "");
}

export async function getOrCreateUnsubscribeToken(
  email: string,
  tenantId?: string | null,
): Promise<string | null> {
  const key = norm(email);
  if (!key) return null;
  try {
    const { data: existing } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .select("token")
      .ilike("email", key)
      .limit(1)
      .maybeSingle();
    if (existing?.token) return existing.token as string;
    const token = randomToken();
    const { data: inserted, error } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .insert({ token, email: key, tenant_id: tenantId ?? null })
      .select("token")
      .single();
    if (error) {
      // Conflito (outra requisição criou em paralelo) — relê.
      const { data: again } = await supabaseAdmin
        .from("email_unsubscribe_tokens")
        .select("token")
        .ilike("email", key)
        .limit(1)
        .maybeSingle();
      return (again?.token as string) ?? null;
    }
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