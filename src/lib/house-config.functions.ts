// Server functions for the house onboarding/configuration screen: site URL,
// quick links, shortener/email domains, email senders and the setup wizard
// state. Reads are open to any tenant member; writes require a tenant admin
// and a non-demo tenant (assertTenantNotDemo), and go through supabaseAdmin
// once that check has passed (RLS on the new tables is SELECT-only).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dbUuid } from "@/lib/zod-helpers";
import { assertSuperAdmin } from "@/lib/provider-governance.server";
import {
  assertTenantNotDemo,
  requireTenantAdmin,
  resolveOperationalTenantId,
} from "@/lib/tenant-access.server";
import {
  buildQuickLinkUrl,
  computeSetupChecklist,
  normalizeSiteUrl,
  planQuickLinksSave,
  type DomainKind,
  type DomainStatus,
} from "@/lib/house-config";
import {
  addTenantDomain,
  findDomainUsages,
  listTenantDomains,
  listTenantDomainsIncludingRemoved,
  purgeTenantDomain,
  refreshTenantDomain,
  removeTenantDomain,
  setDefaultTenantDomain,
  type TenantDomain,
} from "@/lib/tenant-domains.server";
import { renderDnsInstructionsEmail, sendPlatformEmail } from "@/lib/platform-email.server";
import { invalidateHouseLinks } from "@/lib/house-links.server";

// ============ Pure helpers (exported for unit tests) ============

/** Throws unless `row` exists and belongs to `tenantId`. Never leaks whether
 * the row exists for a different tenant — the message is the same either
 * way. Does NOT reject a removed domain — `purgeHouseDomain` operates on
 * already-removed rows by design; use `ensureActiveDomainOwnership` for every
 * other action. */
export function ensureDomainOwnership(
  row: { tenant_id: string } | null,
  tenantId: string,
): void {
  if (!row || row.tenant_id !== tenantId) {
    throw new Error("Domínio não encontrado");
  }
}

/** Same as `ensureDomainOwnership`, plus: a removed domain is treated as not
 * found. Used by every action except `purgeHouseDomain`. */
export function ensureActiveDomainOwnership(
  row: { tenant_id: string; removed_at: string | null } | null,
  tenantId: string,
): void {
  if (!row || row.tenant_id !== tenantId || row.removed_at !== null) {
    throw new Error("Domínio não encontrado");
  }
}

export function ensureSenderOwnership(
  row: { tenant_id: string } | null,
  tenantId: string,
): void {
  if (!row || row.tenant_id !== tenantId) {
    throw new Error("Remetente não encontrado");
  }
}

export function formatSenderLabel(fromName: string, fromEmail: string): string {
  return `${fromName} <${fromEmail}>`;
}

export type DomainStatusRow = { status: DomainStatus; removed_at: string | null };

/** A domain counts as verified only while it's active — a removed domain,
 * however its `status` column still reads, is never "verified" again. */
export function isDomainVerified(domain: DomainStatusRow | undefined | null): boolean {
  return !!domain && domain.status === "verified" && domain.removed_at === null;
}

export type SenderForProjection = {
  id: string;
  from_name: string | null;
  from_email: string;
  reply_to: string | null;
  domain_id: string | null;
  is_default: boolean;
};

/** `getHouseConfig`'s `senders` projection: every sender, each flagged with
 * whether its domain is currently verified (never true for a removed
 * domain). */
export function projectHouseConfigSenders(
  senders: SenderForProjection[],
  domainById: Map<string, DomainStatusRow>,
): {
  id: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  domainId: string | null;
  isDefault: boolean;
  domainVerified: boolean;
}[] {
  return senders.map((s) => ({
    id: s.id,
    fromName: s.from_name ?? "",
    fromEmail: s.from_email,
    replyTo: s.reply_to,
    domainId: s.domain_id,
    isDefault: s.is_default,
    domainVerified: s.domain_id ? isDomainVerified(domainById.get(s.domain_id)) : false,
  }));
}

