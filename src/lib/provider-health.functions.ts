import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getProviderAuthHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("dispatch_rate_state")
      .select("channel, last_provider_error, backoff_until");
    const issues: {
      channel: string;
      error: string;
      until: string | null;
      kind: "auth" | "provider_down";
    }[] = [];
    for (const row of data ?? []) {
      const err = (row as any).last_provider_error as string | null;
      const until = (row as any).backoff_until as string | null;
      if (!err) continue;
      const isActive = !until || new Date(until).getTime() > Date.now();
      if (!isActive) continue;
      if (/401|403|unauthor|auth_error/i.test(err)) {
        issues.push({ channel: (row as any).channel, error: err, until, kind: "auth" });
      } else if (/\b5\d{2}\b|non_json|html|timeout|ENOTFOUND|ECONNRESET/i.test(err)) {
        issues.push({
          channel: (row as any).channel,
          error: err,
          until,
          kind: "provider_down",
        });
      }
    }
    return { issues };
  });