-- U0 de ESCOPO_ORIGEM_UTM_2026-11-14: código de indicação entre jogadores.
-- betgreen manda `?inviteCode=` só dentro da landing; 777 manda `ref` solto. Fica numa
-- coluna própria e não em affiliate_id, que credita expert. Gravado pelo webhook
-- (webhook-process.server.ts, resolveReferralCode) só quando vazio.
-- Coluna sem default: só metadado, não reescreve players.

alter table public.players add column if not exists referral_code text;

comment on column public.players.referral_code is
  'Código de indicação do cadastro (inviteCode, ref sem afiliado). Não credita expert.';
