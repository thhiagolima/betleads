// Short.io domain-management HTTP client (house onboarding).
// Central Betleads account: SHORTIO_API_KEY. No per-house credentials.
import type { DnsRecord, DomainStatus } from "@/lib/house-config";

const SHORTIO_BASE_URL = "https://api.short.io";
const SHORTIO_CNAME_TARGET = "cname.short.io";
const SHORTIO_DEFAULT_A_RECORD_IP = "207.174.61.1";

export type ProviderDomain = {
  providerDomainId: string;
  providerState: string;
  status: DomainStatus;
  dnsRecords: DnsRecord[];
};

export class DomainProviderError extends Error {
  code: "ALREADY_EXISTS" | "INVALID" | "UNAVAILABLE" | "NOT_FOUND";
  status: number;

  constructor(
    code: "ALREADY_EXISTS" | "INVALID" | "UNAVAILABLE" | "NOT_FOUND",
    status: number,
    message: string,
  ) {
    super(message);
    this.name = "DomainProviderError";
    this.code = code;
    this.status = status;
  }
}

/**
 * A hostname is a Short.io "root" domain (A record, not CNAME) when it has
 * exactly two labels (e.g. `x.com`), or when its public suffix is itself two
 * labels (`.bet.br` / `.com.br`) and the whole hostname has exactly three
 * labels (e.g. `suacasa.bet.br`). Anything with more labels is a subdomain.
 */
function isRootHostname(hostname: string): boolean {
  const labels = hostname.split(".");
  if (labels.length === 2) return true;
  if (labels.length === 3) {
    const suffix = labels.slice(1).join(".");
    return suffix === "bet.br" || suffix === "com.br";
  }
  return false;
}

export function shortioDnsRecords(hostname: string, configured: boolean): DnsRecord[] {
  if (isRootHostname(hostname)) {
    const ip = process.env.SHORTIO_A_RECORD_IP?.trim() || SHORTIO_DEFAULT_A_RECORD_IP;
    return [{ type: "A", name: "@", value: ip, verified: configured }];
  }
  const label = hostname.split(".")[0];
  return [{ type: "CNAME", name: label, value: SHORTIO_CNAME_TARGET, verified: configured }];
}

function statusFromState(state: string): DomainStatus {
  if (state === "configured") return "verified";
  if (state === "not_registered") return "failed";
  return "pending";
}

function requireApiKey(): string {
  const apiKey = process.env.SHORTIO_API_KEY?.trim();
  if (!apiKey) {
    throw new DomainProviderError(
      "UNAVAILABLE",
      0,
      "SHORTIO_API_KEY não configurada no servidor",
    );
  }
  return apiKey;
}

function mapErrorStatus(status: number, fallback: "INVALID" | "UNAVAILABLE" = "INVALID") {
  if (status === 404) return "NOT_FOUND" as const;
  if (status === 409) return "ALREADY_EXISTS" as const;
  if (status === 402 || status >= 500) return "UNAVAILABLE" as const;
  return fallback;
}

async function throwForResponse(response: Response, actionLabel: string): Promise<never> {
  const code = mapErrorStatus(response.status);
  throw new DomainProviderError(
    code,
    response.status,
    `Short.io retornou HTTP ${response.status} ao ${actionLabel}`,
  );
}

function toProviderDomain(id: unknown, state: unknown, hostname: string): ProviderDomain {
  const providerState = typeof state === "string" ? state : "unknown";
  const status = statusFromState(providerState);
  return {
    providerDomainId: String(id),
    providerState,
    status,
    dnsRecords: shortioDnsRecords(hostname, status === "verified"),
  };
}

export async function createShortioDomain(hostname: string): Promise<ProviderDomain> {
  const apiKey = requireApiKey();
  const response = await fetch(`${SHORTIO_BASE_URL}/domains`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ hostname, linkType: "random" }),
  });
  if (!response.ok) await throwForResponse(response, "criar o domínio");
  const body = (await response.json()) as { id?: unknown; state?: unknown };
  return toProviderDomain(body.id, body.state, hostname);
}

export async function getShortioDomain(id: string, hostname: string): Promise<ProviderDomain> {
  const apiKey = requireApiKey();
  const response = await fetch(`${SHORTIO_BASE_URL}/domains/${encodeURIComponent(id)}`, {
    headers: { authorization: apiKey, Accept: "application/json" },
  });
  if (!response.ok) await throwForResponse(response, "consultar o domínio");
  const body = (await response.json()) as { id?: unknown; state?: unknown };
  return toProviderDomain(body.id, body.state, hostname);
}

export async function findShortioDomainByHostname(
  hostname: string,
): Promise<ProviderDomain | null> {
  const apiKey = requireApiKey();
  const response = await fetch(
    `${SHORTIO_BASE_URL}/api/domains?pattern=${encodeURIComponent(hostname)}`,
    { headers: { authorization: apiKey, Accept: "application/json" } },
  );
  if (!response.ok) await throwForResponse(response, "listar domínios");
  const body = (await response.json()) as unknown;
  const items = Array.isArray(body) ? body : [];
  const match = items.find(
    (item): item is { id: unknown; state: unknown; hostname: unknown } =>
      Boolean(item) && typeof item === "object" && (item as { hostname?: unknown }).hostname === hostname,
  );
  if (!match) return null;
  return toProviderDomain(match.id, match.state, hostname);
}

export async function deleteShortioDomain(id: string): Promise<void> {
  const apiKey = requireApiKey();
  const response = await fetch(
    `${SHORTIO_BASE_URL}/domains/delete/${encodeURIComponent(id)}`,
    { method: "POST", headers: { authorization: apiKey, Accept: "application/json" } },
  );
  if (!response.ok) await throwForResponse(response, "remover o domínio");
}
