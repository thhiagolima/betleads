// Diagnóstico do endpoint de voz da BusinessCode.
// POST autenticado: faz uma chamada real com token + payload de teste
// (ou os parâmetros enviados) e devolve status, content-type e body
// completo (até 4 KB) — útil para inspecionar respostas HTML/500.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const BUSINESSCODE_VOICE_URL =
  "https://dash.businesscode.com.br/api/v1/messaging/voice";

function normalizeToken(raw: string): string {
  let t = (raw || "").replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = t.trim().replace(/^['"]+|['"]+$/g, "").trim();
  t = t.replace(/^Authorization\s*:\s*/i, "").trim();
  t = t.replace(/^Bearer\s+/i, "").trim();
  t = t.replace(/\s+/g, "");
  return t;
}

async function requireAuth(request: Request): Promise<Response | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }
  const token = authHeader.slice(7);
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return new Response("Server misconfigured", { status: 500 });
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getClaims(token);
  if (error || !data?.claims?.sub) return new Response("Unauthorized", { status: 401 });
  return null;
}

export const Route = createFileRoute("/api/public/diag/businesscode-voice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauth = await requireAuth(request);
        if (unauth) return unauth;

        let payload: { to?: string; audio_url?: string } = {};
        try {
          const text = await request.text();
          if (text) payload = JSON.parse(text);
        } catch {
          /* ignore */
        }

        const to = payload.to || "+5521980194445";
        const audioUrl =
          payload.audio_url ||
          "https://file-examples.com/storage/fe0c4d4dca6c8e1d2c43cba/2017/11/file_example_MP3_700KB.mp3";

        const rawToken = process.env.BUSINESSCODE_SMS_TOKEN;
        const token = rawToken ? normalizeToken(rawToken) : "";
        if (!token) {
          return Response.json(
            { ok: false, error: "BUSINESSCODE_SMS_TOKEN não configurado" },
            { status: 500 },
          );
        }

        const idempotencyKey = crypto.randomUUID();
        const t0 = Date.now();
        let res: Response;
        try {
          res = await fetch(BUSINESSCODE_VOICE_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({ to, audio_url: audioUrl }),
          });
        } catch (err) {
          return Response.json({
            ok: false,
            stage: "fetch_failed",
            error: err instanceof Error ? err.message : String(err),
            endpoint: BUSINESSCODE_VOICE_URL,
            ms: Date.now() - t0,
          });
        }

        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }

        const headersOut: Record<string, string> = {};
        for (const key of [
          "content-type",
          "cf-ray",
          "x-request-id",
          "x-amzn-trace-id",
          "server",
          "via",
          "date",
        ]) {
          const v = res.headers.get(key);
          if (v) headersOut[key] = v;
        }

        return Response.json({
          ok: res.ok,
          endpoint: BUSINESSCODE_VOICE_URL,
          status: res.status,
          ms: Date.now() - t0,
          idempotencyKey,
          request: { to, audio_url: audioUrl },
          response: {
            headers: headersOut,
            body_parsed: parsed,
            body_text: text.slice(0, 4096),
            truncated: text.length > 4096,
            total_bytes: text.length,
          },
          ts: new Date().toISOString(),
        });
      },
    },
  },
});