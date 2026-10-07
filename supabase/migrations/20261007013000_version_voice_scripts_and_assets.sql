alter table public.call_scripts
  add column if not exists version integer not null default 1 check (version > 0);

create or replace function public.bump_call_script_version()
returns trigger language plpgsql as $$
begin
  if new.content is distinct from old.content
    or new.default_voice_id is distinct from old.default_voice_id
    or new.voice_settings is distinct from old.voice_settings then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists call_scripts_bump_version on public.call_scripts;
create trigger call_scripts_bump_version before update on public.call_scripts
for each row execute function public.bump_call_script_version();

alter table public.call_queue
  add column if not exists voice_asset_id uuid references public.journey_voice_assets(id) on delete restrict;

create index if not exists call_queue_voice_asset_idx
  on public.call_queue (voice_asset_id) where voice_asset_id is not null;
