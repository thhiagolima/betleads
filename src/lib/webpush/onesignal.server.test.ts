// OneSignal REST client (web push channel, Task 4).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realFetch = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };
const ORG_CREDENTIALS = { orgApiKey: "org-test-key", orgId: "org-test-id" };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...ORIGINAL_ENV };
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sendOneSignalPush", () => {
  const baseInput = {
    appId: "app-1",
    apiKey: "app-api-key",
    subscriptionIds: ["s1", "s2"],
    title: "Título",
    body: "Corpo da mensagem",
    url: "https://x.com/promo",
    idempotencyKey: "idem-1",
  };

  it("POSTs to /notifications?c=push with the expected body and headers", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { id: "n1", errors: { invalid_player_ids: ["s2"] } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendOneSignalPush } = await import("./onesignal.server");
    const result = await sendOneSignalPush(baseInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.onesignal.com/notifications?c=push");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Key app-api-key");
    expect(headers["OneSignal-Usage"]).toBe("Betleads | Partner Integration");
    expect(JSON.parse(init.body as string)).toEqual({
      app_id: "app-1",
      include_subscription_ids: ["s1", "s2"],
      target_channel: "push",
      headings: { en: "Título", pt: "Título" },
      contents: { en: "Corpo da mensagem", pt: "Corpo da mensagem" },
      url: "https://x.com/promo",
      idempotency_key: "idem-1",
    });

    expect(result).toEqual({ ok: true, notificationId: "n1", invalidSubscriptionIds: ["s2"] });
  });

  it("includes chrome_web_image and chrome_web_icon when provided", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "n1", errors: {} }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendOneSignalPush } = await import("./onesignal.server");
    await sendOneSignalPush({
      ...baseInput,
      imageUrl: "https://x.com/img.png",
      iconUrl: "https://x.com/icon.png",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.chrome_web_image).toBe("https://x.com/img.png");
    expect(body.chrome_web_icon).toBe("https://x.com/icon.png");
  });

  it("200 with id:'' and errors as an array of messages reports all subscriptions as invalid", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { id: "", errors: ["All included players are not subscribed"] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendOneSignalPush } = await import("./onesignal.server");
    const result = await sendOneSignalPush(baseInput);

    expect(result).toEqual({
      ok: true,
      notificationId: "",
      invalidSubscriptionIds: ["s1", "s2"],
    });
  });

  it("200 with no errors field reports no invalid subscriptions", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "n1" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendOneSignalPush } = await import("./onesignal.server");
    const result = await sendOneSignalPush(baseInput);

    expect(result).toEqual({ ok: true, notificationId: "n1", invalidSubscriptionIds: [] });
  });

  it.each([429, 503])("status %d is reported as a temporary failure", async (status) => {
    const fetchMock = vi.fn(async () => jsonResponse(status, { errors: ["busy"] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendOneSignalPush } = await import("./onesignal.server");
    const result = await sendOneSignalPush(baseInput);

    expect(result).toMatchObject({ ok: false, temporary: true, status });
  });

  it("status 400 is reported as a non-temporary failure", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { errors: ["bad request"] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendOneSignalPush } = await import("./onesignal.server");
    const result = await sendOneSignalPush(baseInput);

    expect(result).toMatchObject({ ok: false, temporary: false, status: 400 });
  });

  it("a network error is reported as temporary, never thrown", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendOneSignalPush } = await import("./onesignal.server");
    const result = await sendOneSignalPush(baseInput);

    expect(result).toMatchObject({ ok: false, temporary: true });
  });
});

