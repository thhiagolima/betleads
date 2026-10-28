// Server-side data access for "Trocar domínio nos links": loads every
// hand-written-link source of a tenant (for the pure planner in
// link-domain-plan.ts) and applies an already-computed change via the
// `apply_link_domain_change` RPC (Task 3's migration). No RLS write path
// exists for these tables from here — callers must already have checked
// `requireHouseAdmin` before calling `applyLinkDomainChange`.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { LinkDomainSources } from "@/lib/link-domain-plan";

const ACTIVE_JOURNEY_STATUSES = ["draft", "active", "paused"] as const;

type JourneyRow = { id: string; name: string; status: string };
type JourneyStepRow = {
  id: string;
  journey_id: string;
  position: number;
  step_type: "sms" | "email";
  label: string | null;
  config: Record<string, unknown> | null;
};
type SmsTemplateRow = { id: string; name: string; content: string };
type EmailTemplateRow = {
  id: string;
  name: string;
  subject: string;
  preheader: string | null;
  body_html: string;
  body_text: string;
};
type QuickLinkRow = { id: string; label: string; path: string };
type SmsCampaignRow = { id: string; name: string; content: string };
type EmailCampaignRow = { id: string; name: string; template_snapshot: Record<string, unknown> | null };
type SmsFlowRow = { id: string; name: string };
type SmsFlowStepRow = { flow_id: string; content: string | null };

