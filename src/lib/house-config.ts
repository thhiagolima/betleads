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

function stripWww(host: string): string {
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
