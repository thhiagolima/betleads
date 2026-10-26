// House domain service (shortener + email custom domains). Owns the
// tenant_domains table: add/refresh/default/usage/remove/purge. Provider
// HTTP calls live in src/lib/domain-providers/*; this module only knows how
// to turn a ProviderDomain into a tenant_domains row and keep the
// "one verified default per tenant+kind" invariant consistent.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import {
  type DnsRecord,
  type DomainKind,
  type DomainStatus,
  isReservedPlatformHostname,
  normalizeHostname,
  providerErrorMessage,
  RESERVED_DOMAIN_ERROR,
  validateShortenerHostname,
} from "@/lib/house-config";
import {
  createShortioDomain,
  deleteShortioDomain,
  DomainProviderError,
  findShortioDomainByHostname,
  getShortioDomain,
  type ProviderDomain,
} from "@/lib/domain-providers/shortio-domains.server";
import {
  createInfobipDomain,
  deleteInfobipDomain,
  getInfobipDomain,
  requestInfobipVerification,
} from "@/lib/domain-providers/infobip-domains.server";

export type TenantDomain = {
  id: string;
  tenant_id: string;
  kind: DomainKind;
  hostname: string;
  status: DomainStatus;
  is_default: boolean;
  dns_records: DnsRecord[];
  provider_domain_id: string | null;
  last_checked_at: string | null;
  verified_at: string | null;
  last_error: string | null;
  removed_at: string | null;
  created_at: string;
};

type DomainRow = {
  id: string;
  tenant_id: string;
  kind: DomainKind;
  hostname: string;
  status: DomainStatus;
  provider_domain_id: string | null;
  provider_state: string | null;
  dns_records: DnsRecord[] | null;
  is_default: boolean;
  last_checked_at: string | null;
  verified_at: string | null;
  last_error: string | null;
  removed_at: string | null;
  created_by?: string | null;
  created_at: string;
};

function rowToDomain(row: DomainRow): TenantDomain {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    kind: row.kind,
    hostname: row.hostname,
    status: row.status,
    is_default: row.is_default,
    dns_records: (row.dns_records ?? []) as DnsRecord[],
    provider_domain_id: row.provider_domain_id,
    last_checked_at: row.last_checked_at,
    verified_at: row.verified_at,
    last_error: row.last_error,
    removed_at: row.removed_at,
    created_at: row.created_at,
  };
}

async function fetchDomainById(id: string): Promise<DomainRow | null> {
  const { data, error } = await supabaseAdmin
    .from("tenant_domains")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DomainRow | null) ?? null;
}

/** If no other verified domain of this kind is already the default, promote this one. */
async function maybeAutoDefault(tenantId: string, kind: DomainKind, domainId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("tenant_domains")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("kind", kind)
    .eq("is_default", true)
    .is("removed_at", null);
  if (error) throw new Error(error.message);
  if ((data ?? []).length > 0) return;

  const { error: updErr } = await supabaseAdmin
    .from("tenant_domains")
    .update({ is_default: true })
    .eq("id", domainId)
    .is("removed_at", null);
  if (updErr) throw new Error(updErr.message);
}

