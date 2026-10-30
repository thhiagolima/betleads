// Infobip domain-management HTTP client (house onboarding).
// Each call runs against one Infobip account (provider-accounts.server.ts):
// the house's e-mail account, defaulting to the platform account.
import type { DnsRecord } from "@/lib/house-config";
import { envInfobipAccount, type InfobipAccount } from "@/lib/provider-accounts.server";
import { DomainProviderError, type ProviderDomain } from "./shortio-domains.server";

type InfobipDnsRecord = {
  recordType?: unknown;
  name?: unknown;
  expectedValue?: unknown;
  verified?: unknown;
};

type InfobipDomainBody = {
  domainId?: unknown;
  active?: unknown;
  blocked?: unknown;
  dnsRecords?: unknown;
};

function requireConfig(account: InfobipAccount): { apiKey: string; baseUrl: string } {
  const key = account.apiKey;
  const url = account.baseUrl;
  if (!key || !url) {
    throw new DomainProviderError(
      "UNAVAILABLE",
      0,
      "INFOBIP_BASE_URL ou INFOBIP_API_KEY não configurado no servidor",
    );
  }
  return { apiKey: key, baseUrl: url };
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `App ${apiKey}`, Accept: "application/json" };
}

function mapDnsRecords(records: unknown): DnsRecord[] {
  if (!Array.isArray(records)) return [];
  return records.map((raw) => {
    const record = raw as InfobipDnsRecord;
    return {
      type: typeof record.recordType === "string" ? record.recordType : "",
      name: typeof record.name === "string" ? record.name : "",
      value: typeof record.expectedValue === "string" ? record.expectedValue : "",
      verified: typeof record.verified === "boolean" ? record.verified : null,
    };
  });
}

function toProviderDomain(body: InfobipDomainBody): ProviderDomain {
  const dnsRecords = mapDnsRecords(body.dnsRecords);
  const active = body.active === true;
  const blocked = body.blocked === true;
  const status = blocked
    ? "failed"
    : active && dnsRecords.every((record) => record.verified === true)
      ? "verified"
      : "pending";
  return {
    providerDomainId: String(body.domainId),
    providerState: active ? "active" : "inactive",
    status,
    dnsRecords,
  };
}

async function extractErrorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { requestError?: { serviceException?: { text?: unknown } } }
    | null;
  const text = body?.requestError?.serviceException?.text;
  return typeof text === "string" ? text : "";
}

async function throwForResponse(response: Response, actionLabel: string): Promise<never> {
  const text = await extractErrorText(response);
  const code =
    response.status === 404
      ? ("NOT_FOUND" as const)
      : /already exists/i.test(text)
        ? ("ALREADY_EXISTS" as const)
        : response.status >= 500
          ? ("UNAVAILABLE" as const)
          : ("INVALID" as const);
  throw new DomainProviderError(
    code,
    response.status,
    text || `Infobip retornou HTTP ${response.status} ao ${actionLabel}`,
  );
}

export async function createInfobipDomain(
  domainName: string,
  account: InfobipAccount = envInfobipAccount(),
): Promise<ProviderDomain> {
  const { apiKey, baseUrl } = requireConfig(account);
  const response = await fetch(`${baseUrl}/email/1/domains`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({
      domainName,
      dkimKeyLength: 2048,
      targetedDailyTraffic: 1000,
    }),
  });
  if (!response.ok) await throwForResponse(response, "criar o domínio");
  const body = (await response.json()) as InfobipDomainBody;
  return toProviderDomain(body);
}

export async function getInfobipDomain(
  domainName: string,
  account: InfobipAccount = envInfobipAccount(),
): Promise<ProviderDomain> {
  const { apiKey, baseUrl } = requireConfig(account);
  const response = await fetch(
    `${baseUrl}/email/1/domains/${encodeURIComponent(domainName)}`,
    { headers: authHeaders(apiKey) },
  );
  if (!response.ok) await throwForResponse(response, "consultar o domínio");
  const body = (await response.json()) as InfobipDomainBody;
  return toProviderDomain(body);
}

export async function requestInfobipVerification(
  domainName: string,
  account: InfobipAccount = envInfobipAccount(),
): Promise<void> {
  const { apiKey, baseUrl } = requireConfig(account);
  const response = await fetch(
    `${baseUrl}/email/1/domains/${encodeURIComponent(domainName)}/verify`,
    { method: "POST", headers: authHeaders(apiKey) },
  );
  if (!response.ok) await throwForResponse(response, "solicitar a verificação do domínio");
}

export async function deleteInfobipDomain(
  domainName: string,
  account: InfobipAccount = envInfobipAccount(),
): Promise<void> {
  const { apiKey, baseUrl } = requireConfig(account);
  const response = await fetch(
    `${baseUrl}/email/1/domains/${encodeURIComponent(domainName)}`,
    { method: "DELETE", headers: authHeaders(apiKey) },
  );
  if (response.status === 204 || response.ok) return;
  await throwForResponse(response, "remover o domínio");
}
