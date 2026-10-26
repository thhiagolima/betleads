// Scope §8 retention (PG6-03 fix wave): payment_webhook_events keeps its
// metadata forever, but raw_body and headers are nulled after 90 days.
// `billing_purge_webhook_bodies` (service_role RPC, migration 20261024100500)
// does one bounded batch; this loops a few batches per call. It runs as an
// isolated stage of the hourly billing cycle and never throws.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const WEBHOOK_BODY_RETENTION_DAYS = 90;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES = 5;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = any;

export type PurgeResult = { purged: number; batches: number; ok: boolean };

export async function purgeOldWebhookBodies(
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<PurgeResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  let purged = 0;
  let batches = 0;
  try {
    while (batches < maxBatches) {
      const { data, error } = await (supabaseAdmin as LooseDb).rpc("billing_purge_webhook_bodies", {
        _older_than_days: WEBHOOK_BODY_RETENTION_DAYS,
        _limit: batchSize,
      });
      if (error) throw new Error(error.message);
      const count = Number(data ?? 0);
      if (count > 0) {
        purged += count;
        batches += 1;
      }
      if (count < batchSize) break;
    }
    return { purged, batches, ok: true };
  } catch (error) {
    console.error("[billing-retention] webhook body purge failed", {
      error: error instanceof Error ? error.message : String(error),
      purged,
    });
    return { purged, batches, ok: false };
  }
}
