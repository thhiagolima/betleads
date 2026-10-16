-- Executive conversion report aggregated in the database (Central de
-- Resultados F0, D-02/D-03 in docs/ESCOPO_CENTRAL_RESULTADOS_CRM_2026-10-15.md).
--
-- The report listed origins with a PostgREST query capped at 1,000 rows, so it
-- showed exactly 1,000 sends from 2 origins and no journey at all (28,251 sends
-- from 20 origins in the same period). It also counted one send per tracked
-- link instead of per message. One row per origin, every origin in the period.

create index if not exists link_dispatches_tenant_sent_idx
  on public.link_dispatches (tenant_id, sent_at)
  where source_type in ('campaign', 'journey');

create or replace function public.conversion_report_sources(
  _tenant uuid,
  _from timestamptz,
  _to timestamptz
)
returns table (
  source_type text,
  source_id uuid,
  sent bigint,
  delivered bigint,
  sms bigint,
  email bigint,
  whatsapp bigint,
  conversions bigint,
  direct_revenue numeric,
  assisted_revenue numeric
)
language sql
stable
security definer
set search_path = public
as $$
with guard as (
  select (public.has_tenant_access(_tenant) or auth.role() = 'service_role') ok
),
messages as (
  -- One message = one log entry (or delivery key), whatever its link count.
  select d.source_type, d.source_id::uuid source_id,
         coalesce(d.message_log_id, regexp_replace(d.idempotency_key, ':[0-9]+$', '')) message_key,
         d.channel,
         bool_or(d.send_status = 'sent') is_sent,
         bool_or(d.delivery_status = 'delivered') is_delivered
  from public.link_dispatches d, guard
  where guard.ok
    and d.tenant_id = _tenant
    and d.source_type in ('campaign', 'journey')
    and d.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and d.sent_at between _from and _to
  group by 1, 2, 3, 4
),
sends as (
  select m.source_type, m.source_id,
         count(*) filter (where m.is_sent) sent,
         count(*) filter (where m.is_delivered) delivered,
         count(*) filter (where m.is_sent and m.channel = 'sms') sms,
         count(*) filter (where m.is_sent and m.channel = 'email') email,
         count(*) filter (where m.is_sent and m.channel = 'whatsapp') whatsapp
  from messages m
  group by 1, 2
),
conv as (
  select a.source_type, a.source_id,
         count(*) filter (where a.classification = 'direct') conversions,
         coalesce(sum(a.monetary_value) filter (where a.classification = 'direct'), 0) direct_revenue,
         coalesce(sum(a.monetary_value) filter (where a.classification = 'assisted'), 0) assisted_revenue
  from public.conversion_attributions a, guard
  where guard.ok
    and a.tenant_id = _tenant
    and a.event_type = 'deposit_approved'
    and a.source_type in ('campaign', 'journey')
    and a.occurred_at between _from and _to
  group by 1, 2
)
select coalesce(s.source_type, c.source_type)::text as source_type,
       coalesce(s.source_id, c.source_id) as source_id,
       coalesce(s.sent, 0) as sent,
       coalesce(s.delivered, 0) as delivered,
       coalesce(s.sms, 0) as sms,
       coalesce(s.email, 0) as email,
       coalesce(s.whatsapp, 0) as whatsapp,
       coalesce(c.conversions, 0) as conversions,
       coalesce(c.direct_revenue, 0)::numeric as direct_revenue,
       coalesce(c.assisted_revenue, 0)::numeric as assisted_revenue
from sends s
full join conv c on c.source_type = s.source_type and c.source_id = s.source_id;
$$;

revoke all on function public.conversion_report_sources(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.conversion_report_sources(uuid, timestamptz, timestamptz) to authenticated, service_role;
