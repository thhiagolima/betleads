// Server functions for the in-app tutorial's help progress. Both read and
// write go through `context.supabase` (the requesting user's client, not
// `supabaseAdmin`) — RLS on `help_progress` already restricts every row to
// its own `user_id`, so there's nothing for these handlers to check.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { rowsToProgressMap, type HelpProgressStatus } from "@/lib/help-progress";

export const getHelpProgress = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("help_progress")
      .select("key,status")
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { progress: rowsToProgressMap((data ?? []) as { key: string; status: string }[]) };
  });

export const setHelpProgress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z
      .object({
        key: z.string().min(1).max(200),
        status: z.enum(["done", "skipped", "off"]).nullable(),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    if (data.status === null) {
      const { error } = await context.supabase
        .from("help_progress")
        .delete()
        .eq("user_id", context.userId)
        .eq("key", data.key);
      if (error) throw new Error(error.message);
      return { ok: true };
    }

    const status: HelpProgressStatus = data.status;
    const { error } = await context.supabase.from("help_progress").upsert(
      {
        user_id: context.userId,
        key: data.key,
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,key" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
