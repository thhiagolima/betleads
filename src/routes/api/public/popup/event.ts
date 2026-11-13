// Popups nas casas — contador de exibição, clique e fechamento. O runtime manda
// por sendBeacon com corpo text/plain (requisição simples, sem preflight). Só
// conta popup ativo da casa visto de uma origem cadastrada; o resto é ignorado
// com 204, igual a um evento aceito.
import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { popupPublicService } from "@/lib/popups/public-service.server";
import { IpRateLimiter } from "@/lib/webpush/ip-rate-limit";

const limiter = new IpRateLimiter({ limit: 600, windowMs: 60_000, maxTracked: 5_000 });
const MAX_BODY = 1_000;

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  return forwarded.split(",")[0]!.trim() || "unknown";
}

export const Route = createFileRoute("/api/public/popup/event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (limiter.hit(clientIp(request), Date.now())) return new Response(null, { status: 429 });
        const raw = await request.text().catch(() => "");
        if (raw.length > MAX_BODY) return new Response(null, { status: 413 });
        let body: { popupId?: unknown; kind?: unknown } = {};
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          return new Response(null, { status: 204 });
        }
        try {
          await popupPublicService(supabaseAdmin).recordEvent({
            token: new URL(request.url).searchParams.get("t") ?? "",
            origin: request.headers.get("origin"),
            popupId: body.popupId,
            kind: body.kind,
          });
        } catch (error) {
          console.error("[popup] event failed:", error instanceof Error ? error.message : error);
        }
        return new Response(null, { status: 204 });
      },
    },
  },
});
