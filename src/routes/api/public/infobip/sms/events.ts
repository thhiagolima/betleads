// Delivery reports of SMS sent through Infobip accounts (Fase 4 of the
// per-house providers). The notifyUrl carries ?token= — the global token for
// platform accounts, the account's own token for a house-owned account
// (provider-callback-tokens.server.ts); logic in
// src/lib/infobip-sms-callback.server.ts.
import { createFileRoute } from "@tanstack/react-router";
import { applyInfobipSmsReports } from "@/lib/infobip-sms-callback.server";
import { infobipSmsCallbackToken } from "@/lib/infobip-sms.server";
import {
  ownedAccountIdsFor,
  resolveCallbackScope,
  touchCallbackReceived,
} from "@/lib/provider-callback-tokens.server";

export const Route = createFileRoute("/api/public/infobip/sms/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const scope = await resolveCallbackScope(
          new URL(request.url).searchParams.get("token"),
          infobipSmsCallbackToken() ?? undefined,
        );
        if (!scope) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (scope.kind === "account") await touchCallbackReceived(scope.accountId);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }
        const result = await applyInfobipSmsReports(body, {
          scope,
          ownedAccountIds: await ownedAccountIdsFor(scope),
        });
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
