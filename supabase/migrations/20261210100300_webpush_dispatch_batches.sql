-- Web push (OneSignal) — Task 11 fix round 1 (controller ruling, see
-- .superpowers/sdd/2026-11-05-web-push-onesignal/task-11-ruling.md): a
-- persisted per-(campaign, app) batch so money (wallet_reserve/wallet_refund)
-- and the OneSignal send are resumable without a double charge or a lost
-- push.
--
-- Why: wallet_mutation (20261022100100_billing_wallet.sql:159-167) dedupes
-- FOREVER on (tenant_id, idempotency_key) — even a reservation that was
-- already refunded can never be "re-reserved" with that same key for a new
-- charge, the dedupe check runs before the refunded-or-not check — and
-- wallet_refund (same file) refunds only the NEWEST usage_reservation row
-- for a given reference_id. The original Task 11 design derived its wallet
-- key from "the current page" and, on a temporary send failure, refunded
-- and later re-reserved with that SAME key on retry: under these real
-- semantics that retry's reserve call just returns the old, already-refunded
-- reservation as `idempotent: true` — charging nothing — so the retried
-- send goes out for free.
--
-- This table makes each OneSignal call's unit of work (one app's slice of
-- one dispatch page) durable BEFORE any money moves, so a crash at any
-- point resumes the exact same batch — never a freshly re-paged one — and
-- src/lib/webpush/campaign-dispatch.server.ts's state machine can safely
-- guarantee: the initial reservation (key = batch id) is reserved at most
-- once and is never refunded by a temporary failure (it stays reserved
-- across retries); the settlement adjustment for a partially-accepted batch
-- uses its OWN, never-reused reference (`<batch id>:ajuste`), so it can
-- never collide with the (possibly already-refunded) original reservation.
--
-- ROLLBACK (manual, aditivo):
--   drop table public.webpush_dispatch_batches;

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.webpush_dispatch_batches (
  -- Also the wallet reference id (reserve/refund) and the seed of the
  -- OneSignal idempotency key (deterministicUuid(id)).
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.webpush_campaigns(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES public.tenant_webpush_apps(id),
  subscription_row_ids uuid[] NOT NULL,
  units integer NOT NULL,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'enviado', 'liquidado', 'concluido', 'falhou')),
  -- Set once the OneSignal call returns ok (status moves to 'enviado').
  accepted integer,
  refused_row_ids uuid[],
  onesignal_notification_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.webpush_dispatch_batches IS
  'One row per (campaign, app) OneSignal call of one dispatch page (Task 11 fix round 1). id doubles as the wallet reference id and the seed of the OneSignal idempotency key — every money/send step for this batch is keyed off it, never off the page it came from, so a crash-and-retry always resumes the exact same unit of work. Status machine: pendente (not yet reserved/sent) -> enviado (sent, accepted/refused known) -> liquidado (settled: fully accepted, or refund+adjustment applied) -> concluido (logs/dispatches/deactivation written); a permanent send failure goes pendente -> falhou (refunded, all rows refused) and falhou also still needs the concluido logging step.';

CREATE INDEX IF NOT EXISTS webpush_dispatch_batches_campaign_status_idx
  ON public.webpush_dispatch_batches (campaign_id, status);

-- Tabela nova: RLS ligada, sem policy — só service_role (que ignora RLS)
-- lê/escreve, como as demais tabelas de Task 1.
ALTER TABLE public.webpush_dispatch_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.webpush_dispatch_batches FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.webpush_dispatch_batches TO service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