/** `getComposerOptions`'s `senders`: only senders whose domain is currently
 * verified (a removed domain disqualifies it, even if `status` still reads
 * "verified"). */
export function selectComposerSenders(
  senders: SenderForProjection[],
  domainById: Map<string, DomainStatusRow>,
): { id: string; label: string; isDefault: boolean }[] {
  return senders
    .filter((s) => s.domain_id !== null && isDomainVerified(domainById.get(s.domain_id)))
    .map((s) => ({
      id: s.id,
      label: formatSenderLabel(s.from_name ?? "", s.from_email),
      isDefault: s.is_default,
    }));
}

/** `getHouseConfig`'s `removedDomains` projection: only super admins get to see
 * removed domains at all (that's who can purge them at the provider via
 * `purgeHouseDomain`) — everyone else gets an empty array, regardless of
 * what's actually in `allDomains`. */
export function selectRemovedDomainsForSuperAdmin(
  allDomains: TenantDomain[],
  isSuperAdmin: boolean,
): TenantDomain[] {
  if (!isSuperAdmin) return [];
  return allDomains.filter((d) => d.removed_at !== null);
}

/** A tenant's custom shortener domain exists but none of it is verified yet —
 * links are currently going out through the CRM's default shortener. */
export function computeShortenerPending(statuses: DomainStatus[]): boolean {
  const hasVerified = statuses.includes("verified");
  const hasPendingOrFailed = statuses.some((s) => s === "pending" || s === "failed");
  return hasPendingOrFailed && !hasVerified;
}

export type NoticeDomainRow = {
  id: string;
  hostname: string;
  kind: DomainKind;
  status: DomainStatus;
  verified_at: string | null;
  verified_notice_seen_at: string | null;
};

/** Domains that just turned verified and whose notice hasn't been shown yet. */
export function selectNewlyVerifiedDomains(
  rows: NoticeDomainRow[],
): { id: string; hostname: string; kind: DomainKind }[] {
  return rows
    .filter((r) => r.status === "verified" && r.verified_at !== null && r.verified_notice_seen_at === null)
    .map((r) => ({ id: r.id, hostname: r.hostname, kind: r.kind }));
}

export function computeShowWizard(input: {
  isAdmin: boolean;
  isSuperAdmin: boolean;
  onboardingCompletedAt: string | null;
  onboardingSkippedAt: string | null;
}): boolean {
  return (
    input.isAdmin &&
    !input.isSuperAdmin &&
    !input.onboardingCompletedAt &&
    !input.onboardingSkippedAt
  );
}

const DNS_SEND_WINDOW_MS = 60 * 60 * 1000;
const DNS_SEND_MAX_PER_WINDOW = 5;

/**
 * Pure rate-limit check over an injected log (domainId -> send timestamps in
 * ms). Returns true once `domainId` already has `DNS_SEND_MAX_PER_WINDOW`
 * sends inside the rolling hour. Read-only (also prunes expired entries from
 * `log` so it doesn't grow forever) — it never records a new attempt; call
 * `recordDnsSend` for that, and only once the send actually succeeded.
 */
export function isDnsSendRateLimited(
  log: Map<string, number[]>,
  domainId: string,
  now: number,
): boolean {
  const entries = (log.get(domainId) ?? []).filter((t) => now - t < DNS_SEND_WINDOW_MS);
  log.set(domainId, entries);
  return entries.length >= DNS_SEND_MAX_PER_WINDOW;
}

/** Records one DNS-instructions send for `domainId` at `now`. Call only
 * after the send has actually succeeded, so a failed send doesn't eat into
 * the tenant's rate-limit budget. */
export function recordDnsSend(log: Map<string, number[]>, domainId: string, now: number): void {
  const entries = (log.get(domainId) ?? []).filter((t) => now - t < DNS_SEND_WINDOW_MS);
  entries.push(now);
  log.set(domainId, entries);
}

// Module-level log backing the real `sendDnsInstructions` server function.
const dnsSendLog = new Map<string, number[]>();

