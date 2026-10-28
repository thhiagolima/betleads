// link-domain.functions (Task 4): unit tests for the pure, exported helper
// only. The createServerFn handlers themselves wrap Supabase and are covered
// by integration/manual verification, not unit tests here (see
// house-config.functions.test.ts's header for the same convention).
import { describe, expect, it } from "vitest";
import { buildApplyPayload } from "./link-domain.functions";
import type { LinkDomainItem, LinkDomainPreview } from "./link-domain-plan";

function item(overrides: Partial<LinkDomainItem> & { key: string }): LinkDomainItem {
  return {
    kind: "sms_template",
    id: overrides.key.split(":")[1] ?? "id",
    title: "Template",
    detail: null,
    replacements: 1,
    sample: { before: "https://casa-antiga.com/x", after: "https://casa-nova.com/x" },
    blockedReason: null,
    segmentWarning: null,
    update: { content: "https://casa-nova.com/x" },
    previous: { content: "https://casa-antiga.com/x" },
    ...overrides,
  };
}

function preview(overrides: Partial<LinkDomainPreview> = {}): LinkDomainPreview {
  return {
    from: "casa-antiga.com",
    to: "casa-nova.com",
    items: [],
    trackingHosts: null,
    outOfScope: { scheduledCampaigns: [], legacyFlows: [], subdomainLinks: 0 },
    ...overrides,
  };
}

describe("buildApplyPayload", () => {
  it("só inclui itens selecionados, agrupados por tabela", () => {
    const p = preview({
      items: [
        item({ key: "journey_step:j1", kind: "journey_step", id: "j1", update: { config: { a: 1 } } }),
        item({ key: "sms_template:s1", kind: "sms_template", id: "s1", update: { content: "x" } }),
        item({
          key: "email_template:e1",
          kind: "email_template",
          id: "e1",
          update: { subject: "s", preheader: null, body_html: "h", body_text: "t" },
        }),
        item({ key: "quick_link:q1", kind: "quick_link", id: "q1", update: { path: "/p" } }),
        // not selected — must be excluded
        item({ key: "sms_template:s2", kind: "sms_template", id: "s2", update: { content: "y" } }),
      ],
    });

    const payload = buildApplyPayload(p, ["journey_step:j1", "sms_template:s1", "email_template:e1", "quick_link:q1"], false);

    expect(payload.journey_steps).toEqual([{ id: "j1", config: { a: 1 } }]);
    expect(payload.sms_templates).toEqual([{ id: "s1", content: "x" }]);
    expect(payload.email_templates).toEqual([
      { id: "e1", subject: "s", preheader: null, body_html: "h", body_text: "t" },
    ]);
    expect(payload.quick_links).toEqual([{ id: "q1", path: "/p" }]);
  });

  it("tracking_hosts = next quando includeTrackingHosts e há mudança; senão null", () => {
    const p = preview({ trackingHosts: { current: ["casa-antiga.com"], next: ["casa-antiga.com", "casa-nova.com"] } });

    const withTracking = buildApplyPayload(p, [], true);
    expect(withTracking.tracking_hosts).toEqual(["casa-antiga.com", "casa-nova.com"]);

    // includeTrackingHosts=false with no items selected has nothing to do,
    // so it's covered by the "nothing selected" error instead of a no-op.
    const pWithItem = preview({
      trackingHosts: { current: ["casa-antiga.com"], next: ["casa-antiga.com", "casa-nova.com"] },
      items: [item({ key: "sms_template:s1", kind: "sms_template", id: "s1" })],
    });
    const withoutFlag = buildApplyPayload(pWithItem, ["sms_template:s1"], false);
    expect(withoutFlag.tracking_hosts).toBeNull();

    // trackingHosts === null in the preview (nothing to change there) stays
    // null in the payload even with includeTrackingHosts and an item selected.
    const noChange = buildApplyPayload(
      preview({ trackingHosts: null, items: [item({ key: "sms_template:s1", kind: "sms_template", id: "s1" })] }),
      ["sms_template:s1"],
      true,
    );
    expect(noChange.tracking_hosts).toBeNull();
  });

  it("audit_before/after usam a key do item", () => {
    const p = preview({
      items: [
        item({
          key: "sms_template:s1",
          kind: "sms_template",
          id: "s1",
          update: { content: "new" },
          previous: { content: "old" },
        }),
      ],
    });

    const payload = buildApplyPayload(p, ["sms_template:s1"], false);
    expect(payload.audit_before).toEqual({ "sms_template:s1": { content: "old" } });
    expect(payload.audit_after).toEqual({ "sms_template:s1": { content: "new" } });
  });

  it("lança erro em pt-BR quando um item selecionado está bloqueado", () => {
    const p = preview({
      items: [item({ key: "sms_template:s1", kind: "sms_template", id: "s1", blockedReason: "Passaria do limite." })],
    });

    expect(() => buildApplyPayload(p, ["sms_template:s1"], false)).toThrow(
      "Algum item mudou desde a prévia e não cabe mais. Abra a prévia de novo.",
    );
  });

  it("lança erro em pt-BR quando nada foi selecionado e não há rastreio", () => {
    expect(() => buildApplyPayload(preview(), [], false)).toThrow("Nada selecionado para trocar.");
  });

  it("não lança 'nada selecionado' quando há apenas rastreio a atualizar", () => {
    const p = preview({ trackingHosts: { current: ["casa-antiga.com"], next: ["casa-antiga.com", "casa-nova.com"] } });
    expect(() => buildApplyPayload(p, [], true)).not.toThrow();
  });
});
