// Web push (OneSignal) — Task 6: per-origin OneSignal apps, activated by the
// super admin. Uses the in-memory createFakeDb stand-in for supabaseAdmin and
// mocks ./onesignal.server so no real OneSignal call ever happens.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../sms-bulk.test-support";

const onesignal = vi.hoisted(() => ({
  createOneSignalApp: vi.fn(),
  createOneSignalAppKey: vi.fn(),
}));

vi.mock("./onesignal.server", () => ({
  createOneSignalApp: onesignal.createOneSignalApp,
  createOneSignalAppKey: onesignal.createOneSignalAppKey,
}));

import {
  activateWebpushOrigin,
  loadAppCredentials,
  setWebpushAppStatus,
  type WebpushAppRow,
} from "./apps.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

describe("apps.server", () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY = "a".repeat(32);
    db = createFakeDb({ unique: { tenant_webpush_apps: [["tenant_id", "origin"]] } });
    db.rows("tenants").push({ id: TENANT, nome: "Casa Bravabet", slug: "bravabet" });
    onesignal.createOneSignalApp.mockReset();
    onesignal.createOneSignalAppKey.mockReset();
  });

  describe("activateWebpushOrigin — mode api", () => {
    it("creates the OneSignal app and key, stores the row installing with the encrypted key", async () => {
      onesignal.createOneSignalApp.mockResolvedValue({ appId: "os-app-1" });
      onesignal.createOneSignalAppKey.mockResolvedValue({ apiKey: "plain-key-123" });

      const row = await activateWebpushOrigin(db.client, {
        tenantId: TENANT,
        origin: "https://bravabet365.com",
        mode: "api",
      });

      expect(onesignal.createOneSignalApp).toHaveBeenCalledWith({
        siteName: "Casa Bravabet",
        origin: "https://bravabet365.com",
      });
      expect(onesignal.createOneSignalAppKey).toHaveBeenCalledWith("os-app-1");

      expect(row.tenantId).toBe(TENANT);
      expect(row.origin).toBe("https://bravabet365.com");
      expect(row.onesignalAppId).toBe("os-app-1");
      expect(row.createdVia).toBe("api");
      expect(row.status).toBe("instalando");

      const stored = db.rows("tenant_webpush_apps")[0];
      expect(stored.api_key_encrypted).not.toBe("plain-key-123");
      expect(stored.created_via).toBe("api");
      expect(stored.status).toBe("instalando");

      const credentials = await loadAppCredentials(db.client, row.id);
      expect(credentials).toEqual({ appId: "os-app-1", apiKey: "plain-key-123" });
    });

    it("ensures a tenant_webpush_settings row exists for the tenant", async () => {
      onesignal.createOneSignalApp.mockResolvedValue({ appId: "os-app-1" });
      onesignal.createOneSignalAppKey.mockResolvedValue({ apiKey: "plain-key-123" });

      await activateWebpushOrigin(db.client, {
        tenantId: TENANT,
        origin: "https://bravabet365.com",
        mode: "api",
      });

      const settings = db.rows("tenant_webpush_settings").filter((r) => r.tenant_id === TENANT);
      expect(settings).toHaveLength(1);
    });
  });

  describe("activateWebpushOrigin — mode manual", () => {
    it("never calls the OneSignal client and stores created_via manual", async () => {
      const row = await activateWebpushOrigin(db.client, {
        tenantId: TENANT,
        origin: "https://bravabet365.com",
        mode: "manual",
        appId: "manual-app-id",
        apiKey: "manual-key",
      });

      expect(onesignal.createOneSignalApp).not.toHaveBeenCalled();
      expect(onesignal.createOneSignalAppKey).not.toHaveBeenCalled();

      expect(row.onesignalAppId).toBe("manual-app-id");
      expect(row.createdVia).toBe("manual");

      const credentials = await loadAppCredentials(db.client, row.id);
      expect(credentials).toEqual({ appId: "manual-app-id", apiKey: "manual-key" });
    });
  });

  describe("activateWebpushOrigin — origin handling", () => {
    it("rejects an invalid site address", async () => {
      await expect(
        activateWebpushOrigin(db.client, {
          tenantId: TENANT,
          origin: "not a url",
          mode: "manual",
          appId: "a",
          apiKey: "b",
        }),
      ).rejects.toThrow("Endereço do site inválido");

      expect(onesignal.createOneSignalApp).not.toHaveBeenCalled();
    });

    it("creates a second row for a second origin of the same house", async () => {
      onesignal.createOneSignalApp.mockResolvedValue({ appId: "os-app-1" });
      onesignal.createOneSignalAppKey.mockResolvedValue({ apiKey: "key-1" });
      await activateWebpushOrigin(db.client, {
        tenantId: TENANT,
        origin: "https://bravabet365.com",
        mode: "api",
      });

      onesignal.createOneSignalApp.mockResolvedValue({ appId: "os-app-2" });
      onesignal.createOneSignalAppKey.mockResolvedValue({ apiKey: "key-2" });
      const row2 = await activateWebpushOrigin(db.client, {
        tenantId: TENANT,
        origin: "https://www.bravabet365.com",
        mode: "api",
      });

      expect(row2.origin).toBe("https://www.bravabet365.com");
      expect(db.rows("tenant_webpush_apps")).toHaveLength(2);
    });

    it("rejects the same origin activated twice for the same house", async () => {
      onesignal.createOneSignalApp.mockResolvedValue({ appId: "os-app-1" });
      onesignal.createOneSignalAppKey.mockResolvedValue({ apiKey: "key-1" });
      await activateWebpushOrigin(db.client, {
        tenantId: TENANT,
        origin: "https://bravabet365.com",
        mode: "api",
      });

      await expect(
        activateWebpushOrigin(db.client, {
          tenantId: TENANT,
          origin: "https://bravabet365.com",
          mode: "api",
        }),
      ).rejects.toThrow("Este endereço já está ativado");

      expect(db.rows("tenant_webpush_apps")).toHaveLength(1);
    });

    it("allows the same origin for a different house", async () => {
      db.rows("tenants").push({ id: OTHER_TENANT, nome: "Casa Dois", slug: "dois" });
      onesignal.createOneSignalApp.mockResolvedValue({ appId: "os-app-1" });
      onesignal.createOneSignalAppKey.mockResolvedValue({ apiKey: "key-1" });
      await activateWebpushOrigin(db.client, {
        tenantId: TENANT,
        origin: "https://bravabet365.com",
        mode: "api",
      });

      onesignal.createOneSignalApp.mockResolvedValue({ appId: "os-app-2" });
      onesignal.createOneSignalAppKey.mockResolvedValue({ apiKey: "key-2" });
      const row = await activateWebpushOrigin(db.client, {
        tenantId: OTHER_TENANT,
        origin: "https://bravabet365.com",
        mode: "api",
      });

      expect(row.tenantId).toBe(OTHER_TENANT);
      expect(db.rows("tenant_webpush_apps")).toHaveLength(2);
    });
  });

  describe("WebpushAppRow shape", () => {
    it("never carries apiKey or api_key_encrypted", async () => {
      const row = await activateWebpushOrigin(db.client, {
        tenantId: TENANT,
        origin: "https://bravabet365.com",
        mode: "manual",
        appId: "manual-app-id",
        apiKey: "manual-key",
      });

      const asRecord = row as unknown as Record<string, unknown>;
      expect(asRecord.apiKey).toBeUndefined();
      expect(asRecord.api_key_encrypted).toBeUndefined();
      expect(asRecord.apiKeyEncrypted).toBeUndefined();

      const keys: (keyof WebpushAppRow)[] = [
        "id",
        "tenantId",
        "origin",
        "onesignalAppId",
        "status",
        "createdVia",
        "workerVerifiedAt",
        "scriptSeenAt",
        "playerLinkedAt",
        "testSentAt",
      ];
      expect(Object.keys(row).sort()).toEqual([...keys].sort());
    });
  });

  describe("setWebpushAppStatus", () => {
    it("updates the status of the house's own app row", async () => {
      const row = await activateWebpushOrigin(db.client, {
        tenantId: TENANT,
        origin: "https://bravabet365.com",
        mode: "manual",
        appId: "manual-app-id",
        apiKey: "manual-key",
      });

      await setWebpushAppStatus(db.client, {
        tenantId: TENANT,
        appRowId: row.id,
        status: "ativo",
      });

      const stored = db.rows("tenant_webpush_apps").find((r) => r.id === row.id)!;
      expect(stored.status).toBe("ativo");
    });
  });
});
