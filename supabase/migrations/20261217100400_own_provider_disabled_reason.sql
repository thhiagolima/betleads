-- Conta própria de provedor por casa — motivo da desativação e uma conta por
-- casa e canal.
-- Escopo: docs/superpowers/specs/2026-11-07-conta-propria-provedor-design.md (6.1, 7)
--
-- O QUE FAZ (aditiva)
--   * public.provider_accounts.disabled_reason: por que a conta está
--     desativada. 'platform' = o super admin desativou (só ele reativa; a
--     casa vê "Esta conta foi desativada pela BetLeads"); 'revoked' = a
--     concessão do canal foi revogada (o admin da casa reativa ao ativar de
--     novo, depois que a concessão volta). NULL = ativa, ou desativada antes
--     desta coluna existir.
--   * Índice único parcial provider_accounts (owner_tenant_id, channels[1])
--     onde owner_tenant_id is not null: no máximo uma conta própria por casa
--     e canal (a conta com dono sempre tem channels = [canal]). Dois saves
--     simultâneos da mesma casa: o segundo recebe 23505 e o app responde
--     "Já existe uma conta para este canal. Recarregue a página."
--
-- COMPATIBILIDADE / ORDEM DE DEPLOY
--   * Aplicar ANTES do app novo. O app antigo não lê nem grava
--     disabled_reason e não cria contas com dono — ignora tudo.
--   * O índice falha se já houver duas contas com dono da mesma casa no
--     mesmo canal (não há: a conta própria ainda não foi liberada para casa
--     nenhuma). Conferir antes:
--       select owner_tenant_id, channels[1], count(*) from public.provider_accounts
--       where owner_tenant_id is not null group by 1, 2 having count(*) > 1;
--
-- ROLLBACK
--   DROP INDEX IF EXISTS public.provider_accounts_owner_channel_key;
--   ALTER TABLE public.provider_accounts DROP COLUMN IF EXISTS disabled_reason;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.provider_accounts
  ADD COLUMN IF NOT EXISTS disabled_reason text NULL
    CHECK (disabled_reason IN ('platform', 'revoked'));

COMMENT ON COLUMN public.provider_accounts.disabled_reason IS
  'Motivo da desativação: platform = super admin (só ele reativa); revoked = concessão revogada (o admin da casa reativa quando a concessão volta). NULL = ativa ou desativada antes desta coluna.';

CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_owner_channel_key
  ON public.provider_accounts (owner_tenant_id, (channels[1]))
  WHERE owner_tenant_id IS NOT NULL;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
