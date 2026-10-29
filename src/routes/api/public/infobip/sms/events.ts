// Delivery reports of SMS sent through Infobip accounts (Fase 4 of the
// per-house providers). The notifyUrl carries ?token=; logic in
// src/lib/infobip-sms-callback.server.ts.
import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { applyInfobipSmsReports } from "@/lib/infobip-sms-callback.server";
import { infobipSmsCallbackToken } from "@/lib/infobip-sms.server";

function authorized(request: Request): boolean {
  const expected = infobipSmsCallbackToken();
  const received = new URL(request.url).searchParams.get("token");
  if (!expected || !received || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export const Route = createFileRoute("/api/public/infobip/sms/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }
        const result = await applyInfobipSmsReports(body);
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
