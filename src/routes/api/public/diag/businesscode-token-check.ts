// Diagnostico autenticado de credenciais de provedores.
// POST com { channel: "sms" | "email", to: "<destino de teste>" }.
// SMS usa Short Brasil; Email continua usando BusinessCode.
//
// Auth: Bearer do usuário Supabase + checagem de super_admin.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const SMS_URL =
  process.env.SHORT_BRASIL_SMS_SINGLE_URL ?? "http://lp01-short.painelsms.com/bot/single-sms.php";
const EMAIL_URL = "https://dash.businesscode.com.br/api/v1/messaging/email";

function normalizeToken(raw: string): string {
  let t = (raw || "").replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = t
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim();
  t = t.replace(/^Authorization\s*:\s*/i, "").trim();
  t = t.replace(/^Bearer\s+/i, "").trim();
  t = t.replace(/\s+/g, "");
  return t;
}

function cleanCredential(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim();
}

function toShortBrasilCell(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("55") ? digits.slice(2) : digits;
}

async function tokenFingerprint(token: string): Promise<string> {
  try {
    const buf = new TextEncoder().encode(token);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 10);
  } catch {
    return "n/a";
  }
}

function isShortBrasilAuthError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const status = (body as Record<string, unknown>).status;
  return status === 101 || status === "101";
}

async function requireSuperAdmin(request: Request): Promise<Response | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const token = authHeader.slice(7);
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return new Response(JSON.stringify({ error: "server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: isSuper } = await supabaseAdmin.rpc("is_super_admin", {
    _user_id: data.claims.sub,
  });
  if (!isSuper) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export const Route = createFileRoute("/api/public/diag/businesscode-token-check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauth = await requireSuperAdmin(request);
        if (unauth) return unauth;

        let body: {
          channel?: string;
          to?: string;
          subject?: string;
          html?: string;
          from?: string;
        } = {};
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }

        const channel = body.channel === "email" ? "email" : "sms";
        const to = (body.to || "").trim();
        if (!to) return Response.json({ error: "to obrigatório" }, { status: 400 });

        const rawToken = channel === "email" ? process.env.BUSINESSCODE_EMAIL_TOKEN : null;
        const shortUsuario = cleanCredential(process.env.SHORT_BRASIL_SMS_USUARIO);
        const shortChave = cleanCredential(process.env.SHORT_BRASIL_SMS_CHAVE);
        if (channel === "sms" && (!shortUsuario || !shortChave)) {
          return Response.json(
            {
              ok: false,
              error: "SHORT_BRASIL_SMS_USUARIO/SHORT_BRASIL_SMS_CHAVE nao configurados",
            },
            { status: 500 },
          );
        }
        if (channel === "email" && !rawToken) {
          return Response.json(
            {
              ok: false,
              error: `Secret BUSINESSCODE_${channel.toUpperCase()}_TOKEN não configurado`,
            },
            { status: 500 },
          );
        }
        const token = rawToken ? normalizeToken(rawToken) : "";
        const fp =
          channel === "sms"
            ? await tokenFingerprint(`${shortUsuario}:${shortChave}`)
            : await tokenFingerprint(token);
        const url = channel === "email" ? EMAIL_URL : SMS_URL;

        const payload: Record<string, unknown> =
          channel === "email"
            ? {
                to,
                from: body.from || "no-reply@betleads.io",
                subject: body.subject || "Teste de token BusinessCode",
                content:
                  body.html || "<p>Teste de validação do token BusinessCode. Pode ignorar.</p>",
              }
            : {
                celular: toShortBrasilCell(to),
                mensagem: "Teste de validacao Short Brasil. Pode ignorar.",
                parceiroId: crypto.randomUUID(),
              };

        const idempotencyKey = crypto.randomUUID();
        const t0 = Date.now();
        let status = 0;
        let contentType: string | null = null;
        let respBody: unknown = null;
        let error: string | null = null;

        try {
          const res = await fetch(url, {
            method: "POST",
            headers:
              channel === "email"
                ? {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    "Idempotency-Key": idempotencyKey,
                  }
                : {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    usuario: shortUsuario,
                    chave: shortChave,
                  },
            body: JSON.stringify(payload),
          });
          status = res.status;
          contentType = res.headers.get("content-type");
          const text = await res.text();
          try {
            respBody = text ? JSON.parse(text) : null;
          } catch {
            respBody = { non_json: true, snippet: text.slice(0, 600) };
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        const ms = Date.now() - t0;
        const verdict = error
          ? "rede_falhou"
          : status === 401
            ? "TOKEN_REJEITADO"
            : channel === "sms" && status === 200 && isShortBrasilAuthError(respBody)
              ? "CREDENCIAIS_REJEITADAS"
              : status >= 200 && status < 300
                ? "TOKEN_OK"
                : status >= 500
                  ? "SERVIDOR_DELES_FALHOU"
                  : "OUTRO_ERRO";

        return Response.json({
          ok:
            status >= 200 &&
            status < 300 &&
            !(channel === "sms" && isShortBrasilAuthError(respBody)),
          verdict,
          channel,
          endpoint: url,
          status,
          contentType,
          ms,
          tokenFingerprint: fp,
          tokenLength: channel === "sms" ? shortUsuario.length + shortChave.length : token.length,
          tokenSource:
            channel === "sms"
              ? "SHORT_BRASIL_SMS_USUARIO/SHORT_BRASIL_SMS_CHAVE"
              : "BUSINESSCODE_EMAIL_TOKEN",
          idempotencyKey,
          response: respBody,
          error,
          ts: new Date().toISOString(),
        });
      },
    },
  },
});
