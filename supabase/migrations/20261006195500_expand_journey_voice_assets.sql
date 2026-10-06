alter table public.journey_voice_assets
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists language text not null default 'pt-BR',
  add column if not exists source text not null default 'upload' check (source in ('upload','tts','import')),
  add column if not exists is_archived boolean not null default false;

create index if not exists journey_voice_assets_tenant_active_idx
  on public.journey_voice_assets (tenant_id, is_archived, updated_at desc);
