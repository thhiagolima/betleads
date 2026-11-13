// Popups nas casas — popups que o visitante pode ver agora, chamado pelo
// runtime do popup embutido no loader do push. Token desconhecido, origem não
// cadastrada ou casa sem popup: `{ popups: [] }` com 200 (nunca revela quais
// tokens existem). Erro de banco também devolve lista vazia, sem cache.
import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { popupPublicService } from "@/lib/popups/public-service.server";
import { IpRateLimiter } from "@/lib/webpush/ip-rate-limit";

// Many players share an IP behind mobile CGNAT; the browser caches the answer
// for 5 minutes per session, so the limit is generous.
const limiter = new IpRateLimiter({ limit: 300, windowMs: 60_000, maxTracked: 5_000 });

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  return forwarded.split(",")[0]!.trim() || "unknown";
}

function headers(origin: string | null, cacheable: boolean): Record<string, string> {
  const result: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheable ? "private, max-age=60" : "no-store",
    Vary: "Origin",
  };
  if (origin) result["Access-Control-Allow-Origin"] = origin;
  return result;
}

export const Route = createFileRoute("/api/public/popup/list")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = request.headers.get("origin");
        if (limiter.hit(clientIp(request), Date.now())) {
          return new Response(JSON.stringify({ popups: [] }), { status: 429, headers: headers(origin, false) });
        }
        const params = new URL(request.url).searchParams;
        try {
          const popups = await popupPublicService(supabaseAdmin).eligiblePopups({
            token: params.get("t") ?? "",
            origin,
            playerId: params.get("p"),
          });
          return new Response(JSON.stringify({ popups }), { status: 200, headers: headers(origin, true) });
        } catch (error) {
          console.error("[popup] eligible popups failed:", error instanceof Error ? error.message : error);
          return new Response(JSON.stringify({ popups: [] }), { status: 200, headers: headers(origin, false) });
        }
      },
    },
  },
});
