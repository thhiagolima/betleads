// Server functions for "Trocar domínio nos links": loads the tenant's
// sources, runs the pure planner (link-domain-plan.ts) for a preview, and
// applies a selected subset through the `apply_link_domain_change` RPC.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireHouseAdmin } from "@/lib/house-config.functions";
import { invalidateHouseLinks } from "@/lib/house-links.server";
import { planLinkDomainChange, type ClientLinkDomainPreview, type LinkDomainPreview } from "@/lib/link-domain-plan";
import { applyLinkDomainChangeRpc, loadLinkDomainSources, type ApplyLinkDomainResult } from "@/lib/link-domain.server";

// The preview's `update`/`previous` fields hold the full new/old
// config/template content (the whole email HTML, twice, per item) — useful
// for `buildApplyPayload` below, but the client only renders
// key/kind/id/title/detail/replacements/sample/blockedReason/segmentWarning.
// `stripClientFields` drops `update`/`previous` before the preview crosses
// the wire, so `previewLinkDomainChange` never sends that weight to the
// browser; `applyLinkDomainChange` recomputes the full preview server-side
// from `itemKeys`, so nothing else needs them back.
function stripClientFields(preview: LinkDomainPreview): ClientLinkDomainPreview {
  return {
    ...preview,
    items: preview.items.map(({ update, previous, ...rest }) => rest),
  };
}

// ============ Pure helpers (exported for unit tests) ============

export type ApplyPayload = {
  journey_steps: { id: string; config: unknown }[];
  sms_templates: { id: string; content: unknown }[];
  email_templates: { id: string; subject: unknown; preheader: unknown; body_html: unknown; body_text: unknown }[];
  quick_links: { id: string; path: unknown }[];
  tracking_hosts: string[] | null;
  from: string;
  to: string;
  audit_before: Record<string, Record<string, unknown>>;
  audit_after: Record<string, Record<string, unknown>>;
};

const BLOCKED_SELECTED_MESSAGE =
  "Algum item mudou desde a prévia e não cabe mais. Abra a prévia de novo.";
const NOTHING_SELECTED_MESSAGE = "Nada selecionado para trocar.";

/** Pure: builds the RPC's `_payload` from a preview and the subset of item
 * keys the caller selected. Throws (pt-BR) if a selected item is now
 * blocked, or if nothing was selected and there's no tracking-hosts change
 * either. `includeTrackingHosts` opts into writing `trackingHosts.next`;
 * omitting it (or no tracking change in the preview) keeps `tracking_hosts`
 * as `null`, which the RPC reads as "don't touch". */
export function buildApplyPayload(
  preview: LinkDomainPreview,
  itemKeys: string[],
  includeTrackingHosts: boolean,
): ApplyPayload {
  const selectedKeys = new Set(itemKeys);
  const selectedItems = preview.items.filter((item) => selectedKeys.has(item.key));

  // A selected key that isn't in the recomputed preview means the item
  // changed (or disappeared) since the client last fetched it — e.g. it was
  // edited, deleted, or no longer matches `from`/`to`. Silently dropping it
  // would apply a smaller change than the one the person confirmed, so this
  // fails the same way a now-blocked item does.
  if (selectedItems.length !== selectedKeys.size) {
    throw new Error(BLOCKED_SELECTED_MESSAGE);
  }

  const blocked = selectedItems.find((item) => item.blockedReason !== null);
  if (blocked) {
    throw new Error(BLOCKED_SELECTED_MESSAGE);
  }

  const trackingHosts =
    includeTrackingHosts && preview.trackingHosts !== null ? preview.trackingHosts.next : null;

  if (selectedItems.length === 0 && trackingHosts === null) {
    throw new Error(NOTHING_SELECTED_MESSAGE);
  }

  const journey_steps: ApplyPayload["journey_steps"] = [];
  const sms_templates: ApplyPayload["sms_templates"] = [];
  const email_templates: ApplyPayload["email_templates"] = [];
  const quick_links: ApplyPayload["quick_links"] = [];
  const audit_before: ApplyPayload["audit_before"] = {};
  const audit_after: ApplyPayload["audit_after"] = {};

  for (const item of selectedItems) {
    audit_before[item.key] = item.previous;
    audit_after[item.key] = item.update;

    switch (item.kind) {
      case "journey_step":
        journey_steps.push({ id: item.id, config: item.update.config });
        break;
      case "sms_template":
        sms_templates.push({ id: item.id, content: item.update.content });
        break;
      case "email_template":
        email_templates.push({
          id: item.id,
          subject: item.update.subject,
          preheader: item.update.preheader,
          body_html: item.update.body_html,
          body_text: item.update.body_text,
        });
        break;
      case "quick_link":
        quick_links.push({ id: item.id, path: item.update.path });
        break;
    }
  }

  return {
    journey_steps,
    sms_templates,
    email_templates,
    quick_links,
    tracking_hosts: trackingHosts,
    from: preview.from,
    to: preview.to,
    audit_before,
    audit_after,
  };
}

// ============ Server functions ============

const previewInput = z.object({
  fromDomain: z.string().min(1).max(500),
  toDomain: z.string().min(1).max(500),
});

export const previewLinkDomainChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => previewInput.parse(v))
  .handler(async ({ data, context }): Promise<ClientLinkDomainPreview> => {
    const tenantId = await requireHouseAdmin(context);
    const sources = await loadLinkDomainSources(tenantId);
    const result = planLinkDomainChange(sources, data.fromDomain, data.toDomain);
    if (!result.ok) throw new Error(result.error);
    return stripClientFields(result.preview);
  });

const applyInput = z.object({
  fromDomain: z.string().min(1).max(500),
  toDomain: z.string().min(1).max(500),
  itemKeys: z.array(z.string()).max(2000),
  includeTrackingHosts: z.boolean(),
});

export const applyLinkDomainChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => applyInput.parse(v))
  .handler(async ({ data, context }): Promise<ApplyLinkDomainResult> => {
    const tenantId = await requireHouseAdmin(context);
    const sources = await loadLinkDomainSources(tenantId);
    const result = planLinkDomainChange(sources, data.fromDomain, data.toDomain);
    if (!result.ok) throw new Error(result.error);

    const payload = buildApplyPayload(result.preview, data.itemKeys, data.includeTrackingHosts);
    const counts = await applyLinkDomainChangeRpc(tenantId, context.userId, payload);
    invalidateHouseLinks(tenantId);
    return counts;
  });