// ============ Internal (non-exported) DB helpers ============

type TenantRow = {
  nome: string;
  site_url: string | null;
  onboarding_completed_at: string | null;
  onboarding_skipped_at: string | null;
};

async function fetchTenantRow(tenantId: string): Promise<TenantRow> {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("nome,site_url,onboarding_completed_at,onboarding_skipped_at")
    .eq("id", tenantId)
    .single();
  if (error) throw new Error(error.message);
  return data as TenantRow;
}

type QuickLinkRow = { id: string; key: string; label: string; path: string; position: number };

async function fetchQuickLinks(tenantId: string): Promise<QuickLinkRow[]> {
  const { data, error } = await supabaseAdmin
    .from("tenant_quick_links")
    .select("id,key,label,path,position")
    .eq("tenant_id", tenantId)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as QuickLinkRow[];
}

type SenderRow = {
  id: string;
  from_name: string | null;
  from_email: string;
  reply_to: string | null;
  domain_id: string | null;
  is_default: boolean;
  tenant_id: string;
};

async function fetchSenders(tenantId: string): Promise<SenderRow[]> {
  const { data, error } = await supabaseAdmin
    .from("email_senders")
    .select("id,from_name,from_email,reply_to,domain_id,is_default,tenant_id")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as SenderRow[];
}

async function fetchDomainStatusById(domainIds: string[]): Promise<Map<string, DomainStatusRow>> {
  const map = new Map<string, DomainStatusRow>();
  if (domainIds.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("tenant_domains")
    .select("id,status,removed_at")
    .in("id", domainIds);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as { id: string; status: DomainStatus; removed_at: string | null }[]) {
    map.set(row.id, { status: row.status, removed_at: row.removed_at });
  }
  return map;
}

type DomainIdentityRow = {
  id: string;
  tenant_id: string;
  kind: DomainKind;
  hostname: string;
  removed_at: string | null;
};

async function fetchDomainIdentity(domainId: string): Promise<DomainIdentityRow | null> {
  const { data, error } = await supabaseAdmin
    .from("tenant_domains")
    .select("id,tenant_id,kind,hostname,removed_at")
    .eq("id", domainId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DomainIdentityRow | null) ?? null;
}