/** Promotes the oldest-verified remaining domain of this kind to default. */
async function promoteNextDefault(tenantId: string, kind: DomainKind, excludeId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("tenant_domains")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("kind", kind)
    .eq("status", "verified")
    .is("removed_at", null)
    .neq("id", excludeId)
    .order("verified_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const next = (data ?? [])[0] as { id: string } | undefined;
  if (!next) return;

  const { error: updErr } = await supabaseAdmin
    .from("tenant_domains")
    .update({ is_default: true })
    .eq("id", next.id)
    .is("removed_at", null);
  if (updErr) throw new Error(updErr.message);
}

function reservedEnv() {
  return {
    platformEmailFrom: process.env.PLATFORM_EMAIL_FROM?.trim() || "no-reply@betleads.io",
    shortioDomain: process.env.SHORTIO_DOMAIN?.trim() || null,
  };
}

/** True for platform/CRM-owned hostnames (betleads.io, betleads.app, the
 * PLATFORM_EMAIL_FROM domain, SHORTIO_DOMAIN) and their subdomains. */
export function isReservedHostname(hostname: string): boolean {
  return isReservedPlatformHostname(hostname, reservedEnv());
}

/** Turns any provider failure into the admin-facing pt-BR message, logging
 * the raw provider text on the server only. */
function toAdminProviderMessage(err: unknown, context: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  console.warn(`[tenant-domains] ${context}: ${raw}`);
  return providerErrorMessage(err instanceof DomainProviderError ? err.code : "UNAVAILABLE");
}

/** The central Short.io / Infobip accounts hold domains of other projects
 * too, so a hostname that already exists at the provider is adopted only when
 * this same tenant already has a (removed) row for it. Anything else is
 * rejected and logged so a super admin can attach it manually if legitimate. */
function rejectUnownedProviderDomain(
  err: DomainProviderError,
  tenantId: string,
  kind: DomainKind,
  hostname: string,
): DomainProviderError {
  console.warn(
    `[tenant-domains] ${kind} domain ${hostname} already exists at the provider and has no row for tenant ${tenantId}; not adopting (attach manually if legitimate)`,
  );
  return err;
}

export async function addTenantDomain(input: {
  tenantId: string;
  kind: DomainKind;
  rawHostname: string;
  userId: string;
}): Promise<TenantDomain> {
  const normalized = normalizeHostname(input.rawHostname);
  if (!normalized.ok) throw new Error(normalized.error);
  const hostname = normalized.hostname;

  if (isReservedHostname(hostname)) throw new Error(RESERVED_DOMAIN_ERROR);

  if (input.kind === "shortener") {
    const { data: tenantRow, error: tenantErr } = await supabaseAdmin
      .from("tenants")
      .select("site_url")
      .eq("id", input.tenantId)
      .maybeSingle();
    if (tenantErr) throw new Error(tenantErr.message);
    const siteUrl = (tenantRow as { site_url: string | null } | null)?.site_url ?? null;
    const hostnameError = validateShortenerHostname(hostname, siteUrl);
    if (hostnameError) throw new Error(hostnameError);
  }

  // Every row with this hostname, any kind and any case (`hostname` only
  // holds [a-z0-9.-] after normalization, so ilike is an exact,
  // case-insensitive match — older backfilled rows may be mixed case).
  // A hostname belongs to one house only (any kind); within that house it may
  // be both the shortener and the e-mail domain, so only a row of the SAME
  // kind counts as "this domain already exists".
  const { data: existingRows, error: existingErr } = await supabaseAdmin
    .from("tenant_domains")
    .select("*")
    .ilike("hostname", hostname);
  if (existingErr) throw new Error(existingErr.message);
  const sameHostname = (existingRows ?? []) as DomainRow[];

  if (sameHostname.some((row) => row.tenant_id !== input.tenantId)) {
    throw new Error("Esse domínio já está em uso por outra conta");
  }
  const existing = sameHostname.find((row) => row.kind === input.kind);

  if (existing && !existing.removed_at) {
    // Already active for this tenant: just bring it up to date.
    return refreshTenantDomain(existing.id);
  }

  let provider: ProviderDomain;
  // A verify-request failure right after a successful create is not fatal:
  // the domain was registered at the provider, so the row must still be
  // persisted (otherwise it becomes an orphan at the provider with no local
  // row). Record it as the row's last_error instead.
  let createVerifyError: string | null = null;
  try {
    if (input.kind === "shortener") {
      try {
        provider = await createShortioDomain(hostname);
      } catch (err) {
        if (err instanceof DomainProviderError && err.code === "ALREADY_EXISTS") {
          if (!existing) throw rejectUnownedProviderDomain(err, input.tenantId, input.kind, hostname);
          const found = await findShortioDomainByHostname(hostname);
          if (!found) throw err;
          provider = found;
        } else {
          throw err;
        }
      }
    } else {
      try {
        provider = await createInfobipDomain(hostname);
      } catch (err) {
        if (err instanceof DomainProviderError && err.code === "ALREADY_EXISTS") {
          // Only reactivating this tenant's own removed row may adopt the
          // domain that already exists in the central Infobip account.
          if (!existing) throw rejectUnownedProviderDomain(err, input.tenantId, input.kind, hostname);
          provider = await getInfobipDomain(hostname);
        } else {
          throw err;
        }
      }
      try {
        await requestInfobipVerification(hostname);
      } catch (err) {
        createVerifyError = toAdminProviderMessage(err, `verify request for ${hostname}`);
      }
    }
  } catch (err) {
    throw new Error(toAdminProviderMessage(err, `register ${input.kind} domain ${hostname}`));
  }

  const now = new Date().toISOString();
  const payload = {
    tenant_id: input.tenantId,
    kind: input.kind,
    hostname,
    status: provider.status,
    provider_domain_id: provider.providerDomainId,
    provider_state: provider.providerState,
    dns_records: provider.dnsRecords,
    is_default: false,
    last_checked_at: now,
    verified_at: provider.status === "verified" ? now : null,
    last_error: createVerifyError,
    removed_at: null,
    created_by: input.userId,
  };

  let saved: DomainRow;
  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("tenant_domains")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    saved = data as DomainRow;
  } else {
    const { data, error } = await supabaseAdmin
      .from("tenant_domains")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    saved = data as DomainRow;
  }

  if (saved.status === "verified") {
    await maybeAutoDefault(input.tenantId, input.kind, saved.id);
    saved = (await fetchDomainById(saved.id)) as DomainRow;
  }

  return rowToDomain(saved);
}

