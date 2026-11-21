// Saldo da Short Brasil: a cada 15 min (cron
// 20261231101900_sms_balance_monitor_cron.sql) entra no painel com o login da
// conta padrão (SHORT_BRASIL_PAINEL_USUARIO/SENHA) e lê o saldo de SMS
// shortcode. A API da Short Brasil não tem consulta de saldo; o painel carrega
// o número por uma chamada Sajax (rs=atualiza_box_shortcode), que é o que se
// chama aqui, sem abrir navegador.
//
// O painel só responde em HTTP e o cookie de sessão dele carrega a senha em
// texto: por isso o login fica só no servidor e nunca vai para o banco.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchWithTimeout } from "@/lib/owned-account-isolation.server";

import {
  MAX_BALANCE_VIEWERS,
  computeBalanceStatus,
  parseShortcodeBalance,
  type BalanceCheckResult,
  type BalanceCheckRow,
  type BalanceStatus,
  type BalanceUserOption,
} from "./sms-balance";

const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const BALANCE_RETENTION_DAYS = 30;
const STATUS_WINDOW_MS = 24 * 3_600_000;
const PANEL_TIMEOUT_MS = 15_000;
const DEFAULT_PANEL_URL = "http://painelsms.businesscode.com.br";

type PanelConfig = { baseUrl: string; usuario: string; senha: string };

function panelConfig(): PanelConfig | null {
  const usuario = process.env.SHORT_BRASIL_PAINEL_USUARIO?.trim();
  const senha = process.env.SHORT_BRASIL_PAINEL_SENHA?.trim();
  if (!usuario || !senha) return null;
  const baseUrl = (process.env.SHORT_BRASIL_PAINEL_URL?.trim() || DEFAULT_PANEL_URL).replace(/\/+$/, "");
  return { baseUrl, usuario, senha };
}

export type PanelRead = { result: BalanceCheckResult; shortcodeSms: number | null; error: string | null };

/** Cookies `nome=valor` da resposta, sem os que o painel apaga ("deleted"). */
function sessionCookies(response: Response): string {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "deleted") jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Login + leitura do saldo. Nunca lança: o erro volta resumido em `error`. */
export async function readPanelBalance(
  config: PanelConfig | null = panelConfig(),
  now: Date = new Date(),
): Promise<PanelRead> {
  if (!config) {
    return {
      result: "error",
      shortcodeSms: null,
      error: "Login do painel não configurado (SHORT_BRASIL_PAINEL_USUARIO/SENHA).",
    };
  }
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  try {
    const login = await fetchWithTimeout(
      `${config.baseUrl}/index.php`,
      {
        method: "POST",
        headers,
        body: form({ username: config.usuario, password: config.senha, acessar_sistema: "1" }),
        redirect: "manual",
      },
      PANEL_TIMEOUT_MS,
      "Painel da Short Brasil não respondeu ao login",
    );
    const cookie = sessionCookies(login);
    const location = login.headers.get("location") ?? "";
    if (!cookie || location.includes("erro=")) {
      return { result: "login_failed", shortcodeSms: null, error: "O painel recusou o login." };
    }
    const response = await fetchWithTimeout(
      `${config.baseUrl}/rev-transferir.php`,
      {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        body: form({ rs: "atualiza_box_shortcode", rst: "", rsrnd: String(now.getTime()) }),
        redirect: "manual",
      },
      PANEL_TIMEOUT_MS,
      "Painel da Short Brasil não respondeu à leitura do saldo",
    );
    if (response.status >= 300 && response.status < 400) {
      return { result: "login_failed", shortcodeSms: null, error: "O painel encerrou a sessão." };
    }
    const body = await response.text();
    const balance = parseShortcodeBalance(body);
    if (balance == null) {
      return {
        result: "read_failed",
        shortcodeSms: null,
        error: `Saldo não encontrado na resposta do painel (HTTP ${response.status}).`,
      };
    }
    return { result: "ok", shortcodeSms: balance, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: "error", shortcodeSms: null, error: message.slice(0, 300) };
  }
}

/** Uma leitura: grava o resultado e apaga as leituras mais velhas que 30 dias. */
export async function runSmsBalanceCheck(now: Date): Promise<PanelRead> {
  const read = await readPanelBalance(panelConfig(), now);
  const { error } = await db().from("sms_balance_checks").insert({
    checked_at: new Date().toISOString(),
    result: read.result,
    shortcode_sms: read.shortcodeSms,
    error: read.error,
  });
  if (error) throw new Error(error.message);
  const cutoff = new Date(now.getTime() - BALANCE_RETENTION_DAYS * 86_400_000).toISOString();
  const { error: purgeError } = await db().from("sms_balance_checks").delete().lt("checked_at", cutoff);
  if (purgeError) console.error("[sms-balance] purge failed", purgeError.message);
  return read;
}

export type BalanceSettings = {
  lowThreshold: number;
  viewerUserIds: string[];
  updatedAt: string | null;
};

