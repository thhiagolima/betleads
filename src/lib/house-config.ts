// Pure helpers for house onboarding/configuration (hostnames, quick links, setup checklist).
// No server imports: this module is used both client-side and server-side.

export type DomainKind = "shortener" | "email";
export type DomainStatus = "pending" | "verified" | "failed";

export type DnsRecord = {
  type: string;
  name: string;
  value: string;
  verified: boolean | null;
};

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

export function normalizeHostname(input: string): { ok: true; hostname: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Informe um domínio" };
  }

  let candidate = trimmed;
  // Allow a full URL to be pasted in.
  if (/^https?:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).hostname;
    } catch {
      return { ok: false, error: "Domínio inválido" };
    }
  } else {
    // Strip any path/query that may have been pasted without a scheme.
    candidate = candidate.split("/")[0].split("?")[0].split("#")[0];
  }

  candidate = candidate.toLowerCase();
  if (candidate.endsWith(".")) {
    candidate = candidate.slice(0, -1);
  }

  if (!candidate || candidate === "localhost") {
    return { ok: false, error: "Domínio inválido" };
  }

  if (IP_RE.test(candidate)) {
    return { ok: false, error: "Domínio inválido" };
  }

  if (!candidate.includes(".")) {
    return { ok: false, error: "Domínio inválido" };
  }

  if (!HOSTNAME_RE.test(candidate)) {
    return { ok: false, error: "Domínio inválido" };
  }

  return { ok: true, hostname: candidate };
}

export function validateShortenerHostname(hostname: string, siteUrl: string | null): string | null {
  if (!siteUrl) return null;

  let siteHost: string;
  try {
    siteHost = new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  const normalizedShortener = stripWww(hostname.toLowerCase());
  const normalizedSite = stripWww(siteHost);

  if (normalizedShortener !== normalizedSite) {
    return null;
  }

  return `Esse é o domínio do site da casa — use um subdomínio, ex.: go.${normalizedSite}`;
}

export const RESERVED_DOMAIN_ERROR = "Esse domínio é reservado da plataforma e não pode ser usado pela casa.";

const ALWAYS_RESERVED_DOMAINS = ["betleads.io", "betleads.app"];

/** Pulls a bare lower-case hostname out of an e-mail address, URL or hostname
 * string (env values may come in any of those shapes). */
function hostFromEnvValue(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  const at = v.lastIndexOf("@");
  if (at >= 0) v = v.slice(at + 1).replace(/>.*$/, "");
  if (/^https?:\/\//.test(v)) {
    try {
      v = new URL(v).hostname;
    } catch {
      return null;
    }
  } else {
    v = v.split("/")[0];
  }
  v = v.replace(/\.$/, "");
  return v || null;
}

/** Platform/CRM-owned domains a house can never claim: betleads.io,
 * betleads.app, the domain of PLATFORM_EMAIL_FROM (default betleads.io) and
 * the hostname of SHORTIO_DOMAIN — plus any subdomain of those. */
export function reservedPlatformDomains(env: {
  platformEmailFrom?: string | null;
  shortioDomain?: string | null;
}): string[] {
  const out = new Set<string>(ALWAYS_RESERVED_DOMAINS);
  const fromHost = hostFromEnvValue(env.platformEmailFrom);
  if (fromHost) out.add(fromHost);
  const shortHost = hostFromEnvValue(env.shortioDomain);
  if (shortHost) out.add(shortHost);
  return Array.from(out);
}

export function isReservedPlatformHostname(
  hostname: string,
  env: { platformEmailFrom?: string | null; shortioDomain?: string | null },
): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return reservedPlatformDomains(env).some((r) => host === r || host.endsWith(`.${r}`));
}

export type DomainProviderErrorCode = "ALREADY_EXISTS" | "INVALID" | "UNAVAILABLE" | "NOT_FOUND";

/** Admin-facing pt-BR text for a domain-provider failure. The raw provider
 * text (English, provider-specific) stays in server logs only. */
