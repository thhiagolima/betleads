// Diagnóstico do endpoint de SMS da BusinessCode.
// GET sem token — apenas mede status/latência/content-type pra mostrar
// à BusinessCode quando o app reporta 526 (TLS/Cloudflare).

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const BUSINESSCODE_SMS_URL =
  "https://dash.businesscode.com.br/api/v1/messaging/sms";

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

export const Route = createFileRoute("/api/public/diag/businesscode-sms")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const unauth = await requireAuth(request);
        if (unauth) return unauth;
        const attempts: Array<{
          method: string;
          status: number;
          ms: number;
          contentType: string | null;
          snippet: string;
          error?: string;
        }> = [];

        for (const method of ["GET", "POST"] as const) {
          const t0 = Date.now();
          try {
            const res = await fetch(BUSINESSCODE_SMS_URL, {
              method,
              headers: { "Content-Type": "application/json" },
              body: method === "POST" ? "{}" : undefined,
            });
            const text = await res.text();
            attempts.push({
              method,
              status: res.status,
              ms: Date.now() - t0,
              contentType: res.headers.get("content-type"),
              snippet: text.slice(0, 300),
            });
          } catch (err) {
            attempts.push({
              method,
              status: 0,
              ms: Date.now() - t0,
              contentType: null,
              snippet: "",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return Response.json({
          ok: true,
          endpoint: BUSINESSCODE_SMS_URL,
          note:
            "Status 526 ou erro TLS indica falha de certificado/Cloudflare em dash.businesscode.com.br. Compartilhe com o suporte da BusinessCode.",
          attempts,
          ts: new Date().toISOString(),
        });
      },
    },
  },
});