async function fetchDomainFull(domainId: string): Promise<(DomainIdentityRow & { dns_records: unknown }) | null> {
  const { data, error } = await supabaseAdmin
    .from("tenant_domains")
    .select("id,tenant_id,kind,hostname,removed_at,dns_records")
    .eq("id", domainId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as (DomainIdentityRow & { dns_records: unknown }) | null;
}

async function fetchNoticeRows(tenantId: string): Promise<NoticeDomainRow[]> {
  const { data, error } = await supabaseAdmin
    .from("tenant_domains")
    .select("id,hostname,kind,status,verified_at,verified_notice_seen_at")
    .eq("tenant_id", tenantId)
    .is("removed_at", null);
  if (error) throw new Error(error.message);
  return (data ?? []) as NoticeDomainRow[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural RPC boundary, same pattern as tenant-access.server.ts's RpcClient.
async function checkTenantAdmin(supabase: any, tenantId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_tenant_admin", { _tenant: tenantId });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural RPC boundary, same pattern as tenant-access.server.ts's RpcClient.
async function checkSuperAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

// ============ Reads ============

export const getHouseConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);

    const [tenant, quickLinkRows, allDomains, senderRows, canEdit, isSuperAdmin] = await Promise.all([
      fetchTenantRow(tenantId),
      fetchQuickLinks(tenantId),
      listTenantDomainsIncludingRemoved(tenantId),
      fetchSenders(tenantId),
      checkTenantAdmin(context.supabase, tenantId),
      checkSuperAdmin(context.supabase, context.userId),
    ]);

    const domains = allDomains.filter((d) => d.removed_at === null);
    const removedDomains = selectRemovedDomainsForSuperAdmin(allDomains, isSuperAdmin);

    const domainIds = Array.from(
      new Set(senderRows.map((s) => s.domain_id).filter((id): id is string => Boolean(id))),
    );
    const statusById = await fetchDomainStatusById(domainIds);

    const siteUrl = tenant.site_url;
    const quickLinks = quickLinkRows.map((l) => ({
      id: l.id,
      key: l.key,
      label: l.label,
      path: l.path,
      url: siteUrl ? buildQuickLinkUrl(siteUrl, l.path) : l.path,
    }));

    const senders = projectHouseConfigSenders(senderRows, statusById);

    return {
      tenantName: tenant.nome,
      siteUrl,
      quickLinks,
      domains,
      removedDomains,
      senders,
      canEdit,
      onboarding: {
        completedAt: tenant.onboarding_completed_at,
        skippedAt: tenant.onboarding_skipped_at,
      },
    };
  });

export const getHouseSetupStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);

    const [tenant, domains, senderRows, isAdmin, isSuperAdmin, noticeRows] = await Promise.all([
      fetchTenantRow(tenantId),
      listTenantDomains(tenantId),
      fetchSenders(tenantId),
      checkTenantAdmin(context.supabase, tenantId),
      checkSuperAdmin(context.supabase, context.userId),
      fetchNoticeRows(tenantId),
    ]);

    const shortenerStatuses = domains.filter((d) => d.kind === "shortener").map((d) => d.status);
    const emailDomains = domains.filter((d) => d.kind === "email");
    const emailStatuses = emailDomains.map((d) => d.status);

    const verifiedEmailDomainIds = new Set(
      emailDomains.filter((d) => d.status === "verified").map((d) => d.id),
    );
    const hasVerifiedSender = senderRows.some(
      (s) => s.domain_id !== null && verifiedEmailDomainIds.has(s.domain_id),
    );

    const checklist = computeSetupChecklist({
      siteUrl: tenant.site_url,
      shortenerStatuses,
      emailStatuses,
      hasVerifiedSender,
    });

    const showWizard = computeShowWizard({
      isAdmin,
      isSuperAdmin,
      onboardingCompletedAt: tenant.onboarding_completed_at,
      onboardingSkippedAt: tenant.onboarding_skipped_at,
    });

    const newlyVerified = selectNewlyVerifiedDomains(noticeRows);

    return { checklist, showWizard, newlyVerified };
  });

export const getComposerOptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);

    const [tenant, quickLinkRows, shortenerDomains, senderRows] = await Promise.all([
      fetchTenantRow(tenantId),
      fetchQuickLinks(tenantId),
      listTenantDomains(tenantId, "shortener"),
      fetchSenders(tenantId),
    ]);

    const siteUrl = tenant.site_url;
    const quickLinks = quickLinkRows.map((l) => ({
      key: l.key,
      label: l.label,
      url: siteUrl ? buildQuickLinkUrl(siteUrl, l.path) : l.path,
    }));

    const shortDomains = shortenerDomains
      .filter((d) => d.status === "verified")
      .map((d) => ({ id: d.id, hostname: d.hostname, isDefault: d.is_default }));

    const shortenerPending = computeShortenerPending(shortenerDomains.map((d) => d.status));

    const domainIds = Array.from(
      new Set(senderRows.map((s) => s.domain_id).filter((id): id is string => Boolean(id))),
    );
    const statusById = await fetchDomainStatusById(domainIds);
    const senders = selectComposerSenders(senderRows, statusById);

    return { siteUrl, quickLinks, shortDomains, shortenerPending, senders };
  });

export const getHouseDomainUsages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ domainId: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    return findDomainUsages(tenantId, data.domainId);
  });

// ============ Writes: site + quick links ============

export async function requireHouseAdmin(context: { supabase: unknown; userId: string }) {
  const tenantId = await resolveOperationalTenantId(
    context.supabase as Parameters<typeof resolveOperationalTenantId>[0],
  );
  await requireTenantAdmin(
    context.supabase as Parameters<typeof requireTenantAdmin>[0],
    tenantId,
    "Apenas administradores da conta podem configurar a casa.",
  );
  await assertTenantNotDemo(tenantId);
  return tenantId;
}

