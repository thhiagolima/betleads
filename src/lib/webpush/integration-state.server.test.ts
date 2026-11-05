// Web push (OneSignal) — Task 7: integration state, worker verification,
// prompt settings and test push. Uses the in-memory createFakeDb stand-in for
// supabaseAdmin and mocks ./onesignal.server + ./worker-check.server so no
// real OneSignal/network call ever happens.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../sms-bulk.test-support";
import { encryptProviderCredentials } from "@/lib/secret-box.server";

const onesignal = vi.hoisted(() => ({
  sendOneSignalPush: vi.fn(),
  updateOneSignalAppIcon: vi.fn(),
}));

vi.mock("./onesignal.server", async () => {
  const actual = await vi.importActual<typeof import("./onesignal.server")>("./onesignal.server");
  return {
    ...actual,
    sendOneSignalPush: onesignal.sendOneSignalPush,
    updateOneSignalAppIcon: onesignal.updateOneSignalAppIcon,
  };
});

const workerCheck = vi.hoisted(() => ({ checkWorkerFile: vi.fn() }));
vi.mock("./worker-check.server", () => ({ checkWorkerFile: workerCheck.checkWorkerFile }));

const billing = vi.hoisted(() => ({ reserveUsage: vi.fn() }));
vi.mock("@/lib/billing/wallet.server", () => ({ reserveUsage: billing.reserveUsage }));

import {
  getWebpushIntegrationState,
  listRecentWebpushSubscriptions,
  saveWebpushPrompt,
  sendWebpushTest,
  verifyWebpushWorker,
} from "./apps.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