describe("deterministicUuid", () => {
  it("is stable for the same input and differs across inputs", async () => {
    const { deterministicUuid } = await import("./onesignal.server");

    const a1 = await deterministicUuid("a");
    const a2 = await deterministicUuid("a");
    const b = await deterministicUuid("b");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("matches the UUID v4-like shape", async () => {
    const { deterministicUuid } = await import("./onesignal.server");

    const id = await deterministicUuid("some-input");

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("createOneSignalApp", () => {
  const input = { siteName: "Casa X", origin: "https://x.com", credentials: ORG_CREDENTIALS };

  it("throws 'OneSignal não configurado' with an empty orgApiKey", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { createOneSignalApp } = await import("./onesignal.server");

    await expect(
      createOneSignalApp({ ...input, credentials: { orgApiKey: "" } }),
    ).rejects.toThrow("OneSignal não configurado");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to /apps with the org key from the given credentials and returns the appId", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "app-123" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { createOneSignalApp } = await import("./onesignal.server");
    const result = await createOneSignalApp(input);

    expect(result).toEqual({ appId: "app-123" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.onesignal.com/apps");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Key org-test-key");
    expect(headers["OneSignal-Usage"]).toBe("Betleads | Partner Integration");
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("Casa X");
    expect(body.site_name).toBe("Casa X");
    expect(body.chrome_web_origin).toBe("https://x.com");
    expect(body.organization_id).toBe("org-test-id");
  });

  it("includes chrome_web_default_notification_icon when iconUrl is provided", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "app-123" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { createOneSignalApp } = await import("./onesignal.server");
    await createOneSignalApp({ ...input, iconUrl: "https://x.com/icon.png" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.chrome_web_default_notification_icon).toBe("https://x.com/icon.png");
  });

  it("omits organization_id when the credentials have no orgId", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "app-123" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { createOneSignalApp } = await import("./onesignal.server");
    await createOneSignalApp({ ...input, credentials: { orgApiKey: "org-test-key" } });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.organization_id).toBeUndefined();
  });

  it("throws instead of returning an empty appId when OneSignal rejects the request", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(400, { errors: ["Organization not found"] }),
    ) as unknown as typeof fetch;

    const { createOneSignalApp } = await import("./onesignal.server");

    await expect(createOneSignalApp(input)).rejects.toThrow(/OneSignal recusou.*400.*Organization not found/);
  });

  it("throws when a 200 response carries no id", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;

    const { createOneSignalApp } = await import("./onesignal.server");

    await expect(createOneSignalApp(input)).rejects.toThrow("OneSignal recusou");
  });
});

describe("createOneSignalAppKey", () => {
  it("throws 'OneSignal não configurado' with an empty orgApiKey", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { createOneSignalAppKey } = await import("./onesignal.server");

    await expect(createOneSignalAppKey("app-1", { orgApiKey: "" })).rejects.toThrow(
      "OneSignal não configurado",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to /apps/{appId}/auth/tokens with name betleads", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { token_value: "key-abc" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { createOneSignalAppKey } = await import("./onesignal.server");
    const result = await createOneSignalAppKey("app-1", ORG_CREDENTIALS);

    expect(result).toEqual({ apiKey: "key-abc" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.onesignal.com/apps/app-1/auth/tokens");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Key org-test-key");
    expect(JSON.parse(init.body as string)).toEqual({ name: "betleads" });
  });

  it("reads formatted_token when token_value is absent", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { formatted_token: "key-def" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { createOneSignalAppKey } = await import("./onesignal.server");
    const result = await createOneSignalAppKey("app-1", ORG_CREDENTIALS);

    expect(result).toEqual({ apiKey: "key-def" });
  });

  it("reads api_key when token_value and formatted_token are absent", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { api_key: "key-ghi" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { createOneSignalAppKey } = await import("./onesignal.server");
    const result = await createOneSignalAppKey("app-1", ORG_CREDENTIALS);

    expect(result).toEqual({ apiKey: "key-ghi" });
  });

  it("throws instead of returning an empty key when OneSignal rejects the request", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(404, { errors: ["not found"] })) as unknown as typeof fetch;

    const { createOneSignalAppKey } = await import("./onesignal.server");

    await expect(createOneSignalAppKey("app-1", ORG_CREDENTIALS)).rejects.toThrow(/OneSignal recusou.*404/);
  });
});

describe("updateOneSignalAppIcon", () => {
  it("PUTs to /apps/{appId} with the given credentials' org key", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { updateOneSignalAppIcon } = await import("./onesignal.server");
    await updateOneSignalAppIcon("app-1", "https://x.com/icon.png", ORG_CREDENTIALS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.onesignal.com/apps/app-1");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Key org-test-key");
    const body = JSON.parse(init.body as string);
    expect(body.chrome_web_default_notification_icon).toBe("https://x.com/icon.png");
  });

  it("throws with OneSignal's errors when the PUT is refused", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(400, { errors: ["invalid icon"] })) as unknown as typeof fetch;

    const { updateOneSignalAppIcon } = await import("./onesignal.server");
    await expect(
      updateOneSignalAppIcon("app-1", "https://x.com/icon.png", ORG_CREDENTIALS),
    ).rejects.toThrow(/OneSignal recusou o ícone do app \(400\).*invalid icon/);
  });

  it("does nothing (no fetch call) when the credentials have no orgApiKey (manual path)", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { updateOneSignalAppIcon } = await import("./onesignal.server");
    await expect(
      updateOneSignalAppIcon("app-1", "https://x.com/icon.png", { orgApiKey: "" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("deleteOneSignalSubscription", () => {
  it("DELETEs /apps/{appId}/subscriptions/{subscriptionId} with the app key", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { deleteOneSignalSubscription } = await import("./onesignal.server");
    await deleteOneSignalSubscription({ appId: "app-1", apiKey: "app-key", subscriptionId: "sub-1" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.onesignal.com/apps/app-1/subscriptions/sub-1");
    expect(init.method).toBe("DELETE");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Key app-key");
  });

  it("treats 404 as success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404, { errors: ["not found"] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { deleteOneSignalSubscription } = await import("./onesignal.server");

    await expect(
      deleteOneSignalSubscription({ appId: "app-1", apiKey: "app-key", subscriptionId: "sub-1" }),
    ).resolves.toBeUndefined();
  });
});