export async function loadLinkDomainSources(tenantId: string): Promise<LinkDomainSources> {
  const [
    journeysRes,
    smsTemplatesRes,
    emailTemplatesRes,
    quickLinksRes,
    trackingRes,
    smsCampaignsRes,
    emailCampaignsRes,
    smsFlowsRes,
  ] = await Promise.all([
    supabaseAdmin
      .from("journeys")
      .select("id,name,status")
      .eq("tenant_id", tenantId)
      .in("status", ACTIVE_JOURNEY_STATUSES),
    supabaseAdmin
      .from("sms_templates")
      .select("id,name,content")
      .eq("tenant_id", tenantId)
      .eq("is_active", true),
    supabaseAdmin
      .from("email_templates")
      .select("id,name,subject,preheader,body_html,body_text")
      .eq("tenant_id", tenantId)
      .neq("lifecycle_status", "archived"),
    supabaseAdmin.from("tenant_quick_links").select("id,label,path").eq("tenant_id", tenantId),
    supabaseAdmin
      .from("shortio_settings")
      .select("allowed_destination_hosts")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabaseAdmin
      .from("sms_campaigns")
      .select("id,name,content")
      .eq("tenant_id", tenantId)
      .eq("status", "agendada"),
    supabaseAdmin
      .from("email_campaigns")
      .select("id,name,template_snapshot")
      .eq("tenant_id", tenantId)
      .eq("status", "agendada"),
    supabaseAdmin.from("sms_flows").select("id,name").eq("tenant_id", tenantId).eq("is_active", true),
  ]);

  if (journeysRes.error) throw new Error(journeysRes.error.message);
  if (smsTemplatesRes.error) throw new Error(smsTemplatesRes.error.message);
  if (emailTemplatesRes.error) throw new Error(emailTemplatesRes.error.message);
  if (quickLinksRes.error) throw new Error(quickLinksRes.error.message);
  if (trackingRes.error) throw new Error(trackingRes.error.message);
  if (smsCampaignsRes.error) throw new Error(smsCampaignsRes.error.message);
  if (emailCampaignsRes.error) throw new Error(emailCampaignsRes.error.message);
  if (smsFlowsRes.error) throw new Error(smsFlowsRes.error.message);

  const journeys = (journeysRes.data ?? []) as JourneyRow[];
  const journeyById = new Map(journeys.map((j) => [j.id, j]));

  let journeySteps: LinkDomainSources["journeySteps"] = [];
  if (journeys.length > 0) {
    const { data: stepRows, error: stepsErr } = await supabaseAdmin
      .from("journey_steps")
      .select("id,journey_id,position,step_type,label,config")
      .eq("tenant_id", tenantId)
      .in("journey_id", Array.from(journeyById.keys()))
      .in("step_type", ["sms", "email"]);
    if (stepsErr) throw new Error(stepsErr.message);

    journeySteps = ((stepRows ?? []) as JourneyStepRow[])
      .map((step) => {
        const journey = journeyById.get(step.journey_id);
        if (!journey) return null;
        return {
          id: step.id,
          journeyId: step.journey_id,
          journeyName: journey.name,
          journeyStatus: journey.status,
          position: step.position,
          stepType: step.step_type,
          label: step.label,
          config: step.config ?? {},
        };
      })
      .filter((s): s is LinkDomainSources["journeySteps"][number] => s !== null);
  }

  const smsTemplates = ((smsTemplatesRes.data ?? []) as SmsTemplateRow[]).map((t) => ({
    id: t.id,
    name: t.name,
    content: t.content,
  }));

  const emailTemplates = ((emailTemplatesRes.data ?? []) as EmailTemplateRow[]).map((t) => ({
    id: t.id,
    name: t.name,
    subject: t.subject,
    preheader: t.preheader,
    body_html: t.body_html,
    body_text: t.body_text,
  }));

  const quickLinks = ((quickLinksRes.data ?? []) as QuickLinkRow[]).map((q) => ({
    id: q.id,
    label: q.label,
    path: q.path,
  }));

  const trackingRow = trackingRes.data as { allowed_destination_hosts: string[] } | null;
  const trackingHosts = trackingRow ? trackingRow.allowed_destination_hosts ?? [] : null;

  const scheduledSmsCampaigns = ((smsCampaignsRes.data ?? []) as SmsCampaignRow[]).map((c) => ({
    id: c.id,
    name: c.name,
    channel: "sms" as const,
    text: c.content,
  }));
  const scheduledEmailCampaigns = ((emailCampaignsRes.data ?? []) as EmailCampaignRow[]).map((c) => ({
    id: c.id,
    name: c.name,
    channel: "email" as const,
    text: typeof c.template_snapshot?.body_html === "string" ? (c.template_snapshot.body_html as string) : "",
  }));
  const scheduledCampaigns = [...scheduledSmsCampaigns, ...scheduledEmailCampaigns];

  const smsFlows = (smsFlowsRes.data ?? []) as SmsFlowRow[];
  let activeLegacyFlows: LinkDomainSources["activeLegacyFlows"] = [];
  if (smsFlows.length > 0) {
    const { data: flowStepRows, error: flowStepsErr } = await supabaseAdmin
      .from("sms_flow_steps")
      .select("flow_id,content")
      .eq("tenant_id", tenantId)
      .in(
        "flow_id",
        smsFlows.map((f) => f.id),
      );
    if (flowStepsErr) throw new Error(flowStepsErr.message);

    const textByFlow = new Map<string, string[]>();
    for (const step of (flowStepRows ?? []) as SmsFlowStepRow[]) {
      if (!step.content) continue;
      const list = textByFlow.get(step.flow_id) ?? [];
      list.push(step.content);
      textByFlow.set(step.flow_id, list);
    }
    activeLegacyFlows = smsFlows.map((flow) => ({
      id: flow.id,
      name: flow.name,
      text: (textByFlow.get(flow.id) ?? []).join("\n"),
    }));
  }

  return {
    journeySteps,
    smsTemplates,
    emailTemplates,
    quickLinks,
    trackingHosts,
    scheduledCampaigns,
    activeLegacyFlows,
  };
}

export type ApplyLinkDomainResult = {
  journey_steps: number;
  sms_templates: number;
  email_templates: number;
  quick_links: number;
  tracking_hosts: boolean;
};

const ITEM_NOT_FOUND_MESSAGE = "Algum item não foi encontrado nesta casa. Abra a prévia de novo.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the RPC isn't in the generated Supabase types, same pattern as shortio.server.ts / meta.functions.ts.
export async function applyLinkDomainChangeRpc(
  tenantId: string,
  actorId: string,
  payload: Record<string, unknown>,
): Promise<ApplyLinkDomainResult> {
  const { data, error } = await (supabaseAdmin as any).rpc("apply_link_domain_change", {
    _tenant: tenantId,
    _actor: actorId,
    _payload: payload,
  });
  if (error) {
    if (error.message?.includes("link_domain_item_not_found")) {
      throw new Error(ITEM_NOT_FOUND_MESSAGE);
    }
    throw new Error(error.message);
  }
  return data as ApplyLinkDomainResult;
}
