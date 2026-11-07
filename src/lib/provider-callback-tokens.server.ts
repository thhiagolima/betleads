// Token de callback por conta de provedor (conta própria da casa).
//
// Contas com dono (provider_accounts.owner_tenant_id) recebem os callbacks
// dos provedores com um token só delas, `pa_<id sem hífens>_<32 bytes
// base64url>`, guardado cifrado em provider_accounts.callback_token_encrypted
// (secret-box, mesma chave das credenciais). As contas da plataforma seguem
// com os tokens globais de hoje (env).
//
// Cada rota de callback resolve o escopo uma vez (resolveCallbackScope) e só
// aplica um evento à linha de log cujo provider_account_id o escopo permite
// (scopeAllowsRow): o token de uma conta só mexe nos envios dela, e o token
// global nunca mexe em envio de conta com dono.
//
// Caches em memória do processo: token em claro (5 min) e ids das contas com
// dono (30 s). Esta instância descarta o cache de ids quando gera o primeiro
// token de uma conta (invalidateOwnedAccountIdsCache); as outras instâncias
// enxergam uma conta que acabou de ganhar dono em até 30 s — nessa janela o
// token global ainda poderia aplicar um callback a um envio dela.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptProviderCredentials, encryptProviderCredentials } from "./secret-box.server";

export type CallbackScope =
  { kind: "platform" } | { kind: "account"; accountId: string; tenantId: string };

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const TOKEN_PREFIX = "pa_";
const TOKEN_CACHE_MS = 5 * 60_000;
const OWNED_IDS_CACHE_MS = 30_000;
const TOUCH_INTERVAL_MS = 60_000;

/** accountId -> token em claro (só contas com dono), para não decifrar a cada envio. */
const tokenCache = new Map<string, { token: string; at: number }>();
let ownedIdsCache: { ids: ReadonlySet<string>; at: number } | null = null;
const lastTouch = new Map<string, number>();

/** Drops this instance's owned-ids cache (other instances: <= 30 s). */
export function invalidateOwnedAccountIdsCache() {
  ownedIdsCache = null;
}

export function __resetCallbackTokensForTests() {
  tokenCache.clear();
  ownedIdsCache = null;
  lastTouch.clear();
}

