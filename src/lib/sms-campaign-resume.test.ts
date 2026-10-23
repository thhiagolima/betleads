// PG3 final fix I3 — "Retomar" on an SMS campaign paused for lack of balance.
import { describe, expect, it } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";
import { resumePausedSmsCampaign } from "./sms-campaign-dispatch.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function seed(status: string, tenantId = TENANT) {
  const db = createFakeDb();
  db.rows("sms_campaigns").push({
    id: "camp-1",
    tenant_id: tenantId,
    status,
    sent_cursor: 3,
    last_error: "Saldo insuficiente",
    locked_at: null,
    locked_by: null,
  });
  return db;
}

describe("resumePausedSmsCampaign", () => {
  it("puts a paused campaign back in the queue, keeping its cursor", async () => {
    const db = seed("pausada");
    const ok = await resumePausedSmsCampaign(db.client, { tenantId: TENANT, campaignId: "camp-1" });
    expect(ok).toBe(true);
    expect(db.rows("sms_campaigns")[0]).toMatchObject({
      status: "enviando",
      sent_cursor: 3,
      last_error: null,
      locked_at: null,
      locked_by: null,
    });
  });

  it("never touches a campaign that is not paused", async () => {
    const db = seed("enviado");
    const ok = await resumePausedSmsCampaign(db.client, { tenantId: TENANT, campaignId: "camp-1" });
    expect(ok).toBe(false);
    expect(db.rows("sms_campaigns")[0]).toMatchObject({ status: "enviado" });
  });

  it("never touches another house's campaign", async () => {
    const db = seed("pausada", OTHER);
    const ok = await resumePausedSmsCampaign(db.client, { tenantId: TENANT, campaignId: "camp-1" });
    expect(ok).toBe(false);
    expect(db.rows("sms_campaigns")[0]).toMatchObject({ status: "pausada" });
  });
});
