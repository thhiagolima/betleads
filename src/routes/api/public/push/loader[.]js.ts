// Web push (OneSignal) — Task 8: public loader script, served from the
// house's page via <script src="/api/public/push/loader.js?t=...">. An
// unknown token or a tenant with no installable app serves a harmless no-op
// comment with 200 (never a 404 that would break the embedding page or leak
// which tokens exist).
import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildLoaderScript } from "@/lib/webpush/loader-script";

const JS_HEADERS = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "public, max-age=300",
} as const;

// A DB error is not the stable "this token/house isn't active" fact the
// 5-minute public cache is meant for — serving it with no-store means a
// transient failure gets retried on the very next load instead of being
// baked into a CDN/browser cache for 5 minutes.
const NO_STORE_HEADERS = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

const INACTIVE_SCRIPT = "/* betleads: web push inativo */";

function apiBase(): string {
  return (process.env.PUBLIC_APP_URL ?? "https://betleads.io").replace(/\/$/, "");
}

type SettingsRow = {
  tenant_id: string;
  prompt_text: string;
  accept_label: string;
  cancel_label: string;
  icon_url: string | null;
};

async function buildLoaderResponse(token: string): Promise<Response> {
  if (!token) return new Response(INACTIVE_SCRIPT, { status: 200, headers: JS_HEADERS });

  const { data: settingsData, error: settingsErr } = await supabaseAdmin
    .from("tenant_webpush_settings")
    .select("tenant_id,prompt_text,accept_label,cancel_label,icon_url")
    .eq("public_token", token)
    .maybeSingle();
  if (settingsErr) {
    console.error("[webpush loader] tenant_webpush_settings lookup failed:", settingsErr.message);
    return new Response(INACTIVE_SCRIPT, { status: 200, headers: NO_STORE_HEADERS });
  }
  if (!settingsData) return new Response(INACTIVE_SCRIPT, { status: 200, headers: JS_HEADERS });
  const settings = settingsData as SettingsRow;

  const { data: appsData, error: appsErr } = await supabaseAdmin
    .from("tenant_webpush_apps")
    .select("origin,onesignal_app_id")
    .eq("tenant_id", settings.tenant_id)
    .in("status", ["instalando", "ativo"]);
  if (appsErr) {
    console.error("[webpush loader] tenant_webpush_apps lookup failed:", appsErr.message);
    return new Response(INACTIVE_SCRIPT, { status: 200, headers: NO_STORE_HEADERS });
  }
  const apps = (appsData ?? []) as Array<{ origin: string; onesignal_app_id: string }>;
  if (apps.length === 0) return new Response(INACTIVE_SCRIPT, { status: 200, headers: JS_HEADERS });

  const script = buildLoaderScript({
    token,
    apiBase: apiBase(),
    apps: apps.map((app) => ({ origin: app.origin, appId: app.onesignal_app_id })),
    prompt: {
      promptText: settings.prompt_text,
      acceptLabel: settings.accept_label,
      cancelLabel: settings.cancel_label,
      iconUrl: settings.icon_url,
    },
  });
  return new Response(script, { status: 200, headers: JS_HEADERS });
}

export const Route = createFileRoute("/api/public/push/loader.js")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("t") ?? "";
        return buildLoaderResponse(token);
      },
    },
  },
});
