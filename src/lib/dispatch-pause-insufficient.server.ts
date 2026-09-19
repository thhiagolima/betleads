// Helper compartilhado: detecta resposta de "sem saldo" do provedor
// (HTTP 402 ou body contendo INSUFFICIENT_FUNDS) e pausa o canal em
// dispatch_pause_state pra todos os tenants, evitando queimar leads
// como "failed" quando o motor está com saldo zero no provedor.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export function isInsufficientFunds(status: number | undefined, body: unknown): boolean {
  if (status === 402) return true;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "").slice(0, 600);
  return /INSUFFICIENT_FUNDS|insufficient.?funds|sem\s+saldo|no\s+credit/i.test(text);
}

const lastPauseAt: Record<string, number> = {};

export async function pauseChannelForInsufficientFunds(
  channel: "sms" | "email" | "call",
  providerError: string,
): Promise<void> {
  // Throttle: evita rajada de updates quando vários workers detectam ao mesmo tempo.
  const now = Date.now();
  if (lastPauseAt[channel] && now - lastPauseAt[channel] < 5_000) return;
  lastPauseAt[channel] = now;
  try {
    const provider = channel === "sms" ? "Short Brasil" : "BusinessCode";
    await supabaseAdmin
      .from("dispatch_pause_state")
      .update({
        paused: true,
        paused_at: new Date().toISOString(),
        reason: `INSUFFICIENT_FUNDS ${provider} ${channel.toUpperCase()} — ${providerError.slice(0, 200)}`,
        updated_at: new Date().toISOString(),
      })
      .eq("channel", channel);
  } catch (e) {
    console.error("[pauseChannelForInsufficientFunds] falhou", channel, e);
  }
}
