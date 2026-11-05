// Web push (OneSignal) — Task 9: public click redirect for a push
// notification. Always 302s: to the signed first-party click URL when the
// subscription + sent dispatch resolve, otherwise to the campaign's own URL,
// otherwise (no such campaign) to PUBLIC_APP_URL — resolveWebpushClick never
// throws, but this route still fails closed to PUBLIC_APP_URL on an
// unexpected error instead of surfacing a 500 with no redirect.
import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveWebpushClick } from "@/lib/webpush/links.server";

function publicAppUrlFallback(): string {
  return (
    process.env.PUBLIC_APP_URL ??
    process.env.VITE_PUBLIC_APP_URL ??
    "https://betleads.io"
  ).replace(/\/+$/, "");
}

const REDIRECT_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

export const Route = createFileRoute("/api/public/push/c/$campaignId/$key")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { campaignId: string; key: string } }) => {
        let destination: string;
        try {
          destination = await resolveWebpushClick(supabaseAdmin, {
            campaignId: params.campaignId,
            key: params.key,
          });
        } catch (error) {
          console.error("[webpush click redirect] resolve failed", {
            campaignId: params.campaignId,
            error: error instanceof Error ? error.message : String(error),
          });
          destination = publicAppUrlFallback();
        }
        return new Response(null, {
          status: 302,
          headers: { Location: destination, ...REDIRECT_HEADERS },
        });
      },
      // Never a tap: answered without touching the database.
      HEAD: async () => new Response(null, { status: 204, headers: REDIRECT_HEADERS }),
    },
  },
});