describe("Task 7: web push integration state", () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = "a".repeat(32);
    delete process.env.PUBLIC_APP_URL;
    db = createFakeDb({ unique: { tenant_webpush_apps: [["tenant_id", "origin"]] } });
    db.rows("tenants").push({ id: TENANT, nome: "Casa Bravabet", slug: "bravabet" });
    onesignal.sendOneSignalPush.mockReset();
    onesignal.updateOneSignalAppIcon.mockReset();
    workerCheck.checkWorkerFile.mockReset();
    billing.reserveUsage.mockReset();
  });

  function pushApp(overrides: Partial<Record<string, unknown>> = {}) {
    const id = (overrides.id as string | undefined) ?? `app-${db.rows("tenant_webpush_apps").length + 1}`;
    const row = {
      id,
      tenant_id: TENANT,
      origin: "https://bravabet365.com",
      onesignal_app_id: "os-app-1",
      api_key_encrypted: "",
      created_via: "api",
      status: "instalando",
      worker_verified_at: null,
      script_seen_at: null,
      player_linked_at: null,
      test_sent_at: null,
      created_at: new Date().toISOString(),
      ...overrides,
    } as { id: string } & Record<string, unknown>;
    db.rows("tenant_webpush_apps").push(row);
    return row;
  }

  describe("getWebpushIntegrationState", () => {
    it("enabled=false and current=null with no app at all", async () => {
      const state = await getWebpushIntegrationState(db.client, TENANT);
      expect(state.enabled).toBe(false);
      expect(state.current).toBeNull();
      expect(state.apps).toEqual([]);
    });

    it("current ignores a legado app, even when it's the only/newest one", async () => {
      pushApp({ status: "legado", created_at: "2026-01-01T00:00:00.000Z" });

      const state = await getWebpushIntegrationState(db.client, TENANT);

      expect(state.enabled).toBe(false);
      expect(state.current).toBeNull();
      // The legado app still shows up in the apps list, just isn't "current".
      expect(state.apps).toHaveLength(1);
    });

    it("current is the most recently created instalando/ativo app, skipping legado", async () => {
      pushApp({ id: "app-old", status: "legado", created_at: "2026-01-01T00:00:00.000Z" });
      pushApp({ id: "app-new", status: "ativo", created_at: "2026-02-01T00:00:00.000Z" });

      const state = await getWebpushIntegrationState(db.client, TENANT);

      expect(state.enabled).toBe(true);
      expect(state.current?.id).toBe("app-new");
    });

    it("builds the loader snippet from the settings public_token and PUBLIC_APP_URL", async () => {
      process.env.PUBLIC_APP_URL = "https://app.example.test/";
      db.rows("tenant_webpush_settings").push({
        tenant_id: TENANT,
        public_token: "tok123",
        prompt_text: "Quer receber promoções?",
        accept_label: "Sim",
        cancel_label: "Não",
        icon_url: null,
      });

      const state = await getWebpushIntegrationState(db.client, TENANT);

      expect(state.loaderSnippet).toBe(
        '<script src="https://app.example.test/api/public/push/loader.js?t=tok123" async></script>',
      );
      expect(state.playerSnippet).toBe(
        '<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>',
      );
    });

    it("counts active and identified subscriptions per app", async () => {
      const app = pushApp();
      db.rows("push_subscriptions").push(
        { id: "s1", tenant_id: TENANT, app_id: app.id, subscription_id: "sub-1", status: "ativa", player_id: "p1" },
        { id: "s2", tenant_id: TENANT, app_id: app.id, subscription_id: "sub-2", status: "ativa", player_id: null },
        { id: "s3", tenant_id: TENANT, app_id: app.id, subscription_id: "sub-3", status: "inativa", player_id: "p2" },
      );

      const state = await getWebpushIntegrationState(db.client, TENANT);

      expect(state.apps[0].activeSubscriptions).toBe(2);
      expect(state.apps[0].identifiedSubscriptions).toBe(1);
      expect(state.apps[0].workerUrl).toBe("https://bravabet365.com/push/onesignal/OneSignalSDKWorker.js");
    });
  });

  describe("verifyWebpushWorker", () => {
    it("records worker_verified_at when checkWorkerFile is ok", async () => {
      const app = pushApp();
      workerCheck.checkWorkerFile.mockResolvedValue({ ok: true });

      const result = await verifyWebpushWorker(db.client, { tenantId: TENANT, appRowId: app.id });

      expect(result).toEqual({ ok: true });
      expect(workerCheck.checkWorkerFile).toHaveBeenCalledWith("https://bravabet365.com");
      const stored = db.rows("tenant_webpush_apps").find((r) => r.id === app.id)!;
      expect(stored.worker_verified_at).not.toBeNull();
    });

    it("does not write worker_verified_at and returns the reason when the check fails", async () => {
      const app = pushApp();
      workerCheck.checkWorkerFile.mockResolvedValue({ ok: false, reason: "html" });

      const result = await verifyWebpushWorker(db.client, { tenantId: TENANT, appRowId: app.id });

      expect(result).toEqual({ ok: false, reason: "html" });
      const stored = db.rows("tenant_webpush_apps").find((r) => r.id === app.id)!;
      expect(stored.worker_verified_at).toBeNull();
    });
  });

  describe("sendWebpushTest", () => {
    it("sends the test push, records test_sent_at, flips status to ativo and never charges the wallet", async () => {
      const app = pushApp({
        status: "instalando",
        api_key_encrypted: await encryptProviderCredentials({ apiKey: "plain-key-123" }),
      });
      db.rows("push_subscriptions").push({
        id: "sub-row-1",
        tenant_id: TENANT,
        app_id: app.id,
        subscription_id: "onesignal-sub-1",
        status: "ativa",
        player_id: null,
      });
      onesignal.sendOneSignalPush.mockResolvedValue({
        ok: true,
        notificationId: "notif-1",
        invalidSubscriptionIds: [],
      });

      const result = await sendWebpushTest(db.client, {
        tenantId: TENANT,
        subscriptionRowId: "sub-row-1",
      });

      expect(result.ok).toBe(true);
      expect(onesignal.sendOneSignalPush).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Teste da Betleads",
          body: "Se você está vendo isto, o push da casa está funcionando.",
          url: "https://bravabet365.com",
          subscriptionIds: ["onesignal-sub-1"],
        }),
      );
      const stored = db.rows("tenant_webpush_apps").find((r) => r.id === app.id)!;
      expect(stored.test_sent_at).not.toBeNull();
      expect(stored.status).toBe("ativo");
      expect(billing.reserveUsage).not.toHaveBeenCalled();
    });

    it("rejects a subscription row that belongs to a different tenant", async () => {
      db.rows("tenants").push({ id: OTHER_TENANT, nome: "Casa Dois", slug: "dois" });
      const app = pushApp();
      db.rows("push_subscriptions").push({
        id: "sub-row-1",
        tenant_id: TENANT,
        app_id: app.id,
        subscription_id: "onesignal-sub-1",
        status: "ativa",
        player_id: null,
      });

      await expect(
        sendWebpushTest(db.client, { tenantId: OTHER_TENANT, subscriptionRowId: "sub-row-1" }),
      ).rejects.toThrow("Inscrição não encontrada");

      expect(onesignal.sendOneSignalPush).not.toHaveBeenCalled();
    });

    it("rejects an unknown subscription row", async () => {
      await expect(
        sendWebpushTest(db.client, { tenantId: TENANT, subscriptionRowId: "nope" }),
      ).rejects.toThrow("Inscrição não encontrada");
    });

    it.each(["desativado", "legado"])(
      "refuses the test for a '%s' app before calling OneSignal",
      async (status) => {
        const app = pushApp({ status });
        db.rows("push_subscriptions").push({
          id: "sub-row-1",
          tenant_id: TENANT,
          app_id: app.id,
          subscription_id: "onesignal-sub-1",
          status: "ativa",
          player_id: null,
        });

        await expect(
          sendWebpushTest(db.client, { tenantId: TENANT, subscriptionRowId: "sub-row-1" }),
        ).rejects.toThrow("Este domínio não está ativo");

        expect(onesignal.sendOneSignalPush).not.toHaveBeenCalled();
      },
    );

    it("never demotes an already-'ativo' app on a successful re-verification test", async () => {
      const app = pushApp({
        status: "ativo",
        api_key_encrypted: await encryptProviderCredentials({ apiKey: "plain-key-123" }),
      });
      db.rows("push_subscriptions").push({
        id: "sub-row-1",
        tenant_id: TENANT,
        app_id: app.id,
        subscription_id: "onesignal-sub-1",
        status: "ativa",
        player_id: null,
      });
      onesignal.sendOneSignalPush.mockResolvedValue({
        ok: true,
        notificationId: "notif-1",
        invalidSubscriptionIds: [],
      });

      const result = await sendWebpushTest(db.client, {
        tenantId: TENANT,
        subscriptionRowId: "sub-row-1",
      });

      expect(result.ok).toBe(true);
      const stored = db.rows("tenant_webpush_apps").find((r) => r.id === app.id)!;
      expect(stored.status).toBe("ativo");
      expect(stored.test_sent_at).not.toBeNull();
    });

    it("treats ok:true with every subscription invalid as a failed test: no test_sent_at, no promotion, Portuguese error", async () => {
      const app = pushApp({
        status: "instalando",
        api_key_encrypted: await encryptProviderCredentials({ apiKey: "plain-key-123" }),
      });
      db.rows("push_subscriptions").push({
        id: "sub-row-1",
        tenant_id: TENANT,
        app_id: app.id,
        subscription_id: "onesignal-sub-1",
        status: "ativa",
        player_id: null,
      });
      onesignal.sendOneSignalPush.mockResolvedValue({
        ok: true,
        notificationId: "notif-1",
        invalidSubscriptionIds: ["onesignal-sub-1"],
      });

      const result = await sendWebpushTest(db.client, {
        tenantId: TENANT,
        subscriptionRowId: "sub-row-1",
      });

      expect(result).toEqual({
        ok: false,
        temporary: false,
        status: 200,
        error: "A inscrição não está mais ativa",
      });
      const stored = db.rows("tenant_webpush_apps").find((r) => r.id === app.id)!;
      expect(stored.test_sent_at).toBeNull();
      expect(stored.status).toBe("instalando");
    });
  });

  describe("saveWebpushPrompt", () => {
    it("rejects an accept label longer than 15 chars", async () => {
      await expect(
        saveWebpushPrompt(db.client, {
          tenantId: TENANT,
          promptText: "Quer receber promoções?",
          acceptLabel: "Sim, eu quero!!!", // 16 chars
          cancelLabel: "Não",
          iconUrl: null,
        }),
      ).rejects.toThrow("O rótulo de aceitar deve ter entre 1 e 15 caracteres");

      expect(db.rows("tenant_webpush_settings")).toHaveLength(0);
    });

    it("saves the prompt copy", async () => {
      const saved = await saveWebpushPrompt(db.client, {
        tenantId: TENANT,
        promptText: "Quer receber promoções?",
        acceptLabel: "Sim",
        cancelLabel: "Não",
        iconUrl: null,
      });

      expect(saved).toEqual({
        promptText: "Quer receber promoções?",
        acceptLabel: "Sim",
        cancelLabel: "Não",
        iconUrl: null,
      });
      const stored = db.rows("tenant_webpush_settings").find((r) => r.tenant_id === TENANT)!;
      expect(stored.prompt_text).toBe("Quer receber promoções?");
    });

    it("pushes the new icon to instalando/ativo apps created via api when the icon changes", async () => {
      pushApp({ id: "app-api-1", created_via: "api", status: "ativo", onesignal_app_id: "os-1" });
      pushApp({ id: "app-api-2", created_via: "api", status: "instalando", onesignal_app_id: "os-2" });
      pushApp({ id: "app-manual", created_via: "manual", status: "ativo", onesignal_app_id: "os-3" });
      pushApp({ id: "app-legado", created_via: "api", status: "legado", onesignal_app_id: "os-4" });
      db.rows("tenant_webpush_settings").push({
        tenant_id: TENANT,
        public_token: "tok",
        prompt_text: "x",
        accept_label: "Sim",
        cancel_label: "Não",
        icon_url: null,
      });

      await saveWebpushPrompt(db.client, {
        tenantId: TENANT,
        promptText: "Quer receber promoções?",
        acceptLabel: "Sim",
        cancelLabel: "Não",
        iconUrl: "https://cdn.example.test/icon.png",
      });

      expect(onesignal.updateOneSignalAppIcon).toHaveBeenCalledTimes(2);
      expect(onesignal.updateOneSignalAppIcon).toHaveBeenCalledWith(
        "os-1",
        "https://cdn.example.test/icon.png",
      );
      expect(onesignal.updateOneSignalAppIcon).toHaveBeenCalledWith(
        "os-2",
        "https://cdn.example.test/icon.png",
      );
    });

    it("does not call updateOneSignalAppIcon when the icon is unchanged", async () => {
      pushApp({ id: "app-api-1", created_via: "api", status: "ativo", onesignal_app_id: "os-1" });
      db.rows("tenant_webpush_settings").push({
        tenant_id: TENANT,
        public_token: "tok",
        prompt_text: "x",
        accept_label: "Sim",
        cancel_label: "Não",
        icon_url: "https://cdn.example.test/icon.png",
      });

      await saveWebpushPrompt(db.client, {
        tenantId: TENANT,
        promptText: "Quer receber promoções?",
        acceptLabel: "Sim",
        cancelLabel: "Não",
        iconUrl: "https://cdn.example.test/icon.png",
      });

      expect(onesignal.updateOneSignalAppIcon).not.toHaveBeenCalled();
    });
  });

  describe("listRecentWebpushSubscriptions", () => {
    it("returns up to the last 10 active subscriptions, newest first", async () => {
      const app = pushApp();
      for (let i = 0; i < 12; i++) {
        db.rows("push_subscriptions").push({
          id: `sub-${i}`,
          tenant_id: TENANT,
          app_id: app.id,
          subscription_id: `onesignal-${i}`,
          status: i === 0 ? "inativa" : "ativa",
          player_id: i % 2 === 0 ? `player-${i}` : null,
          user_agent: `UA-${i}`,
          first_seen_at: new Date(2026, 0, i + 1).toISOString(),
        });
      }

      const list = await listRecentWebpushSubscriptions(db.client, {
        tenantId: TENANT,
        appRowId: app.id,
      });

      expect(list).toHaveLength(10);
      expect(list[0].id).toBe("sub-11");
      expect(list[0].playerLinked).toBe(false); // 11 is odd -> player_id null
      expect(list[1].id).toBe("sub-10");
      expect(list[1].playerLinked).toBe(true); // 10 is even -> player_id set
      expect(list.some((r) => r.id === "sub-0")).toBe(false); // inativa excluded
    });

    it("rejects an appRowId that belongs to a different tenant", async () => {
      db.rows("tenants").push({ id: OTHER_TENANT, nome: "Casa Dois", slug: "dois" });
      const app = pushApp();

      await expect(
        listRecentWebpushSubscriptions(db.client, { tenantId: OTHER_TENANT, appRowId: app.id }),
      ).rejects.toThrow("App não encontrada para esta casa");
    });
  });
});
