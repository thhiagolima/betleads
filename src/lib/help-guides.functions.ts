// Server function behind the help panel's "Guias passo a passo" progress
// (brief, Task 6). Follows house-config.functions.ts's pattern: GET only,
// `requireSupabaseAuth` + `resolveOperationalTenantId`, counts via
// `{ count: "exact", head: true }`/`.limit(1)` — no row contents are needed,
// only whether something exists.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveOperationalTenantId } from "@/lib/tenant-access.server";
import { computeHasVerifiedSender } from "@/lib/house-config";
import { fetchSenders } from "@/lib/house-config.functions";
import { listTenantDomains } from "@/lib/tenant-domains.server";
import type { GuideSignals } from "@/help/guides";

async function hasPublishedEmailTemplate(tenantId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("email_templates")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("lifecycle_status", "published");
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

async function hasSentEmailCampaign(tenantId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("email_campaigns")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .in("status", ["agendada", "enviando", "concluida"]);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

async function hasSavedJourney(tenantId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("journeys")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .neq("status", "archived");
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

async function hasActiveJourney(tenantId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("journeys")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

async function hasJourneyEnrollment(tenantId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("journey_enrollments")
    .select("id")
    .eq("tenant_id", tenantId)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export const getGuideSignals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);

    const [
      shortenerDomains,
      emailDomains,
      senders,
      publishedEmailTemplate,
      emailCampaignSent,
      journeySaved,
      journeyActive,
      journeyHasEntries,
    ] = await Promise.all([
      listTenantDomains(tenantId, "shortener"),
      listTenantDomains(tenantId, "email"),
      fetchSenders(tenantId),
      hasPublishedEmailTemplate(tenantId),
      hasSentEmailCampaign(tenantId),
      hasSavedJourney(tenantId),
      hasActiveJourney(tenantId),
      hasJourneyEnrollment(tenantId),
    ]);

    const verifiedEmailDomainIds = new Set(
      emailDomains.filter((d) => d.status === "verified").map((d) => d.id),
    );

    const signals: GuideSignals = {
      shortenerAdded: shortenerDomains.length > 0,
      shortenerVerified: shortenerDomains.some((d) => d.status === "verified"),
      shortenerDefault: shortenerDomains.some((d) => d.is_default),
      emailDomainAdded: emailDomains.length > 0,
      emailDomainVerified: verifiedEmailDomainIds.size > 0,
      verifiedSender: computeHasVerifiedSender(senders, verifiedEmailDomainIds),
      publishedEmailTemplate,
      emailCampaignSent,
      journeySaved,
      journeyActive,
      journeyHasEntries,
    };

    return { signals };
  });