export function providerErrorMessage(code: DomainProviderErrorCode | null | undefined): string {
  switch (code) {
    case "ALREADY_EXISTS":
      return "Esse domínio já está cadastrado no provedor.";
    case "INVALID":
      return "O provedor recusou esse domínio. Confira se o nome está correto.";
    case "NOT_FOUND":
      return "Domínio não encontrado no provedor.";
    case "UNAVAILABLE":
    default:
      return "O provedor está indisponível no momento. Tente novamente em alguns minutos.";
  }
}

export function normalizeSiteUrl(input: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Informe a URL do site" };
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "URL inválida" };
  }

  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    return { ok: false, error: "URL inválida" };
  }

  let path = parsed.pathname;
  if (path === "/") path = "";
  if (path.endsWith("/")) path = path.slice(0, -1);

  return { ok: true, url: `https://${parsed.host}${path}` };
}

const ACCENT_MAP: Record<string, string> = {
  á: "a", à: "a", ã: "a", â: "a", ä: "a",
  é: "e", è: "e", ê: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i",
  ó: "o", ò: "o", õ: "o", ô: "o", ö: "o",
  ú: "u", ù: "u", û: "u", ü: "u",
  ç: "c", ñ: "n",
};

function removeAccents(input: string): string {
  return input
    .split("")
    .map((ch) => ACCENT_MAP[ch.toLowerCase()] ?? ch)
    .join("");
}

export function quickLinkKeyFromLabel(label: string): string {
  const ascii = removeAccents(label.toLowerCase());
  const slug = ascii
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30)
    .replace(/_+$/g, "");
  return slug;
}

export const QUICK_LINK_KEY_RE = /^[a-z0-9_]{1,30}$/;

export type QuickLinkInput = { id?: string; label: string; key?: string; path: string };
export type QuickLinkWriteRow = { key: string; label: string; path: string; position: number };

/** Appends `_2`, `_3`, ... to `base` until it is not in `taken`, keeping the
 * result within the 30-char key limit. */
function dedupeKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, 30 - suffix.length).replace(/_+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Plans a quick-links save without touching the database, so the whole set
 * is validated BEFORE anything is deleted:
 * - a row whose id matches an existing link keeps its STORED key (renaming
 *   the label never changes `{link_<key>}` already used in copy);
 * - an id that doesn't belong to the house is treated as a new row;
 * - new rows use the given key, or one derived from the label (derived keys
 *   get a numeric suffix when taken);
 * - every key must match ^[a-z0-9_]{1,30}$ and be unique (pt-BR error naming
 *   the duplicate).
 * Returns rows to update by id, rows to insert and existing ids to delete.
 */
export function planQuickLinksSave(
  links: QuickLinkInput[],
  existing: { id: string; key: string }[],
):
  | {
      ok: true;
      updates: (QuickLinkWriteRow & { id: string })[];
      inserts: QuickLinkWriteRow[];
      deleteIds: string[];
    }
  | { ok: false; error: string } {
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const keptIds = new Set<string>();
  const taken = new Set<string>();
  const updates: (QuickLinkWriteRow & { id: string })[] = [];
  const newPositions: number[] = [];

  // Pass 1: existing rows reserve their stored keys first.
  links.forEach((link, position) => {
    const stored = link.id ? existingById.get(link.id) : undefined;
    if (!stored || keptIds.has(stored.id)) {
      newPositions.push(position);
      return;
    }
    keptIds.add(stored.id);
    taken.add(stored.key);
    updates.push({ id: stored.id, key: stored.key, label: link.label.trim(), path: link.path.trim(), position });
  });

  // Pass 2: new rows with an explicit key (must be valid and unique).
  const keyByPosition = new Map<number, string>();
  for (const position of newPositions) {
    const explicit = links[position].key?.trim();
    if (!explicit) continue;
    if (!QUICK_LINK_KEY_RE.test(explicit)) {
      return {
        ok: false,
        error: `A chave "${explicit}" é inválida. Use só letras minúsculas, números e _ (até 30).`,
      };
    }
    if (taken.has(explicit)) {
      return {
        ok: false,
        error: `A chave "${explicit}" está repetida. Cada URL rápida precisa de uma chave única.`,
      };
    }
    taken.add(explicit);
    keyByPosition.set(position, explicit);
  }

  // Pass 3: new rows without a key get one derived from the label, with a
  // numeric suffix when already taken.
  for (const position of newPositions) {
    if (keyByPosition.has(position)) continue;
    const label = links[position].label.trim();
    const derived = quickLinkKeyFromLabel(label);
    if (!derived || !QUICK_LINK_KEY_RE.test(derived)) {
      return { ok: false, error: `Não foi possível gerar uma chave para "${label}"` };
    }
    const key = dedupeKey(derived, taken);
    taken.add(key);
    keyByPosition.set(position, key);
  }

  const inserts: QuickLinkWriteRow[] = newPositions.map((position) => ({
    key: keyByPosition.get(position) as string,
    label: links[position].label.trim(),
    path: links[position].path.trim(),
    position,
  }));

  const deleteIds = existing.filter((e) => !keptIds.has(e.id)).map((e) => e.id);
  return { ok: true, updates, inserts, deleteIds };
}

/** Pre-filled quick links offered when the house hasn't created any yet
 * (design spec: Login, Depósito, Promo). Purely a UI suggestion — the admin
 * can edit, remove or add to them before saving; nothing is written until
 * `saveQuickLinks` is called. */
export function suggestedQuickLinks(): { label: string; path: string }[] {
  return [
    { label: "Login", path: "/login" },
    { label: "Depósito", path: "/deposito" },
    { label: "Promo", path: "/promo" },
  ];
}

export function buildQuickLinkUrl(siteUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const base = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl;
  const rest = path.startsWith("/") ? path : `/${path}`;
  return `${base}${rest}`;
}

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

export function isDomainDueForCheck(
  d: { status: DomainStatus; created_at: string; last_checked_at: string | null },
  now: Date,
): boolean {
  if (!d.last_checked_at) return true;

  const lastChecked = new Date(d.last_checked_at).getTime();
  const elapsedSinceCheck = now.getTime() - lastChecked;

  if (d.status === "verified") {
    return elapsedSinceCheck >= 24 * MS_PER_HOUR;
  }

  // pending / failed: interval depends on domain age.
  const created = new Date(d.created_at).getTime();
  const age = now.getTime() - created;

  let interval: number;
  if (age < 6 * MS_PER_HOUR) {
    interval = 10 * MS_PER_MINUTE;
  } else if (age < 72 * MS_PER_HOUR) {
    interval = 60 * MS_PER_MINUTE;
  } else {
    interval = 24 * MS_PER_HOUR;
  }

  return elapsedSinceCheck >= interval;
}

export type SetupItemState = "done" | "pending_dns" | "todo";

function statusesState(statuses: DomainStatus[]): SetupItemState {
  if (statuses.some((s) => s === "verified")) return "done";
  if (statuses.length > 0) return "pending_dns";
  return "todo";
}

export function computeSetupChecklist(input: {
  siteUrl: string | null;
  shortenerStatuses: DomainStatus[];
  emailStatuses: DomainStatus[];
  hasVerifiedSender: boolean;
}): { items: { id: "house" | "shortener" | "email"; state: SetupItemState }[]; complete: boolean } {
  const houseState: SetupItemState = input.siteUrl ? "done" : "todo";
  const shortenerState = statusesState(input.shortenerStatuses);

  const hasVerifiedEmailDomain = input.emailStatuses.some((s) => s === "verified");
  let emailState: SetupItemState;
  if (hasVerifiedEmailDomain && input.hasVerifiedSender) {
    emailState = "done";
  } else if (input.emailStatuses.length > 0) {
    emailState = hasVerifiedEmailDomain ? "todo" : "pending_dns";
  } else {
    emailState = "todo";
  }

  const items: { id: "house" | "shortener" | "email"; state: SetupItemState }[] = [
    { id: "house", state: houseState },
    { id: "shortener", state: shortenerState },
    { id: "email", state: emailState },
  ];

  const complete = items.every((i) => i.state === "done");

  return { items, complete };
}