/** Constant-time string comparison (no `crypto` import: see build-before-merge). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function compactId(accountId: string): string {
  return accountId.replace(/-/g, "").toLowerCase();
}

/** `pa_<32 hex>_...` -> uuid da conta; null quando o formato não bate. */
function accountIdOfToken(token: string): string | null {
  const m = /^pa_([0-9a-f]{32})_[A-Za-z0-9_-]+$/.exec(token);
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function newToken(accountId: string): string {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  return `${TOKEN_PREFIX}${compactId(accountId)}_${secret}`;
}

async function readTokenRow(
  accountId: string,
): Promise<{ owner_tenant_id: string | null; callback_token_encrypted: string | null } | null> {
  const { data, error } = await db()
    .from("provider_accounts")
    .select("id, owner_tenant_id, callback_token_encrypted")
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function decryptToken(encrypted: string): Promise<string | null> {
  const { token } = await decryptProviderCredentials(encrypted);
  return typeof token === "string" && token ? token : null;
}

/**
 * Token de callback da conta: gera e grava (cifrado) na primeira vez,
 * devolve o existente nas demais. Duas chamadas concorrentes convergem para
 * o token que ficou gravado.
 */
export async function ensureCallbackToken(accountId: string): Promise<string> {
  const cached = tokenCache.get(accountId);
  if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.token;

  const row = await readTokenRow(accountId);
  if (!row) throw new Error("Conta de provedor não encontrada.");
  let token = row.callback_token_encrypted
    ? await decryptToken(row.callback_token_encrypted)
    : null;
  if (!token) {
    const candidate = newToken(accountId);
    const { error } = await db()
      .from("provider_accounts")
      .update({ callback_token_encrypted: await encryptProviderCredentials({ token: candidate }) })
      .eq("id", accountId)
      .is("callback_token_encrypted", null);
    if (error) throw new Error(error.message);
    // A conta que recebe o primeiro token é (ou acabou de virar) conta com
    // dono: o escopo plataforma desta instância passa a recusá-la já.
    invalidateOwnedAccountIdsCache();
    // Outra instância pode ter gravado antes: vale o que está no banco.
    const stored = await readTokenRow(accountId);
    token = stored?.callback_token_encrypted
      ? await decryptToken(stored.callback_token_encrypted)
      : null;
    if (!token) throw new Error("Não foi possível gravar o token de callback da conta.");
  }
  tokenCache.set(accountId, { token, at: Date.now() });
  return token;
}

/**
 * Token que vai nas URLs de callback de um envio: o da conta quando ela tem
 * dono; null para conta da plataforma (quem chama usa o token global).
 */
export async function callbackTokenFor(account: {
  id: string;
  ownerTenantId: string | null;
}): Promise<string | null> {
  if (account.ownerTenantId === null) return null;
  return ensureCallbackToken(account.id);
}

/**
 * Escopo de um callback recebido. Token `pa_` -> conta com dono cujo token
 * gravado é igual (comparação em tempo constante); senão, token global ->
 * plataforma. Qualquer outra coisa -> null (401 na rota).
 */
export async function resolveCallbackScope(
  token: string | null,
  globalToken: string | undefined,
): Promise<CallbackScope | null> {
  const received = token?.trim() ?? "";
  if (!received) return null;
  if (received.startsWith(TOKEN_PREFIX)) {
    const accountId = accountIdOfToken(received);
    if (accountId) {
      try {
        const row = await readTokenRow(accountId);
        if (row?.owner_tenant_id && row.callback_token_encrypted) {
          const stored = await decryptToken(row.callback_token_encrypted);
          if (stored && safeEqual(stored, received)) {
            return { kind: "account", accountId, tenantId: row.owner_tenant_id };
          }
        }
      } catch (error) {
        console.error("[callback-token] falha ao validar token de conta", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const expected = globalToken?.trim();
  if (expected && safeEqual(expected, received)) return { kind: "platform" };
  return null;
}

/**
 * Se o escopo pode aplicar um evento à linha de log com esse
 * provider_account_id: a conta só aceita as linhas dela; a plataforma recusa
 * as de conta com dono (NULL = envio legado da plataforma).
 */
export function scopeAllowsRow(
  scope: CallbackScope,
  rowProviderAccountId: string | null,
  ownedAccountIds: ReadonlySet<string>,
): boolean {
  if (scope.kind === "account") return rowProviderAccountId === scope.accountId;
  return rowProviderAccountId === null || !ownedAccountIds.has(rowProviderAccountId);
}

/** ids das contas com dono (cache curto em memória). */
export async function loadOwnedAccountIds(): Promise<ReadonlySet<string>> {
  if (ownedIdsCache && Date.now() - ownedIdsCache.at < OWNED_IDS_CACHE_MS) return ownedIdsCache.ids;
  const { data, error } = await db()
    .from("provider_accounts")
    .select("id")
    .not("owner_tenant_id", "is", null);
  if (error) throw new Error(error.message);
  const ids: ReadonlySet<string> = new Set(
    ((data ?? []) as Array<{ id: string }>).map((row) => row.id),
  );
  ownedIdsCache = { ids, at: Date.now() };
  return ids;
}

/** ownedAccountIds só é necessário no escopo da plataforma. */
export async function ownedAccountIdsFor(scope: CallbackScope): Promise<ReadonlySet<string>> {
  return scope.kind === "platform" ? loadOwnedAccountIds() : new Set();
}

/** last_callback_at = agora, no máximo uma escrita por minuto por conta. Nunca lança. */
export async function touchCallbackReceived(accountId: string): Promise<void> {
  const now = Date.now();
  const last = lastTouch.get(accountId);
  if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
  lastTouch.set(accountId, now);
  try {
    const { error } = await db()
      .from("provider_accounts")
      .update({ last_callback_at: new Date(now).toISOString() })
      .eq("id", accountId);
    if (error) throw new Error(error.message);
  } catch (error) {
    console.error("[callback-token] last_callback_at não gravado", {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