export async function loadBalanceSettings(): Promise<BalanceSettings> {
  const { data, error } = await db()
    .from("sms_balance_settings")
    .select("low_threshold, viewer_user_ids, updated_at")
    .eq("id", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { low_threshold: number; viewer_user_ids: string[] | null; updated_at: string } | null;
  return {
    lowThreshold: row?.low_threshold ?? 1000,
    viewerUserIds: row?.viewer_user_ids ?? [],
    updatedAt: row?.updated_at ?? null,
  };
}

type AuthUser = { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null };

async function listAuthUsers(): Promise<AuthUser[]> {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(error.message);
  return (data?.users ?? []) as AuthUser[];
}

function displayName(user: AuthUser): string {
  const meta = user.user_metadata ?? {};
  const nome = meta.nome ?? meta.name ?? meta.full_name;
  if (typeof nome === "string" && nome.trim()) return nome.trim();
  return user.email ?? user.id;
}

/** Ids escolhidos na tela, só de usuários que existem, sem repetidos. Lança com a mensagem para a tela. */
export function validateViewerIds(raw: string[], users: AuthUser[]): string[] {
  const known = new Set(users.map((u) => u.id));
  const ids: string[] = [];
  for (const id of raw) {
    if (!known.has(id)) throw new Error("Um dos usuários escolhidos não existe mais. Atualize a tela.");
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_BALANCE_VIEWERS) throw new Error(`No máximo ${MAX_BALANCE_VIEWERS} usuários.`);
  return ids;
}

export async function saveBalanceSettings(
  input: { lowThreshold: number; viewerUserIds: string[] },
  userId: string,
): Promise<BalanceSettings> {
  const viewerUserIds = validateViewerIds(input.viewerUserIds, await listAuthUsers());
  const updatedAt = new Date().toISOString();
  const { error } = await db()
    .from("sms_balance_settings")
    .upsert(
      {
        id: true,
        low_threshold: input.lowThreshold,
        viewer_user_ids: viewerUserIds,
        updated_at: updatedAt,
        updated_by: userId,
      },
      { onConflict: "id" },
    );
  if (error) throw new Error(error.message);
  return { lowThreshold: input.lowThreshold, viewerUserIds, updatedAt };
}

async function recentChecks(now: Date, limit: number): Promise<BalanceCheckRow[]> {
  const since = new Date(now.getTime() - STATUS_WINDOW_MS).toISOString();
  const { data, error } = await db()
    .from("sms_balance_checks")
    .select("checked_at, result, shortcode_sms, error")
    .gte("checked_at", since)
    .order("checked_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as BalanceCheckRow[];
}

export async function loadBalanceStatus(now: Date): Promise<BalanceStatus> {
  const settings = await loadBalanceSettings();
  return computeBalanceStatus(await recentChecks(now, 120), settings.lowThreshold, now);
}

export type BalanceOverview = {
  configured: boolean;
  settings: BalanceSettings;
  /** Usuários que não são super admin, em ordem de nome. */
  users: BalanceUserOption[];
  status: BalanceStatus;
  recent: BalanceCheckRow[];
};

async function userOptions(users: AuthUser[]): Promise<BalanceUserOption[]> {
  const [roles, tenants] = await Promise.all([
    db().from("user_roles").select("user_id, tenant_id, role"),
    db().from("tenants").select("id, nome"),
  ]);
  if (roles.error) throw new Error(roles.error.message);
  if (tenants.error) throw new Error(tenants.error.message);
  const tenantName = new Map(
    ((tenants.data ?? []) as Array<{ id: string; nome: string }>).map((t) => [t.id, t.nome]),
  );
  const superAdmins = new Set<string>();
  const casas = new Map<string, Set<string>>();
  for (const row of (roles.data ?? []) as Array<{ user_id: string; tenant_id: string | null; role: string }>) {
    if (row.role === "super_admin") superAdmins.add(row.user_id);
    const nome = row.tenant_id ? tenantName.get(row.tenant_id) : null;
    if (!nome) continue;
    const set = casas.get(row.user_id) ?? new Set<string>();
    set.add(nome);
    casas.set(row.user_id, set);
  }
  return users
    .filter((u) => !superAdmins.has(u.id))
    .map((u) => ({
      userId: u.id,
      email: u.email ?? "",
      nome: displayName(u),
      casas: [...(casas.get(u.id) ?? [])].sort((a, b) => a.localeCompare(b, "pt-BR")),
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

export async function loadBalanceOverview(now: Date): Promise<BalanceOverview> {
  const [settings, rows, authUsers] = await Promise.all([
    loadBalanceSettings(),
    recentChecks(now, 120),
    listAuthUsers(),
  ]);
  return {
    configured: panelConfig() != null,
    settings,
    users: await userOptions(authUsers),
    status: computeBalanceStatus(rows, settings.lowThreshold, now),
    recent: rows.slice(0, 20),
  };
}
