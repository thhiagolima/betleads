import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MetaApiError,
  debugMetaToken,
  graphPathOf,
  isMetaRateLimitCode,
  isMetaReportNotReady,
  loadMetaInsightsAsync,
  metaGet,
  metaGetAllPages,
  metaPost,
  parseMetaUsageHeaders,
} from "@/lib/meta-graph.server";
import { META_API_DEFAULT_VERSION } from "@/lib/meta-api-version";

const TOKEN = "EAAB-secret-token";

type Call = { url: string; init: RequestInit };

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Um fetch que só termina quando o AbortController aborta. */
function hangingResponse(init: RequestInit) {
  return new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
}

function authHeader(init: RequestInit) {
  return (init.headers as Record<string, string>).Authorization;
}

function expectNoTokenInUrls() {
  for (const call of calls) {
    expect(call.url).not.toContain("access_token");
    expect(call.url).not.toContain(TOKEN);
  }
}

beforeEach(() => {
  calls = [];
  vi.stubEnv("META_API_VERSION", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("metaGet / metaGetAllPages", () => {
  it("sends the token only in the Authorization header and uses the version prefix", async () => {
    mockFetch(() => jsonResponse({ id: "1", name: "Me" }));
    const result = await metaGet<{ id: string }>("/me", TOKEN, {
      fields: "id,name",
      access_token: TOKEN,
    });
    expect(result.data.id).toBe("1");
    expect(result.usage).toEqual({ maxPct: 0, regainAfterMs: null });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.host).toBe("graph.facebook.com");
    expect(url.pathname).toBe(`/${META_API_DEFAULT_VERSION}/me`);
    expect(url.searchParams.get("fields")).toBe("id,name");
    expect(authHeader(calls[0].init)).toBe(`Bearer ${TOKEN}`);
    expectNoTokenInUrls();
  });

  it("uses META_API_VERSION when valid", async () => {
    vi.stubEnv("META_API_VERSION", "v99.0");
    mockFetch(() => jsonResponse({ id: "1" }));
    await metaGet("/me", TOKEN);
    expect(new URL(calls[0].url).pathname).toBe("/v99.0/me");
  });

  it("follows paging.next stripping access_token, with the header on every page", async () => {
    mockFetch((url) => {
      const after = new URL(url).searchParams.get("after");
      if (!after) {
        return jsonResponse(
          {
            data: [{ id: "a" }],
            paging: {
              next: `https://graph.facebook.com/v25.0/act_1/ads?access_token=${TOKEN}&limit=1&after=p2`,
            },
          },
          { headers: { "x-app-usage": JSON.stringify({ call_count: 40 }) } },
        );
      }
      if (after === "p2") {
        return jsonResponse(
          {
            data: [{ id: "b" }],
            paging: {
              next: `https://graph.facebook.com/v25.0/act_1/ads?after=p3&access_token=${TOKEN}`,
            },
          },
          { headers: { "x-app-usage": JSON.stringify({ call_count: 70 }) } },
        );
      }
      return jsonResponse({ data: [{ id: "c" }] });
    });
    const result = await metaGetAllPages<{ id: string }>("/act_1/ads", TOKEN, { limit: "1" });
    expect(result.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(result.usage.maxPct).toBe(70);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(authHeader(call.init)).toBe(`Bearer ${TOKEN}`);
    expectNoTokenInUrls();
  });

  it("refuses to follow a paging.next to another host", async () => {
    mockFetch(() =>
      jsonResponse({ data: [{ id: "a" }], paging: { next: "https://evil.example/steal?x=1" } }),
    );
    await expect(metaGetAllPages("/act_1/ads", TOKEN)).rejects.toBeInstanceOf(MetaApiError);
    expect(calls).toHaveLength(1);
  });

  it("applies the timeout to each page", async () => {
    mockFetch((url, init) => {
      if (new URL(url).searchParams.get("after") === "p2") return hangingResponse(init);
      return jsonResponse({
        data: [{ id: "a" }],
        paging: { next: "https://graph.facebook.com/v25.0/act_1/ads?after=p2" },
      });
    });
    const error = await metaGetAllPages("/act_1/ads", TOKEN, {}, { timeoutMs: 20 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MetaApiError);
    expect((error as MetaApiError).message).toBe(
      "A Meta demorou demais para responder. Tente novamente.",
    );
    expect((error as MetaApiError).status).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("maps the Meta error body to MetaApiError fields", async () => {
    mockFetch(() =>
      jsonResponse(
        {
          error: {
            message: "Unsupported get request.",
            type: "GraphMethodException",
            code: 100,
            error_subcode: 33,
            fbtrace_id: "Abc123",
          },
        },
        { status: 400 },
      ),
    );
    const error = (await metaGet("/act_1/insights", TOKEN).catch(
      (e: unknown) => e,
    )) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.message).toBe("Unsupported get request.");
    expect(error.code).toBe(100);
    expect(error.subcode).toBe(33);
    expect(error.status).toBe(400);
    expect(error.type).toBe("GraphMethodException");
    expect(error.path).toBe("/act_1/insights");
    expect(error.fbtraceId).toBe("Abc123");
    expect(error.retryAfterMs).toBeNull();
  });

  it("treats a 200 with an error body as an error", async () => {
    mockFetch(() => jsonResponse({ error: { message: "Boom", code: 1 } }));
    await expect(metaGet("/me", TOKEN)).rejects.toMatchObject({ message: "Boom", code: 1 });
  });

  it("maps a non-JSON error to `Meta API HTTP <status>`", async () => {
    mockFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const error = (await metaGet("/me", TOKEN).catch((e: unknown) => e)) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.message).toBe("Meta API HTTP 502");
    expect(error.status).toBe(502);
    expect(error.code).toBeNull();
    expect(error.path).toBe("/me");
  });

  it("maps a network failure to a friendly message", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const error = (await metaGet("/me", TOKEN).catch((e: unknown) => e)) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.message).toBe("Não foi possível acessar a API da Meta.");
    expect(error.status).toBeNull();
  });

  it("sets retryAfterMs on rate-limit errors from the usage headers", async () => {
    mockFetch(() =>
      jsonResponse(
        { error: { message: "User request limit reached", code: 80000, error_subcode: 2446079 } },
        {
          status: 400,
          headers: {
            "x-business-use-case-usage": JSON.stringify({
              "123": [
                { type: "ads_insights", call_count: 100, estimated_time_to_regain_access: 19 },
              ],
            }),
          },
        },
      ),
    );
    const error = (await metaGet("/act_1/insights", TOKEN).catch(
      (e: unknown) => e,
    )) as MetaApiError;
    expect(isMetaRateLimitCode(error.code)).toBe(true);
    expect(error.retryAfterMs).toBe(19 * 60_000);
  });

  it("leaves retryAfterMs null on rate-limit errors without usage headers", async () => {
    mockFetch(() => jsonResponse({ error: { message: "Too many", code: 4 } }, { status: 400 }));
    const error = (await metaGet("/me", TOKEN).catch((e: unknown) => e)) as MetaApiError;
    expect(error.code).toBe(4);
    expect(error.retryAfterMs).toBeNull();
  });
});

describe("metaPost", () => {
  it("posts params as a form body, with the token only in the header", async () => {
    mockFetch(() => jsonResponse({ report_run_id: "777" }));
    const result = await metaPost<{ report_run_id: string }>("/act_1/insights", TOKEN, {
      level: "ad",
      access_token: TOKEN,
    });
    expect(result.data.report_run_id).toBe("777");
    expect(calls[0].init.method).toBe("POST");
    const body = calls[0].init.body as URLSearchParams;
    expect(body.get("level")).toBe("ad");
    expect(body.has("access_token")).toBe(false);
    expect(authHeader(calls[0].init)).toBe(`Bearer ${TOKEN}`);
    expectNoTokenInUrls();
  });
});

describe("parseMetaUsageHeaders", () => {
  it("returns zero usage without headers", () => {
    expect(parseMetaUsageHeaders(new Headers())).toEqual({ maxPct: 0, regainAfterMs: null });
  });

  it("reads x-app-usage", () => {
    const headers = new Headers({
      "x-app-usage": JSON.stringify({ call_count: 28, total_time: 61, total_cputime: 25 }),
    });
    expect(parseMetaUsageHeaders(headers)).toEqual({ maxPct: 61, regainAfterMs: null });
  });

  it("reads x-business-use-case-usage across businesses and entries", () => {
    const headers = new Headers({
      "x-business-use-case-usage": JSON.stringify({
        "111": [{ type: "ads_management", call_count: 10, total_cputime: 5, total_time: 4 }],
        "222": [
          {
            type: "ads_insights",
            call_count: 30,
            total_cputime: 92,
            total_time: 50,
            estimated_time_to_regain_access: 0,
          },
        ],
      }),
    });
    expect(parseMetaUsageHeaders(headers)).toEqual({ maxPct: 92, regainAfterMs: null });
  });

  it("converts estimated_time_to_regain_access minutes to ms and takes the max", () => {
    const headers = new Headers({
      "x-business-use-case-usage": JSON.stringify({
        "111": [{ call_count: 100, estimated_time_to_regain_access: 5 }],
        "222": [{ call_count: 100, estimated_time_to_regain_access: 12 }],
      }),
    });
    expect(parseMetaUsageHeaders(headers)).toEqual({ maxPct: 100, regainAfterMs: 12 * 60_000 });
  });

  it("reads x-ad-account-usage; reset_time_duration (s) counts only at >= 100%", () => {
    const below = new Headers({
      "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 9.67, reset_time_duration: 100 }),
    });
    expect(parseMetaUsageHeaders(below)).toEqual({ maxPct: 9.67, regainAfterMs: null });

    const at = new Headers({
      "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 100, reset_time_duration: 300 }),
    });
    expect(parseMetaUsageHeaders(at)).toEqual({ maxPct: 100, regainAfterMs: 300_000 });
  });

  it("combines all headers and ignores malformed ones", () => {
    const headers = new Headers({
      "x-app-usage": "not json",
      "x-business-use-case-usage": JSON.stringify({
        "1": [{ call_count: 100, estimated_time_to_regain_access: 2 }],
      }),
      "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 120, reset_time_duration: 600 }),
    });
    expect(parseMetaUsageHeaders(headers)).toEqual({ maxPct: 120, regainAfterMs: 600_000 });
  });
});

describe("isMetaRateLimitCode / graphPathOf", () => {
  it("recognizes the rate-limit codes", () => {
    for (const code of [4, 17, 32, 613, 80000, 80004, 80014]) {
      expect(isMetaRateLimitCode(code)).toBe(true);
    }
    for (const code of [null, 1, 2, 100, 190, 80015, 79999]) {
      expect(isMetaRateLimitCode(code)).toBe(false);
    }
  });

  it("strips the version prefix", () => {
    expect(graphPathOf("https://graph.facebook.com/v25.0/act_1/ads?x=1")).toBe("/act_1/ads");
    expect(graphPathOf(new URL("https://graph.facebook.com/v3/me"))).toBe("/me");
    expect(graphPathOf("https://graph.facebook.com/me/permissions")).toBe("/me/permissions");
  });
});

describe("debugMetaToken", () => {
  it("maps a never-expiring system user token", async () => {
    mockFetch(() =>
      jsonResponse({
        data: {
          app_id: "999",
          type: "SYSTEM_USER",
          application: "CRM",
          expires_at: 0,
          data_access_expires_at: 0,
          is_valid: true,
          scopes: ["ads_read", "business_management"],
          user_id: "555",
        },
      }),
    );
    const info = await debugMetaToken(TOKEN);
    expect(info).toEqual({
      isValid: true,
      type: "SYSTEM_USER",
      appId: "999",
      userId: "555",
      expiresAt: null,
      dataAccessExpiresAt: null,
      scopes: ["ads_read", "business_management"],
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/${META_API_DEFAULT_VERSION}/debug_token`);
    expect(url.searchParams.get("input_token")).toBe(TOKEN);
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(authHeader(calls[0].init)).toBe(`Bearer ${TOKEN}`);
  });

  it("converts unix expiry timestamps to ISO", async () => {
    mockFetch(() =>
      jsonResponse({
        data: {
          app_id: "999",
          type: "USER",
          expires_at: 1_800_000_000,
          data_access_expires_at: 1_810_000_000,
          is_valid: true,
          scopes: ["ads_read"],
          user_id: "555",
        },
      }),
    );
    const info = await debugMetaToken(TOKEN);
    expect(info.expiresAt).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(info.dataAccessExpiresAt).toBe(new Date(1_810_000_000 * 1000).toISOString());
    expect(info.type).toBe("USER");
  });

  it("returns isValid false when debug_token reports an invalid token", async () => {
    mockFetch(() =>
      jsonResponse({
        data: {
          app_id: "999",
          is_valid: false,
          error: { code: 190, message: "Session has expired" },
          scopes: [],
        },
      }),
    );
    const info = await debugMetaToken(TOKEN);
    expect(info.isValid).toBe(false);
    expect(info.appId).toBe("999");
  });

  it("returns isValid false when the call itself fails with OAuthException 190", async () => {
    mockFetch(() =>
      jsonResponse(
        { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } },
        { status: 400 },
      ),
    );
    const info = await debugMetaToken(TOKEN);
    expect(info).toMatchObject({ isValid: false, type: null, appId: null, scopes: [] });
  });

  it("rethrows read errors", async () => {
    mockFetch(() => new Response("oops", { status: 500 }));
    await expect(debugMetaToken(TOKEN)).rejects.toMatchObject({ message: "Meta API HTTP 500" });
  });
});

describe("loadMetaInsightsAsync", () => {
  function asyncHandler(statuses: string[], pages = true, percents: Array<number | null> = []) {
    let poll = 0;
    return (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      if (init.method === "POST") {
        expect(parsed.pathname).toBe(`/${META_API_DEFAULT_VERSION}/act_1/insights`);
        return jsonResponse({ report_run_id: "777" });
      }
      if (parsed.pathname.endsWith("/777")) {
        const status = statuses[Math.min(poll, statuses.length - 1)];
        const percent = percents.length
          ? percents[Math.min(poll, percents.length - 1)]
          : status === "Job Completed"
            ? 100
            : 50;
        poll += 1;
        const body: Record<string, unknown> = { id: "777", async_status: status };
        if (percent !== null) body.async_percent_completion = percent;
        return jsonResponse(body, {
          headers: { "x-app-usage": JSON.stringify({ call_count: 91 }) },
        });
      }
      if (parsed.pathname.endsWith("/777/insights") && pages) {
        if (parsed.searchParams.get("after") === "p2") {
          return jsonResponse({ data: [{ ad_id: "2" }] });
        }
        return jsonResponse({
          data: [{ ad_id: "1" }],
          paging: {
            next: `https://graph.facebook.com/v25.0/777/insights?access_token=${TOKEN}&after=p2`,
          },
        });
      }
      return jsonResponse({ error: { message: "unexpected", code: 1 } }, { status: 400 });
    };
  }

  it("starts the job, polls until completed and reads every page", async () => {
    mockFetch(asyncHandler(["Job Running", "Job Completed"]));
    const onPoll = vi.fn(async () => true);
    const result = await loadMetaInsightsAsync<{ ad_id: string }>(
      "act_1",
      TOKEN,
      { level: "ad", limit: "500", time_range: '{"since":"2026-10-01","until":"2026-10-28"}' },
      { pollIntervalMs: 1, onPoll },
    );
    expect(result.rows.map((row) => row.ad_id)).toEqual(["1", "2"]);
    expect(result.usage.maxPct).toBe(91);
    expect(onPoll).toHaveBeenCalledTimes(2);
    const polls = calls.filter((call) => new URL(call.url).pathname.endsWith("/777"));
    expect(polls).toHaveLength(2);
    expect(new URL(polls[0].url).searchParams.get("fields")).toBe(
      "async_status,async_percent_completion",
    );
    const post = calls[0];
    expect((post.init.body as URLSearchParams).get("level")).toBe("ad");
    const firstPage = calls.find((call) => new URL(call.url).pathname.endsWith("/777/insights"));
    expect(new URL(firstPage!.url).searchParams.get("limit")).toBe("500");
    for (const call of calls) expect(authHeader(call.init)).toBe(`Bearer ${TOKEN}`);
    expectNoTokenInUrls();
  });

  it("keeps polling while Job Completed reports less than 100%", async () => {
    mockFetch(asyncHandler(["Job Completed", "Job Completed"], true, [90, 100]));
    const result = await loadMetaInsightsAsync("act_1", TOKEN, {}, { pollIntervalMs: 1 });
    expect(result.rows).toHaveLength(2);
    const polls = calls.filter((call) => new URL(call.url).pathname.endsWith("/777"));
    expect(polls).toHaveLength(2);
  });

  it("treats Job Completed without a percentage as done", async () => {
    mockFetch(asyncHandler(["Job Completed"], true, [null]));
    const result = await loadMetaInsightsAsync("act_1", TOKEN, {}, { pollIntervalMs: 1 });
    expect(result.rows).toHaveLength(2);
    const polls = calls.filter((call) => new URL(call.url).pathname.endsWith("/777"));
    expect(polls).toHaveLength(1);
  });

  it("accepts a path with a leading slash", async () => {
    mockFetch(asyncHandler(["Job Completed"]));
    const result = await loadMetaInsightsAsync("/act_1", TOKEN, {}, { pollIntervalMs: 1 });
    expect(result.rows).toHaveLength(2);
  });

  it("throws when the job fails", async () => {
    mockFetch(asyncHandler(["Job Started", "Job Failed"]));
    await expect(
      loadMetaInsightsAsync("act_1", TOKEN, {}, { pollIntervalMs: 1 }),
    ).rejects.toMatchObject({
      name: "MetaApiError",
      message: "A Meta não conseguiu gerar o relatório de desempenho.",
    });
  });

  it("throws when the job is skipped", async () => {
    mockFetch(asyncHandler(["Job Skipped"]));
    await expect(
      loadMetaInsightsAsync("act_1", TOKEN, {}, { pollIntervalMs: 1 }),
    ).rejects.toMatchObject({ message: "A Meta não conseguiu gerar o relatório de desempenho." });
  });

  it("gives up after maxWaitMs with a 5-minute retry", async () => {
    vi.useFakeTimers();
    mockFetch(asyncHandler(["Job Not Started", "Job Running"]));
    const promise = loadMetaInsightsAsync(
      "act_1",
      TOKEN,
      {},
      {
        pollIntervalMs: 3_000,
        maxWaitMs: 10_000,
      },
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = (await promise) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.message).toBe("O relatório da Meta ainda não ficou pronto.");
    expect(error.retryAfterMs).toBe(5 * 60_000);
    expect(error.type).toBe("not_ready");
    expect(isMetaReportNotReady(error)).toBe(true);
    expect(
      isMetaReportNotReady(new MetaApiError("O relatório da Meta ainda não ficou pronto.")),
    ).toBe(false);
    const polls = calls.filter((call) => new URL(call.url).pathname.endsWith("/777"));
    expect(polls).toHaveLength(4); // 3 s, 6 s, 9 s, 10 s
  });

  it("aborts when onPoll returns false", async () => {
    mockFetch(asyncHandler(["Job Running"]));
    const onPoll = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const error = (await loadMetaInsightsAsync(
      "act_1",
      TOKEN,
      {},
      {
        pollIntervalMs: 1,
        onPoll,
      },
    ).catch((e: unknown) => e)) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.message).toBe("Leitura interrompida.");
    expect(error.type).toBe("aborted");
    const polls = calls.filter((call) => new URL(call.url).pathname.endsWith("/777"));
    expect(polls).toHaveLength(1);
  });
});