export async function refreshTenantDomain(
  domainId: string,
  opts?: { requestVerify?: boolean },
): Promise<TenantDomain> {
  const row = await fetchDomainById(domainId);
  if (!row) throw new Error("Domínio não encontrado");

  const now = new Date().toISOString();
  let provider: ProviderDomain;
  let providerIdToStore = row.provider_domain_id;

  try {
    if (row.kind === "shortener") {
      if (!providerIdToStore) {
        const found = await findShortioDomainByHostname(row.hostname);
        if (!found) {
          throw new DomainProviderError("NOT_FOUND", 404, "Domínio não encontrado no Short.io");
        }
        provider = found;
        providerIdToStore = found.providerDomainId;
      } else {
        provider = await getShortioDomain(providerIdToStore, row.hostname);
      }
    } else {
      if (opts?.requestVerify) {
        await requestInfobipVerification(row.hostname);
      }
      provider = await getInfobipDomain(row.hostname);
      providerIdToStore = provider.providerDomainId;
    }
  } catch (err) {
    const message = toAdminProviderMessage(err, `refresh ${row.kind} domain ${row.hostname}`);
    const { data, error } = await supabaseAdmin
      .from("tenant_domains")
      .update({ last_error: message, last_checked_at: now })
      .eq("id", domainId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return rowToDomain(data as DomainRow);
  }

  const wasVerified = row.status === "verified";
  const isVerified = provider.status === "verified";
  const losingDefault = wasVerified && !isVerified && row.is_default;

  const update: Database["public"]["Tables"]["tenant_domains"]["Update"] = {
    status: provider.status,
    provider_state: provider.providerState,
    dns_records: provider.dnsRecords,
    provider_domain_id: providerIdToStore,
    last_checked_at: now,
    last_error: null,
    verified_at: isVerified ? (wasVerified ? row.verified_at : now) : null,
  };
  if (losingDefault) update.is_default = false;

  const { data, error } = await supabaseAdmin
    .from("tenant_domains")
    .update(update)
    .eq("id", domainId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  let saved = data as DomainRow;

  // A removed domain never becomes (or keeps being) the default — it is out
  // of rotation regardless of what the provider reports.
  if (!row.removed_at) {
    if (isVerified && !wasVerified) {
      await maybeAutoDefault(row.tenant_id, row.kind, domainId);
      saved = (await fetchDomainById(domainId)) as DomainRow;
    } else if (losingDefault) {
      await promoteNextDefault(row.tenant_id, row.kind, domainId);
    }
  }

  return rowToDomain(saved);
}

export async function setDefaultTenantDomain(tenantId: string, domainId: string): Promise<void> {
  const row = await fetchDomainById(domainId);
  if (!row || row.tenant_id !== tenantId || row.removed_at) {
    throw new Error("Domínio não encontrado");
  }
  if (row.status !== "verified") {
    throw new Error("Só domínios verificados podem ser padrão");
  }

  const { error: clearErr } = await supabaseAdmin
    .from("tenant_domains")
    .update({ is_default: false })
    .eq("tenant_id", tenantId)
    .eq("kind", row.kind)
    .eq("is_default", true)
    .is("removed_at", null);
  if (clearErr) throw new Error(clearErr.message);

  const { error: setErr } = await supabaseAdmin
    .from("tenant_domains")
    .update({ is_default: true })
    .eq("id", domainId);
  if (setErr) throw new Error(setErr.message);
}

export async function findDomainUsages(
  tenantId: string,
  domainId: string,
): Promise<{ campaigns: { id: string; name: string }[]; journeys: { id: string; name: string }[] }> {
  const row = await fetchDomainById(domainId);
  if (!row || row.tenant_id !== tenantId) return { campaigns: [], journeys: [] };

  const campaigns: { id: string; name: string }[] = [];
  let senderIds: string[] = [];

  if (row.kind === "shortener") {
    const { data: smsRows, error: smsErr } = await supabaseAdmin
      .from("sms_campaigns")
      .select("id,name")
      .eq("tenant_id", tenantId)
      .eq("status", "agendada")
      .eq("short_domain_id", domainId);
    if (smsErr) throw new Error(smsErr.message);
    campaigns.push(...((smsRows ?? []) as { id: string; name: string }[]));

    const { data: emailRows, error: emailErr } = await supabaseAdmin
      .from("email_campaigns")
      .select("id,name")
      .eq("tenant_id", tenantId)
      .eq("status", "agendada")
      .eq("short_domain_id", domainId);
    if (emailErr) throw new Error(emailErr.message);
    campaigns.push(...((emailRows ?? []) as { id: string; name: string }[]));
  } else {
    const { data: senderRows, error: senderErr } = await supabaseAdmin
      .from("email_senders")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("domain_id", domainId);
    if (senderErr) throw new Error(senderErr.message);
    senderIds = ((senderRows ?? []) as { id: string }[]).map((s) => s.id);

    if (senderIds.length > 0) {
      const { data: emailRows, error: emailErr } = await supabaseAdmin
        .from("email_campaigns")
        .select("id,name")
        .eq("tenant_id", tenantId)
        .eq("status", "agendada")
        .in("sender_id", senderIds);
      if (emailErr) throw new Error(emailErr.message);
      campaigns.push(...((emailRows ?? []) as { id: string; name: string }[]));
    }
  }

  const { data: activeJourneys, error: journeyErr } = await supabaseAdmin
    .from("journeys")
    .select("id,name")
    .eq("tenant_id", tenantId)
    .eq("status", "active");
  if (journeyErr) throw new Error(journeyErr.message);
  const journeyNameById = new Map<string, string>();
  for (const j of (activeJourneys ?? []) as { id: string; name: string }[]) {
    journeyNameById.set(j.id, j.name);
  }

  const journeys: { id: string; name: string }[] = [];
  if (journeyNameById.size > 0) {
    const { data: steps, error: stepsErr } = await supabaseAdmin
      .from("journey_steps")
      .select("journey_id,config")
      .eq("tenant_id", tenantId)
      .in("journey_id", Array.from(journeyNameById.keys()));
    if (stepsErr) throw new Error(stepsErr.message);

    const matchedJourneyIds = new Set<string>();
    for (const step of (steps ?? []) as { journey_id: string; config: Record<string, unknown> | null }[]) {
      const config = step.config ?? {};
      const matches =
        row.kind === "shortener"
          ? config.short_domain_id === domainId
          : senderIds.includes(config.sender_id as string);
      if (matches) matchedJourneyIds.add(step.journey_id);
    }

    for (const id of matchedJourneyIds) {
      const name = journeyNameById.get(id);
      if (name !== undefined) journeys.push({ id, name });
    }
  }

  return { campaigns, journeys };
}

export async function removeTenantDomain(tenantId: string, domainId: string): Promise<void> {
  const row = await fetchDomainById(domainId);
  if (!row || row.tenant_id !== tenantId || row.removed_at) {
    throw new Error("Domínio não encontrado");
  }

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("tenant_domains")
    .update({ removed_at: now, is_default: false })
    .eq("id", domainId);
  if (error) throw new Error(error.message);

  if (row.is_default) {
    await promoteNextDefault(tenantId, row.kind, domainId);
  }
}

export async function listTenantDomains(tenantId: string, kind?: DomainKind): Promise<TenantDomain[]> {
  const base = supabaseAdmin
    .from("tenant_domains")
    .select("*")
    .eq("tenant_id", tenantId)
    .is("removed_at", null)
    .order("created_at", { ascending: true });

  const { data, error } = await (kind ? base.eq("kind", kind) : base);
  if (error) throw new Error(error.message);
  return ((data ?? []) as DomainRow[]).map(rowToDomain);
}

/** Same as `listTenantDomains`, but also includes removed rows. Used only by
 * `getHouseConfig`'s super-admin-only "removedDomains" projection (the
 * "Apagar no provedor" action needs to see them); regular reads keep using
 * `listTenantDomains`, which never surfaces a removed domain. */
export async function listTenantDomainsIncludingRemoved(
  tenantId: string,
  kind?: DomainKind,
): Promise<TenantDomain[]> {
  const base = supabaseAdmin
    .from("tenant_domains")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });

  const { data, error } = await (kind ? base.eq("kind", kind) : base);
  if (error) throw new Error(error.message);
  return ((data ?? []) as DomainRow[]).map(rowToDomain);
}

export async function purgeTenantDomain(domainId: string): Promise<void> {
  const row = await fetchDomainById(domainId);
  if (!row) throw new Error("Domínio não encontrado");
  if (!row.removed_at) throw new Error("Remova o domínio antes de apagá-lo no provedor");
  if (isReservedHostname(row.hostname)) throw new Error(RESERVED_DOMAIN_ERROR);

  try {
    if (row.kind === "shortener") {
      if (row.provider_domain_id) {
        await deleteShortioDomain(row.provider_domain_id);
      }
    } else {
      await deleteInfobipDomain(row.hostname);
    }
  } catch (err) {
    throw new Error(toAdminProviderMessage(err, `purge ${row.kind} domain ${row.hostname}`));
  }

  const { error } = await supabaseAdmin.from("tenant_domains").delete().eq("id", domainId);
  if (error) throw new Error(error.message);
}
