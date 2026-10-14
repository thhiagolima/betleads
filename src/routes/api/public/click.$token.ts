import { createFileRoute } from "@tanstack/react-router";
import { resolveAndRecordFirstPartyClick } from "@/lib/click-tracking.server";

export const Route = createFileRoute("/api/public/click/$token")({
  server: {
    handlers: {
      GET: async ({ request, params }: { request: Request; params: { token: string } }) => {
        const signature = new URL(request.url).searchParams.get("s");
        try {
          const result = await resolveAndRecordFirstPartyClick({
            token: params.token,
            signature,
            request,
          });
          if (!result.ok) {
            return Response.json(
              { ok: false, error: "Link inválido ou indisponível" },
              {
                status: result.status,
                headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
              },
            );
          }
          if (result.trackingError) {
            console.error("[click redirect] click event was not persisted", {
              token: params.token,
              error: result.trackingError,
            });
          }
          return new Response(null, {
            status: 302,
            headers: {
              Location: result.destination,
              "Cache-Control": "no-store, no-cache, must-revalidate",
              "Referrer-Policy": "no-referrer",
              "X-Robots-Tag": "noindex, nofollow",
              ...(result.trackingError ? { "X-Betleads-Tracking": "degraded" } : {}),
            },
          });
        } catch (error) {
          console.error("[click redirect] tracking failed", {
            token: params.token,
            error: error instanceof Error ? error.message : String(error),
          });
          return Response.json(
            { ok: false, error: "Serviço de redirecionamento temporariamente indisponível" },
            {
              status: 503,
              headers: { "Cache-Control": "no-store", "Retry-After": "2" },
            },
          );
        }
      },
      HEAD: async ({ request, params }: { request: Request; params: { token: string } }) => {
        void request;
        void params;
        return new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
        });
      },
    },
  },
});
