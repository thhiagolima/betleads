alter table public.email_templates
  add column if not exists lifecycle_status text not null default 'published' check (lifecycle_status in ('draft','published','archived')),
  add column if not exists version integer not null default 1 check (version > 0),
  add column if not exists published_at timestamptz;

update public.email_templates
set lifecycle_status = case when is_active then 'published' else 'archived' end,
    published_at = case when is_active then coalesce(published_at, updated_at, created_at) else published_at end;

create or replace function public.bump_email_template_version()
returns trigger language plpgsql as $$
begin
  if new.name is distinct from old.name or new.subject is distinct from old.subject
    or new.preheader is distinct from old.preheader or new.body_html is distinct from old.body_html
    or new.from_name is distinct from old.from_name or new.tags is distinct from old.tags then
    new.version := old.version + 1;
  end if;
  if new.lifecycle_status = 'published' and old.lifecycle_status is distinct from 'published' then
    new.published_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists email_templates_bump_version on public.email_templates;
create trigger email_templates_bump_version before update on public.email_templates for each row execute function public.bump_email_template_version();

alter table public.email_campaigns add column if not exists template_snapshot jsonb;
