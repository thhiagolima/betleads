-- Tutorial do CRM (fase 1): progresso do usuário em cada tour guiado e em
-- preferências do painel de ajuda (ex.: "Não mostrar tours automaticamente",
-- guardada com a chave `prefs:auto-tours`, ver AUTO_TOURS_OFF_KEY).
-- Uma linha por (usuário, chave); `status` é 'done', 'skipped' ou 'off'.
-- RLS: cada usuário só enxerga e grava as próprias linhas.

create table public.help_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 200),
  status text not null check (status in ('done', 'skipped', 'off')),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.help_progress enable row level security;

create policy help_progress_select on public.help_progress
  for select
  using (user_id = (select auth.uid()));

create policy help_progress_insert on public.help_progress
  for insert
  with check (user_id = (select auth.uid()));

create policy help_progress_update on public.help_progress
  for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy help_progress_delete on public.help_progress
  for delete
  using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.help_progress to authenticated;

notify pgrst, 'reload schema';