export const saveHouseSite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ siteUrl: z.string().min(1).max(500) }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    const normalized = normalizeSiteUrl(data.siteUrl);
    if (!normalized.ok) throw new Error(normalized.error);

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("tenants")
      .select("site_url")
      .eq("id", tenantId)
      .single();
    if (beforeErr) throw new Error(beforeErr.message);

    const { error } = await supabaseAdmin
      .from("tenants")
      .update({ site_url: normalized.url })
      .eq("id", tenantId);
    if (error) throw new Error(error.message);

    invalidateHouseLinks(tenantId);
    return { siteUrl: normalized.url, previousSiteUrl: (before as { site_url: string | null }).site_url };
  });

const quickLinkInput = z.object({
  id: dbUuid().optional(),
  label: z.string().min(1).max(80),
  key: z.string().min(1).max(30).optional(),
  path: z.string().min(1).max(500),
});

export const saveQuickLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ links: z.array(quickLinkInput).max(50) }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);

    const { data: existingRows, error: existingErr } = await supabaseAdmin
      .from("tenant_quick_links")
      .select("id,key")
      .eq("tenant_id", tenantId);
    if (existingErr) throw new Error(existingErr.message);

    // Validate the whole set before writing anything: a bad/duplicate key
    // must never wipe the house's existing links.
    const plan = planQuickLinksSave(data.links, (existingRows ?? []) as { id: string; key: string }[]);
    if (!plan.ok) throw new Error(plan.error);

    // Applied atomically in a single Postgres function: delete-missing,
    // update-kept and insert-new all happen in one transaction, so a bad row
    // (shouldn't happen — plan already validated it) can never leave the
    // house's quick links half-written.
    const { data: savedRows, error: saveErr } = await supabaseAdmin.rpc("save_tenant_quick_links", {
      _tenant: tenantId,
      _delete_ids: plan.deleteIds,
      _updates: plan.updates.map((row) => ({
        id: row.id,
        label: row.label,
        path: row.path,
        position: row.position,
      })),
      _inserts: plan.inserts.map((row) => ({
        key: row.key,
        label: row.label,
        path: row.path,
        position: row.position,
      })),
    });
    if (saveErr) throw new Error(saveErr.message);

    return {
      ok: true,
      links: (savedRows ?? []) as { id: string; key: string; label: string; path: string }[],
    };
  });

// ============ Writes: onboarding ============

export const completeOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await requireHouseAdmin(context);
    const { error } = await supabaseAdmin
      .from("tenants")
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq("id", tenantId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const skipOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await requireHouseAdmin(context);
    const { error } = await supabaseAdmin
      .from("tenants")
      .update({ onboarding_skipped_at: new Date().toISOString() })
      .eq("id", tenantId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markVerifiedNoticeSeen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ domainIds: z.array(dbUuid()).min(1).max(50) }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    const { error } = await supabaseAdmin
      .from("tenant_domains")
      .update({ verified_notice_seen_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .in("id", data.domainIds);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============ Writes: domains ============

export const addHouseDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({ kind: z.enum(["shortener", "email"]), hostname: z.string().min(1).max(253) }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    const domain: TenantDomain = await addTenantDomain({
      tenantId,
      kind: data.kind,
      rawHostname: data.hostname,
      userId: context.userId,
    });
    return domain;
  });

export const refreshHouseDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ domainId: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    const identity = await fetchDomainIdentity(data.domainId);
    ensureActiveDomainOwnership(identity, tenantId);
    return refreshTenantDomain(data.domainId, { requestVerify: true });
  });

export const setDefaultHouseDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ domainId: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    await setDefaultTenantDomain(tenantId, data.domainId);
    return { ok: true };
  });

export const removeHouseDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ domainId: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    await removeTenantDomain(tenantId, data.domainId);
    return { ok: true };
  });

