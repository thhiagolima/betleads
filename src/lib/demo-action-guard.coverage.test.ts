// Task 7 — block integration, billing, team and settings actions on demo
// tenants. Two layers:
//
// 1) A static coverage check: for every [file, function] pair listed below,
//    parse the source text, locate that function's body (the `.handler(`
//    callback for a `createServerFn` export, or the function body for a
//    plain exported function) and assert it literally calls
//    `assertTenantNotDemo(`. This catches a guard being removed or a new
//    action being added without one, without having to mock every provider.
// 2) Behavioral tests for the two paths the brief calls out explicitly:
//    `saveExternalIntegrationFor` and `addUserToTenantFor` must reject a demo
//    tenant with `DEMO_ACTION_BLOCKED` and must not write anything.
//
// Mapping notes (function no longer named/shaped exactly as in the original
// plan — current name used instead):
// - whatsapp.functions.ts: `disconnectWhatsappSession`, `renameWhatsappSession`
//   and `sendWhatsappMessage` remain inline `createServerFn` handlers (never
//   extracted to a `*For` function), so the handler body itself is checked.
// - whatsapp-admin.server.ts: `deleteWhatsappSessionFor` is the body behind
//   `deleteWhatsappSession`; `configureEvolutionWebhookFor` is the body
//   behind `configureEvolutionWebhook`.
// - tenants.functions.ts: `addUserToTenant`'s body was extracted into a new
//   exported `addUserToTenantFor(ctx, data)` (mirroring the existing
//   whatsapp.functions.ts `*For` convention) so the demo guard is directly
//   unit-testable, matching the brief's required behavioral test.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function readSource(file: string): string {
  return readFileSync(join(here, file), "utf8");
}

function matchParen(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced parens starting at ${openIndex}`);
}

function matchBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced braces starting at ${openIndex}`);
}

