// Diagnostico do endpoint de SMS da Short Brasil.
// A rota manteve o nome antigo por compatibilidade com links internos.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const SHORT_BRASIL_SMS_URL =
  process.env.SHORT_BRASIL_SMS_SINGLE_URL ?? "http://lp01-short.painelsms.com/bot/single-sms.php";

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
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (process.env.SHORT_BRASIL_SMS_USUARIO) {
              headers.usuario = process.env.SHORT_BRASIL_SMS_USUARIO;
            }
            if (process.env.SHORT_BRASIL_SMS_CHAVE) {
              headers.chave = process.env.SHORT_BRASIL_SMS_CHAVE;
            }
            const res = await fetch(SHORT_BRASIL_SMS_URL, {
              method,
              headers,
              body:
                method === "POST"
                  ? JSON.stringify({
                      celular: "11999999999",
                      mensagem: "Diagnostico Short Brasil",
                      parceiroId: `diag-${Date.now()}`,
                    })
                  : undefined,
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
          provider: "short-brasil",
          endpoint: SHORT_BRASIL_SMS_URL,
          note: "Se o status for 0/timeout, o backend nao conseguiu conectar em lp01-short.painelsms.com. Confira host, firewall, allowlist ou endpoint alternativo com a Short Brasil.",
          attempts,
          ts: new Date().toISOString(),
        });
      },
    },
  },
});