export const purgeHouseDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ domainId: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const identity = await fetchDomainIdentity(data.domainId);
    ensureDomainOwnership(identity, tenantId);
    await purgeTenantDomain(data.domainId);
    return { ok: true };
  });

const DNS_SEND_RATE_LIMIT_MESSAGE =
  "Limite de envios atingido para este domínio. Tente novamente mais tarde.";

export const sendDnsInstructions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({ domainId: dbUuid(), to: z.string().email().max(255) }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    const domain = await fetchDomainFull(data.domainId);
    ensureActiveDomainOwnership(domain, tenantId);

    if (isDnsSendRateLimited(dnsSendLog, data.domainId, Date.now())) {
      throw new Error(DNS_SEND_RATE_LIMIT_MESSAGE);
    }

    const tenant = await fetchTenantRow(tenantId);
    const { subject, html } = renderDnsInstructionsEmail({
      tenantName: tenant.nome,
      hostname: domain!.hostname,
      kind: domain!.kind,
      records: (domain!.dns_records ?? []) as Parameters<typeof renderDnsInstructionsEmail>[0]["records"],
    });

    await sendPlatformEmail({ to: data.to, subject, html });
    // Only counts against the rate limit once the send actually succeeded.
    recordDnsSend(dnsSendLog, data.domainId, Date.now());
    return { ok: true };
  });

// ============ Writes: email senders ============

const localPartRegex = /^[^@\s]+$/;

export const saveEmailSenderForHouse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z
      .object({
        id: dbUuid().optional(),
        domainId: dbUuid(),
        localPart: z.string().min(1).max(64).regex(localPartRegex, "Parte local inválida"),
        fromName: z.string().min(1).max(160),
        replyTo: z.string().email().max(255).optional().nullable(),
        isDefault: z.boolean().optional(),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);

    const domain = await fetchDomainIdentity(data.domainId);
    ensureActiveDomainOwnership(domain, tenantId);
    if (domain!.kind !== "email") {
      throw new Error("Selecione um domínio de e-mail da casa.");
    }

    if (data.id) {
      const { data: existing, error } = await supabaseAdmin
        .from("email_senders")
        .select("id,tenant_id")
        .eq("id", data.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      ensureSenderOwnership(existing, tenantId);
    }

    const fromEmail = `${data.localPart}@${domain!.hostname}`;
    if (!z.string().email().safeParse(fromEmail).success) {
      throw new Error("Não foi possível formar um e-mail de remetente válido com esse valor.");
    }
    const isDefault = data.isDefault ?? false;

    const payload = {
      tenant_id: tenantId,
      name: data.fromName,
      from_email: fromEmail,
      from_name: data.fromName,
      reply_to: data.replyTo ?? null,
      domain: domain!.hostname,
      domain_id: data.domainId,
      is_default: isDefault,
    };

    let id = data.id;
    if (id) {
      const { error } = await supabaseAdmin.from("email_senders").update(payload).eq("id", id);
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await supabaseAdmin
        .from("email_senders")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      id = created.id;
    }

    if (isDefault) {
      const { error: clearErr } = await supabaseAdmin
        .from("email_senders")
        .update({ is_default: false })
        .eq("tenant_id", tenantId)
        .neq("id", id);
      if (clearErr) throw new Error(clearErr.message);
      const { error: setErr } = await supabaseAdmin
        .from("email_senders")
        .update({ is_default: true })
        .eq("id", id);
      if (setErr) throw new Error(setErr.message);
    }

    return { id };
  });

export const removeEmailSenderForHouse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: dbUuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const tenantId = await requireHouseAdmin(context);
    const { data: existing, error } = await supabaseAdmin
      .from("email_senders")
      .select("id,tenant_id")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    ensureSenderOwnership(existing, tenantId);

    const { error: delErr } = await supabaseAdmin.from("email_senders").delete().eq("id", data.id);
    if (delErr) throw new Error(delErr.message);
    return { ok: true };
  });