/** Body of `(export)? (async)? function <name>(...) { ... }`. */
function extractFunctionBody(source: string, name: string): string {
  const re = new RegExp(`\\b(?:export\\s+)?async\\s+function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (!m) throw new Error(`function ${name} not found`);
  const openParen = m.index + m[0].length - 1;
  const closeParen = matchParen(source, openParen);
  const openBrace = source.indexOf("{", closeParen + 1);
  if (openBrace === -1) throw new Error(`body of ${name} not found`);
  const closeBrace = matchBrace(source, openBrace);
  return source.slice(openBrace, closeBrace + 1);
}

/** Body of the `.handler(async (...) => { ... })` callback of a createServerFn export. */
function extractHandlerBody(source: string, constName: string): string {
  const re = new RegExp(`\\bexport\\s+const\\s+${constName}\\s*=\\s*createServerFn\\(`);
  const m = re.exec(source);
  if (!m) throw new Error(`createServerFn const ${constName} not found`);
  const handlerIdx = source.indexOf(".handler(", m.index);
  if (handlerIdx === -1) throw new Error(`.handler( not found for ${constName}`);
  const arrowIdx = source.indexOf("=>", handlerIdx);
  if (arrowIdx === -1) throw new Error(`arrow not found for ${constName}`);
  const openBrace = source.indexOf("{", arrowIdx);
  if (openBrace === -1) throw new Error(`block body not found for ${constName}`);
  const closeBrace = matchBrace(source, openBrace);
  return source.slice(openBrace, closeBrace + 1);
}

type Entry = { file: string; name: string; kind: "function" | "handler" };

const entries: Entry[] = [
  { file: "whatsapp.functions.ts", name: "createWhatsappSessionFor", kind: "function" },
  { file: "whatsapp.functions.ts", name: "connectWhatsappSessionFor", kind: "function" },
  { file: "whatsapp.functions.ts", name: "disconnectWhatsappSession", kind: "handler" },
  { file: "whatsapp.functions.ts", name: "renameWhatsappSession", kind: "handler" },
  { file: "whatsapp.functions.ts", name: "sendWhatsappMessage", kind: "handler" },
  { file: "whatsapp.functions.ts", name: "sendWhatsappMediaInternal", kind: "function" },
  { file: "whatsapp.functions.ts", name: "sendToLeadFromSessionFor", kind: "function" },
  { file: "whatsapp-admin.server.ts", name: "configureEvolutionWebhookFor", kind: "function" },
  { file: "whatsapp-admin.server.ts", name: "deleteWhatsappSessionFor", kind: "function" },
  { file: "whatsapp-proxies.functions.ts", name: "createWhatsappProxy", kind: "handler" },
  { file: "whatsapp-proxies.functions.ts", name: "updateWhatsappProxy", kind: "handler" },
  { file: "whatsapp-proxies.functions.ts", name: "deleteWhatsappProxy", kind: "handler" },
  { file: "whatsapp-proxies.functions.ts", name: "testWhatsappProxy", kind: "handler" },
  { file: "whatsapp-proxies.functions.ts", name: "assignProxyToSession", kind: "handler" },
  { file: "whatsapp-external.server.ts", name: "saveExternalIntegrationFor", kind: "function" },
  { file: "whatsapp-external.functions.ts", name: "testWhatsappExternalWebhook", kind: "handler" },
  { file: "whatsapp-external.functions.ts", name: "sendAllWhatsappExternalEvents", kind: "handler" },
  { file: "meta.functions.ts", name: "connectMetaSystemUserToken", kind: "handler" },
  { file: "meta.functions.ts", name: "updateMetaAccountSelection", kind: "handler" },
  { file: "meta.functions.ts", name: "validateMetaConnection", kind: "handler" },
  { file: "meta.functions.ts", name: "disconnectMetaConnection", kind: "handler" },
  { file: "marketing.functions.ts", name: "saveMarketingIntegration", kind: "handler" },
  { file: "sms-credits.functions.ts", name: "createSmsCreditCheckout", kind: "handler" },
  { file: "webhooks.functions.ts", name: "rotateMyWebhookCredentials", kind: "handler" },
  { file: "webhooks.functions.ts", name: "provisionMyWebhookHmacSecret", kind: "handler" },
  { file: "webhooks.functions.ts", name: "setMyWebhookHmacEnforcement", kind: "handler" },
  { file: "webhooks.functions.ts", name: "getMyWebhookToken", kind: "handler" },
  { file: "shortio.functions.ts", name: "saveShortioSettings", kind: "handler" },
  { file: "tenants.functions.ts", name: "updateTenantSettings", kind: "handler" },
  { file: "tenants.functions.ts", name: "addUserToTenantFor", kind: "function" },
  { file: "tenants.functions.ts", name: "updateTenantUserRole", kind: "handler" },
  { file: "tenants.functions.ts", name: "removeUserFromTenant", kind: "handler" },
];

describe("demo action guard — static coverage", () => {
  const sourceCache = new Map<string, string>();
  const source = (file: string) => {
    if (!sourceCache.has(file)) sourceCache.set(file, readSource(file));
    return sourceCache.get(file)!;
  };

  it.each(entries)("$file :: $name calls assertTenantNotDemo(", ({ file, name, kind }) => {
    const body =
      kind === "function"
        ? extractFunctionBody(source(file), name)
        : extractHandlerBody(source(file), name);
    expect(body).toContain("assertTenantNotDemo(");
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "./sms-bulk.test-support";
import { __resetDemoTenantCacheForTests } from "./tenant-access.server";
import { saveExternalIntegrationFor } from "./whatsapp-external.server";
import { addUserToTenantFor } from "./tenants.functions";

const DEMO_TENANT = "00000000-0000-4000-8000-00000000d3d0";

describe("saveExternalIntegrationFor — demo tenant", () => {
  let userDb: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    __resetDemoTenantCacheForTests();
    fake.admin.reset();
    fake.admin.rows("tenants").push({ id: DEMO_TENANT, status: "active", is_demo: true });
    fake.admin.onRpc("is_super_admin", () => ({ data: true, error: null }));
    userDb = createFakeDb();
    userDb.onRpc("current_tenant_id", () => ({ data: DEMO_TENANT, error: null }));
  });

  it("rejects with DEMO_ACTION_BLOCKED and writes nothing", async () => {
    await expect(
      saveExternalIntegrationFor(userDb.client, "super-user", {
        url: "https://hooks.example.com/betleads",
        active: true,
        triggers: ["recuperacao_vip"],
      }),
    ).rejects.toMatchObject({ code: "DEMO_ACTION_BLOCKED" });
    expect(userDb.rows("whatsapp_external_integrations")).toHaveLength(0);
    expect(fake.admin.rows("whatsapp_external_integrations")).toHaveLength(0);
  });
});

describe("addUserToTenantFor — demo tenant", () => {
  beforeEach(() => {
    __resetDemoTenantCacheForTests();
    fake.admin.reset();
    fake.admin.rows("tenants").push({ id: DEMO_TENANT, status: "active", is_demo: true });
    fake.admin.onRpc("is_super_admin", () => ({ data: true, error: null }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects with DEMO_ACTION_BLOCKED and writes nothing", async () => {
    const ctx = { userId: "super-user", supabase: fake.admin.client } as unknown as Parameters<
      typeof addUserToTenantFor
    >[0];
    await expect(
      addUserToTenantFor(ctx, {
        tenantId: DEMO_TENANT,
        email: "novo@example.com",
        role: "member",
        password: null,
      }),
    ).rejects.toMatchObject({ code: "DEMO_ACTION_BLOCKED" });
    expect(fake.admin.rows("user_roles")).toHaveLength(0);
  });
});
