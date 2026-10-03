-- Jobs operacionais do P1. O segredo fica no Supabase Vault, nunca na migration.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in (
      'betleads-dispatch-sms',
      'betleads-dispatch-email',
      'betleads-dispatch-call',
      'betleads-dispatch-whatsapp',
      'betleads-automation-recovery',
      'betleads-orchestrate-tenants'
    )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'betleads-dispatch-sms',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/dispatch?channel=sms',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);

select cron.schedule(
  'betleads-dispatch-email',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/dispatch?channel=email',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);

select cron.schedule(
  'betleads-dispatch-call',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/dispatch?channel=call',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);

select cron.schedule(
  'betleads-dispatch-whatsapp',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/dispatch?channel=whatsapp',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);

select cron.schedule(
  'betleads-automation-recovery',
  '*/2 * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/recovery',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $job$
);

select cron.schedule(
  'betleads-orchestrate-tenants',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := 'https://betleads.io/api/public/hooks/orchestrate?tenant=' || t.id::text,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'betleads_cron_secret' limit 1)
      ),
      body := '{}'::jsonb
    )
    from public.tenants t;
  $job$
);
