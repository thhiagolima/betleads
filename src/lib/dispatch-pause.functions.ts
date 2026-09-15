import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const ChannelSchema = z.enum(["sms", "email", "call"]);
export type DispatchChannel = z.infer<typeof ChannelSchema>;

export type PauseRow = {
  channel: DispatchChannel;
  paused: boolean;
  paused_at: string | null;
  reason: string | null;
};

export const getDispatchPauseState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Record<DispatchChannel, PauseRow>> => {
    const { data, error } = await context.supabase
      .from("dispatch_pause_state")
      .select("channel,paused,paused_at,reason");
    if (error) throw error;
    const base: Record<DispatchChannel, PauseRow> = {
      sms: { channel: "sms", paused: false, paused_at: null, reason: null },
      email: { channel: "email", paused: false, paused_at: null, reason: null },
      call: { channel: "call", paused: false, paused_at: null, reason: null },
    };
    for (const r of data ?? []) {
      const ch = r.channel as DispatchChannel;
      if (base[ch]) base[ch] = r as PauseRow;
    }
    return base;
  });

const SetPauseInput = z.object({
  channel: ChannelSchema,
  paused: z.boolean(),
  reason: z.string().max(500).optional(),
});

export const setDispatchPause = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SetPauseInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("dispatch_pause_state")
      .upsert(
        {
          channel: data.channel,
          paused: data.paused,
          paused_at: data.paused ? new Date().toISOString() : null,
          reason: data.reason ?? null,
        },
        { onConflict: "channel,tenant_id" },
      );
    if (error) throw error;
    return { ok: true };
  });