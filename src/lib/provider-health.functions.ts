import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type RateStateRow = {
  channel: string;
  last_provider_error: string | null;
  backoff_until: string | null;
};

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
    for (const row of (data ?? []) as RateStateRow[]) {
      const channel = row.channel;
      let err = row.last_provider_error;
      const until = row.backoff_until;
      if (!err) continue;
      const isActive = !until || new Date(until).getTime() > Date.now();
      if (!isActive) continue;
      if (channel === "sms" && /BUSINESSCODE_SMS_TOKEN/i.test(err)) {
        err =
          "SHORT_BRASIL_SMS_USUARIO/SHORT_BRASIL_SMS_CHAVE nao configurados. Reinicie o servidor apos alterar o .env.";
      }
      if (
        /401|403|unauthor|auth_error|credenciais|autenticacao|SHORT_BRASIL_SMS_USUARIO|SHORT_BRASIL_SMS_CHAVE|status=101/i.test(
          err,
        )
      ) {
        issues.push({ channel, error: err, until, kind: "auth" });
      } else if (/\b5\d{2}\b|non_json|html|timeout|ENOTFOUND|ECONNRESET/i.test(err)) {
        issues.push({
          channel,
          error: err,
          until,
          kind: "provider_down",
        });
      }
    }
    return { issues };
  });
