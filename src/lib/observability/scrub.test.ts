import { describe, expect, it } from "vitest";

import * as tsScrub from "./scrub";

type ScrubModule = Pick<
  typeof tsScrub,
  | "scrubString"
  | "scrubUrl"
  | "scrubValue"
  | "scrubEvent"
  | "scrubSpan"
  | "scrubLog"
  | "isSensitiveKey"
>;

// instrument.mjs (repo root) carries a plain-JS copy of the scrubbers. Run the
// exact same assertions against both so they cannot drift apart. It is safe to
// import: without SENTRY_DSN it does not initialize (nor even load) @sentry/node.
const instrumentPath = "../../../instrument.mjs";
delete process.env.SENTRY_DSN;
const jsScrub = (await import(/* @vite-ignore */ instrumentPath)) as ScrubModule;

const implementations: Array<[string, ScrubModule]> = [
  ["scrub.ts", tsScrub],
  ["instrument.mjs", jsScrub],
];

describe.each(implementations)("%s", (_name, s) => {
  it("redacts e-mails, phones and CPFs in free text", () => {
    const out = s.scrubString(
      "Falha ao enviar para joao.silva@example.com / +55 (11) 98046-5329 / 5511980465329 / 11980465329 / cpf 123.456.789-09",
    );
    expect(out).not.toContain("joao.silva@example.com");
    expect(out).not.toMatch(/98046-?5329/);
    expect(out).not.toContain("5511980465329");
    expect(out).not.toContain("11980465329");
    expect(out).not.toContain("123.456.789-09");
    expect(out).toContain("[email]");
    expect(out).toContain("[cpf]");
    expect(out).toContain("[phone]");
  });

  it("keeps harmless text, dates and UUIDs intact", () => {
    const text =
      "journey 550e8400-e29b-41d4-a716-446655440000 failed at 2026-10-14T12:00:00Z with status 500";
    expect(s.scrubString(text)).toBe(text);
  });

  it("redacts bearer tokens and JWTs", () => {
    const out = s.scrubString(
      "Authorization: Bearer abc.def-123 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    );
    expect(out).not.toContain("abc.def-123");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("replaces tracking/webhook tokens in URLs and filters query values", () => {
    expect(
      s.scrubUrl("https://crm.example.com/api/public/click/AbC123xyz?utm=1&sig=deadbeef"),
    ).toBe("https://crm.example.com/api/public/click/:token?utm=[Filtered]&sig=[Filtered]");
    expect(s.scrubUrl("/api/public/webhook/tok_987/deposito")).toBe(
      "/api/public/webhook/:token/deposito",
    );
    // Single segment is the event name, not a token.
    expect(s.scrubUrl("/api/public/webhook/deposito")).toBe("/api/public/webhook/deposito");
    expect(s.scrubUrl("https://crm.example.com/u/unsub-token-1")).toBe(
      "https://crm.example.com/u/:token",
    );
    expect(s.scrubUrl("https://uptime.betterstack.com/api/v1/heartbeat/SeCrEt123/fail")).toBe(
      "https://uptime.betterstack.com/api/v1/heartbeat/:token/fail",
    );
    expect(s.scrubString("GET /api/public/click/xyz987 failed")).toBe(
      "GET /api/public/click/:token failed",
    );
  });

  it("flags sensitive keys regardless of case/separators", () => {
    for (const key of [
      "telefone",
      "Phone",
      "email",
      "nome",
      "name",
      "CPF",
      "payload",
      "raw_payload",
      "token",
      "tracking_token",
      "Authorization",
      "cookie",
      "x-webhook-signature",
      "secret",
      "password",
      "apiKey",
      "api_key",
    ]) {
      expect(s.isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ["tenant_id", "job", "status", "journey_id", "channel"]) {
      expect(s.isSensitiveKey(key), key).toBe(false);
    }
  });

  it("deep-scrubs objects by key and value", () => {
    const out = s.scrubValue({
      tenant_id: "t1",
      lead: { nome: "Maria", telefone: "11999998888", note: "ligar para 11 99999-8888" },
      raw_payload: { anything: true },
      list: [{ email: "a@b.com" }],
    }) as Record<string, any>;
    expect(out.tenant_id).toBe("t1");
    expect(out.lead.nome).toBe("[Filtered]");
    expect(out.lead.telefone).toBe("[Filtered]");
    expect(out.lead.note).not.toContain("99999-8888");
    expect(out.raw_payload).toBe("[Filtered]");
    expect(out.list[0].email).toBe("[Filtered]");
  });

  it("scrubs a full error event", () => {
    const event = {
      message: "erro para maria@example.com",
      transaction: "GET /api/public/click/secret-token",
      exception: { values: [{ type: "Error", value: "telefone 11987654321 invalido" }] },
      request: {
        url: "https://crm.example.com/api/public/webhook/tok123/cadastro?email=x@y.com",
        query_string: "email=x@y.com",
        cookies: { sb: "session" },
        data: { phone: "11987654321" },
        headers: {
          authorization: "Bearer xyz",
          "x-webhook-signature": "sha256=abc",
          "user-agent": "curl/8",
        },
      },
      user: { id: "u1", email: "u@example.com", ip_address: "1.2.3.4" },
      tags: { job: "webhook", tenant_id: "t1" },
      extra: { payload: { nome: "Ana" }, attempt: 2 },
      contexts: {
        runtime: { name: "node", version: "22" },
        lead: { name: "Ana", phone: "11987654321" },
      },
      breadcrumbs: [{ message: "POST /api/public/click/abc", data: { url: "/u/tok?x=1" } }],
    };
    const out = s.scrubEvent(event) as any;
    expect(out.message).toBe("erro para [email]");
    expect(out.transaction).toBe("GET /api/public/click/:token");
    expect(out.exception.values[0].value).not.toContain("11987654321");
    expect(out.request.url).toBe(
      "https://crm.example.com/api/public/webhook/:token/cadastro?email=[Filtered]",
    );
    expect(out.request.query_string).toBe("[Filtered]");
    expect(out.request.cookies).toBe("[Filtered]");
    expect(out.request.data).toBe("[Filtered]");
    expect(out.request.headers.authorization).toBe("[Filtered]");
    expect(out.request.headers["x-webhook-signature"]).toBe("[Filtered]");
    expect(out.request.headers["user-agent"]).toBe("curl/8");
    expect(out.user).toEqual({ id: "u1" });
    expect(out.tags).toEqual({ job: "webhook", tenant_id: "t1" });
    expect(out.extra).toEqual({ payload: "[Filtered]", attempt: 2 });
    expect(out.contexts.runtime).toEqual({ name: "node", version: "22" });
    expect(out.contexts.lead).toEqual({ name: "[Filtered]", phone: "[Filtered]" });
    expect(out.breadcrumbs[0].message).toBe("POST /api/public/click/:token");
    expect(out.breadcrumbs[0].data.url).toBe("/u/:token?x=[Filtered]");
    expect(JSON.stringify(out)).not.toMatch(/example\.com"|11987654321|Ana|secret-token|tok123/);
  });

  it("scrubs streamed spans and logs", () => {
    const span = s.scrubSpan({
      name: "GET /api/public/click/abcdef",
      attributes: {
        "url.full": "https://x.test/api/public/click/abcdef?a=1",
        "url.query": "?a=1",
        "http.request.header.cookie": "sb=1",
        "sentry.op": "http.server",
      },
    }) as any;
    expect(span.name).toBe("GET /api/public/click/:token");
    expect(span.attributes["url.full"]).toBe("https://x.test/api/public/click/:token?a=[Filtered]");
    expect(span.attributes["url.query"]).toBe("[Filtered]");
    expect(span.attributes["http.request.header.cookie"]).toBe("[Filtered]");
    expect(span.attributes["sentry.op"]).toBe("http.server");

    const log = s.scrubLog({
      level: "info",
      message: "enviado para a@b.com",
      attributes: { tenant_id: "t1", phone: "11987654321" },
    }) as any;
    expect(log.message).toBe("enviado para [email]");
    expect(log.attributes).toEqual({ tenant_id: "t1", phone: "[Filtered]" });
  });
});

describe("parity between scrub.ts and instrument.mjs", () => {
  it("uses the same restricted dataCollection", () => {
    expect((jsScrub as any).RESTRICTED_DATA_COLLECTION).toEqual(tsScrub.RESTRICTED_DATA_COLLECTION);
    expect(tsScrub.RESTRICTED_DATA_COLLECTION.stackFrameVariables).toBe(false);
    expect(tsScrub.RESTRICTED_DATA_COLLECTION.httpBodies).toEqual([]);
  });

  it("strips stack frame local variables", () => {
    for (const s of [tsScrub, jsScrub]) {
      const out = s.scrubEvent({
        exception: { values: [{ value: "x", stacktrace: { frames: [{ vars: { phone: "1" } }] } }] },
      }) as any;
      expect(out.exception.values[0].stacktrace.frames[0].vars).toBeUndefined();
    }
  });
});
