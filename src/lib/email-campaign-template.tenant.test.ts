// F0-04 — runCampaignSend (service role) must not load a template of another
// tenant, even if the campaign row points at its id.

import { describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const run = () => (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const builder: any = {
      select: () => builder,
      update: () => builder,
      insert: () => builder,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve, reject),
    };
    return builder;
  }
  return { supabaseAdmin: { from } };
});
// The demo send guard has its own coverage (demo-send-guard.channels.test.ts).
vi.mock("./tenant-access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tenant-access.server")>()),
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
}));
vi.mock("./email-send.server", () => ({
  resolveSender: vi.fn(async () => ({ fromEmail: "a@a.com", fromName: "A", replyTo: null })),
  sendInfobipEmail: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
}));

import { runCampaignSend } from "./email.functions";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

describe("runCampaignSend template lookup", () => {
  it("refuses a template that belongs to another tenant", async () => {
    state.tables = {
      email_campaigns: [
        {
          id: "camp-a",
          tenant_id: A,
          template_id: "tpl-b",
          template_snapshot: null,
          audience_filter: { audience_mode: "emails", extra_emails: ["x@x.com"] },
        },
      ],
      email_templates: [
        { id: "tpl-b", tenant_id: B, lifecycle_status: "published", subject: "B", body_html: "B" },
      ],
    };
    await expect(runCampaignSend("camp-a")).rejects.toThrow("Template da campanha não encontrado");
  });
});
