-- Temporary audiences (players picked in Jogadores → "Usar selecionados na
-- campanha") are sms_audiences rows with criteria.timing = 'selection'. They
-- pile up, so a daily job removes the ones older than 30 days that nothing
-- still needs:
-- - a draft (campaign_drafts.audience_id or audience_criteria.audienceId);
-- - an SMS campaign that has not finished (agendada, enviando, pausada): the
--   dispatcher loads the list by id at send time and fails if it is gone.
-- Finished campaigns (enviado, falhou, cancelada) keep their own send logs,
-- so their reports do not depend on the audience row.

create or replace function public.purge_stale_selection_audiences(_older_than interval default interval '30 days')
returns integer
language sql
security definer
set search_path = public
as $$
  with removed as (
    delete from public.sms_audiences a
    where a.criteria ->> 'timing' = 'selection'
      and greatest(a.created_at, a.updated_at) < now() - _older_than
      and not exists (
        select 1 from public.campaign_drafts d
        where d.tenant_id = a.tenant_id
          and (d.audience_id = a.id::text or d.audience_criteria ->> 'audienceId' = a.id::text)
      )
      and not exists (
        select 1 from public.sms_campaigns c
        where c.tenant_id = a.tenant_id
          and c.status in ('agendada', 'enviando', 'pausada')
          and c.audience_criteria ->> 'audienceId' = a.id::text
      )
    returning 1
  )
  select count(*)::integer from removed;
$$;

revoke all on function public.purge_stale_selection_audiences(interval) from public, anon, authenticated;
grant execute on function public.purge_stale_selection_audiences(interval) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'betleads-purge-selection-audiences';
    perform cron.schedule(
      'betleads-purge-selection-audiences',
      '37 4 * * *',
      $job$select public.purge_stale_selection_audiences()$job$
    );
  end if;
end;
$$;
