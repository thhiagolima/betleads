// Diagnóstico: consulta na BusinessCode o status real de uma ligação.
// GET /api/public/diag/call-status?providerCallId=... ou ?dispatchId=...
// Requer Authorization: Bearer <supabase access token>.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function requireAuth(request: Request): Promise<Response | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return new Response("Unauthorized", { status: 401 });
  const token = authHeader.slice(7);
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) return new Response("Server misconfigured", { status: 500 });
  const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getClaims(token);
  if (error || !data?.claims?.sub) return new Response("Unauthorized", { status: 401 });
  return null;
}

function normalizeToken(raw: string): string {
  return (raw || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/^Authorization\s*:\s*/i, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/\s+/g, "");
}

export const Route = createFileRoute("/api/public/diag/call-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const unauth = await requireAuth(request);
        if (unauth) return unauth;

        const url = new URL(request.url);
        const providerCallId = url.searchParams.get("providerCallId");
        let dispatchId = url.searchParams.get("dispatchId");
        let history: any = null;

        if (providerCallId) {
          const { data } = await supabaseAdmin
            .from("call_history")
            .select("id, status, duration_seconds, provider_call_id, provider_response, to_phone, created_at")
            .eq("provider_call_id", providerCallId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          history = data;
          if (data && !dispatchId) {
            const pr: any = data.provider_response ?? {};
            dispatchId = String(pr.dispatch_id ?? "") || null;
          }
        }

        if (!dispatchId) {
          return Response.json({
            ok: false,
            error: "Informe providerCallId ou dispatchId. Não consegui resolver dispatch_id.",
            history,
          }, { status: 400 });
        }

        const token = normalizeToken(process.env.BUSINESSCODE_SMS_TOKEN || "");
        if (!token) {
          return Response.json({ ok: false, error: "BUSINESSCODE_SMS_TOKEN não configurado" }, { status: 500 });
        }

        const statusUrl = `https://dash.businesscode.com.br/api/v1/messaging/dispatches/${dispatchId}`;
        const t0 = Date.now();
        let providerStatus = 0;
        let providerBody: unknown = null;
        let err: string | null = null;
        try {
          const res = await fetch(statusUrl, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          });
          providerStatus = res.status;
          const text = await res.text();
          try {
            providerBody = text ? JSON.parse(text) : null;
          } catch {
            providerBody = { non_json: true, snippet: text.slice(0, 400) };
          }
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }

        return Response.json({
          ok: true,
          dispatch_id: dispatchId,
          status_url: statusUrl,
          provider_status: providerStatus,
          provider_body: providerBody,
          latency_ms: Date.now() - t0,
          error: err,
          history,
          note:
            "Use este endpoint para conferir se a BusinessCode tem o status real da ligação. " +
            "Se aqui aparece 'answered' mas o call_history continua 'pending', o webhook não está chegando — verifique o callback na BusinessCode.",
          webhook_expected: "https://betleads.io/api/public/calls/businesscode-webhook",
        });
      },
    },
  },
});