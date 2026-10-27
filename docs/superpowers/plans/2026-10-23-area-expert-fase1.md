# Área do Expert — Fase 1 (papel, acesso, cadastro, aposentadoria do CRM_EXPERT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um expert convidado pelo admin entra no CRM da casa, vê só o menu dele e só os leads que pode ver (restrito: pelos IDs de afiliado dele; total: todos os da casa). O admin cadastra, configura, convida, ativa e desativa experts. O modelo de casa CRM_EXPERT é aposentado.

**Architecture:** O expert recebe o novo valor `expert` de `app_role` em `user_roles` (uma linha por casa). O acesso é **negado por padrão**: as funções de associação existentes (`current_tenant_id`, `has_tenant_access`, `accessible_tenant_ids`) **não** passam a incluir `expert`. Por isso todas as políticas atuais continuam negando tudo a ele. Políticas novas e explícitas liberam só `players`, `deposits` e `withdrawals` (filtrados por tipo de expert) e o próprio registro em `experts`/`expert_affiliates`. A tabela `experts` vira a entidade "pessoa" e os IDs de afiliado vão para uma tabela filha `expert_affiliates`, única por casa. As escritas do admin passam por server functions com guard de admin e funções SQL atômicas restritas ao service_role.

**Tech Stack:** TanStack Start (createServerFn + zod), React, Supabase Postgres (RLS, plpgsql), Vitest + PGlite.

**Spec:** `docs/superpowers/specs/2026-10-23-area-expert-design.md` (seções 4 e 9; ordem de entrega item 1)

## Fatos de produção que moldam este plano (consulta só leitura, 2026-10-23)

- A casa CRM_EXPERT `b1e75a01-9b40-4e30-9d4a-7c5f6f3d1a01` ("CRM Expert - Alisson Kevin Queiroz") tem **0 usuários, 0 fluxos e 0 jogadores**. Não há fluxos para recriar nem pessoa para migrar. A aposentadoria é: arquivar a casa e desligar o espelhamento.
- As 4 linhas atuais de `experts` (Andrade ×2, Queiroz ×2) estão na casa "BetLeads Original" (`0000…0001`), que tem 0 jogadores. Elas viram 2 experts "sem acesso".
- As casas reais têm IDs de afiliado nos jogadores (Sorte Alta: 4 distintos, PixReals: 5, ForrandoBet: 2), mas nenhum está cadastrado como expert. Por isso a tela do admin sugere os "IDs de afiliado sem expert".
- `user_roles` em produção só usa `super_admin`, `admin`, `gestor` e `member`.

## Global Constraints

- Todo texto de interface e mensagem de erro para o usuário em pt-BR.
- Migrations com timestamp ≥ `20261025100000`, formato `YYYYMMDDHHMMSS_snake_name.sql`. O novo valor de enum vai numa migration própria, antes de qualquer uso (padrão de `20261003091500_add_gestor_app_role.sql`).
- Funções SQL novas `SECURITY DEFINER` com `SET search_path = public, pg_temp`. As que escrevem dados: `REVOKE ALL ... FROM public, anon, authenticated` e `GRANT EXECUTE ... TO service_role`.
- As funções `current_tenant_id`, `has_tenant_access`, `accessible_tenant_ids` e `managed_tenant_ids` **não podem** passar a aceitar `expert`.
- Escritas do admin só via server functions: guard `requireTenantAdmin(...)` → `assertTenantNotDemo(...)` → `supabaseAdmin`. Seguir o padrão `fooFor(ctx, data)` exportado para teste, como `addUserToTenantFor`.
- Tipos de expert: `restrito` | `total`. Modo de envio: `livre` | `aprovacao`. Prazo de "assumir": padrão 3 dias, entre 1 e 30. Teto: R$ por mês, `null` = sem teto. (Modo, teto e prazo só são guardados nesta fase; quem os usa são as fases 2 e 4.)
- ID de afiliado: único por casa, comparado após `btrim`, sensível a maiúsculas e minúsculas (os IDs são hex).
- Nenhuma escrita em produção sem autorização explícita da usuária no momento (Task 10).
- Não editar `supabase/functions/ai-player-insights` (não há como fazer deploy de edge function desta máquina). Ela só lê `experts.nome` e continua funcionando.
- Verificação final: `npm run typecheck`, `npm run lint`, `npm test` e `npm run build` passam.

## Review Focus

1. **Expert chamando server functions da casa diretamente** (lista de jogadores, envio de SMS, dashboards): deve receber erro ou nada, nunca dados da casa. Isso se garante porque `current_tenant_id()` é `null`, `has_tenant_access()` é `false` e `accessible_tenant_ids()` é vazio para ele. Teste na Task 2.
2. **Expert com cabeçalho `x-active-tenant` de outra casa** onde não é expert: não vê nada dessa casa. Teste na Task 2.
3. **Expert desativado com sessão aberta:** perde as linhas na hora, na próxima consulta. Teste na Task 2.
4. **Expert restrito sem nenhum ID de afiliado:** vê zero leads, não todos. Testes nas Tasks 2 e 5.
5. **Convidar um e-mail que já é admin, gestor ou membro da casa:** é recusado com mensagem clara (um papel por casa). Teste na Task 6.

---

### Task 1: Modelo de dados do expert (enum, `experts`, `expert_affiliates`, funções de escrita)

**Files:**
- Create: `supabase/migrations/20261025100000_add_expert_app_role.sql`
- Create: `supabase/migrations/20261025100100_expert_model.sql`
- Test: `src/lib/expert-model.db.test.ts`

**Interfaces:**
- Produces (SQL):
  - Enum `app_role` ganha `'expert'`. O CHECK de `user_roles` (o criado em `20261003101500_lock_tenant_role_contract.sql`; trocar mantendo o mesmo nome) passa a aceitar `role IN ('admin','gestor','member','expert') AND tenant_id IS NOT NULL`.
  - `experts` ganha estas colunas:
    - `user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL`
    - `tipo text NOT NULL DEFAULT 'restrito' CHECK (tipo IN ('restrito','total'))`
    - `ativo boolean NOT NULL DEFAULT true`
    - `envio_modo text NOT NULL DEFAULT 'livre' CHECK (envio_modo IN ('livre','aprovacao'))`
    - `teto_mensal numeric(12,2) NULL CHECK (teto_mensal >= 0)`
    - `assumir_prazo_dias integer NOT NULL DEFAULT 3 CHECK (assumir_prazo_dias BETWEEN 1 AND 30)`
    - `updated_at timestamptz NOT NULL DEFAULT now()`
  - Mudanças nas restrições de `experts`:
    - `affiliate_id` passa a aceitar NULL e é descontinuado (comment), e cai o UNIQUE global `experts_affiliate_id_key`.
    - Índices únicos: `experts_tenant_nome_uniq (tenant_id, lower(btrim(nome)))` e `experts_tenant_user_uniq (tenant_id, user_id) WHERE user_id IS NOT NULL`.
  - Tabela `expert_affiliates`:
    - Colunas: `id uuid PK`, `tenant_id uuid NOT NULL → tenants ON DELETE CASCADE`, `expert_id uuid NOT NULL → experts ON DELETE CASCADE`, `affiliate_id text NOT NULL CHECK (affiliate_id = btrim(affiliate_id) AND affiliate_id <> '')`, `created_at`, `UNIQUE (tenant_id, affiliate_id)`.
    - Índice em `expert_id`.
    - RLS ligada, com a política `expert_affiliates_tenant_rls FOR ALL TO authenticated USING/WITH CHECK (is_super_admin() OR tenant_id = current_tenant_id())`.
    - Trigger que rejeita uma linha cujo `tenant_id` difere do `experts.tenant_id` do `expert_id`.
  - `save_expert(_tenant uuid, _expert_id uuid, _nome text, _tipo text, _affiliate_ids text[], _envio_modo text, _teto_mensal numeric, _assumir_prazo_dias int) RETURNS uuid`:
    - `_expert_id` NULL cria; senão atualiza, e `RAISE 'expert_not_found'` se o expert não for daquela casa.
    - Normaliza os IDs (btrim, remove vazios, distinct) e substitui o conjunto de afiliados do expert.
    - `RAISE EXCEPTION 'affiliate_taken:%'` (com o ID) se algum ID já pertence a outro expert da casa.
    - Atualiza o rótulo `players.expert`: com o nome atual onde `tenant_id=_tenant AND affiliate_id = ANY(ids)`; com NULL onde `tenant_id=_tenant AND expert = <nome antigo ou atual> AND affiliate_id <> ALL(ids)`.
  - `delete_expert(_tenant uuid, _expert_id uuid) RETURNS void`:
    - `RAISE 'expert_has_user'` se `user_id` não for NULL.
    - Limpa o rótulo `players.expert` dos IDs dele na casa e apaga o expert.
  - `tenant_unassigned_affiliate_ids(_tenant uuid, _limit int DEFAULT 20) RETURNS TABLE(affiliate_id text, leads bigint)`: os `players.affiliate_id` distintos (btrim, não vazios) da casa que não estão em `expert_affiliates`, ordenados por `leads DESC`.
  - As três funções acima são só para service_role.
  - Backfill dentro da migration:
    - Agrupa `experts` por `(tenant_id, lower(btrim(nome)))`. O canônico é o de menor `created_at` (desempate pelo menor `id`).
    - Insere todo `affiliate_id` não nulo do grupo em `expert_affiliates` apontando para o canônico.
    - Apaga os não canônicos e põe `affiliate_id = NULL` no canônico.
    - Tudo isso antes de criar `experts_tenant_nome_uniq`.

- [ ] **Step 1: Write the failing test** `src/lib/expert-model.db.test.ts` (PGlite, mesmo estilo de `src/lib/house-config.db.test.ts`)

  O schema mínimo do teste tem:
  - roles anon/authenticated/service_role e stub de `auth.users`;
  - `app_role` com `('admin','user','super_admin','owner','member','gestor')`;
  - `user_roles` com o CHECK de `20261003101500`;
  - `tenants`;
  - `players(id, tenant_id, affiliate_id, expert)`;
  - `experts` no formato legado (`affiliate_id NOT NULL` com a constraint `experts_affiliate_id_key UNIQUE`, `nome`, `tenant_id`, `created_at`);
  - stubs `is_super_admin()` → false e `current_tenant_id()` → null.

  Antes das migrations, o teste semeia, na casa A, os experts legados `('Queiroz','AFF1')`, `('Queiroz','AFF2')` e `('Andrade','AFF3')`. Depois executa as duas migrations.

  Asserts:
  - `it("backfill merges legacy rows per name into one expert with all affiliate ids")`: 2 linhas em `experts` na casa A; `expert_affiliates` de Queiroz = `{AFF1,AFF2}`; `experts.affiliate_id` todos NULL.
  - `it("accepts role expert with tenant and rejects expert without tenant")`: inserir `('expert', tenant A)` em `user_roles` funciona; `('expert', NULL)` viola o CHECK.
  - `it("save_expert trims and dedupes ids and labels matching players")`: `save_expert(A, null, 'Marina', 'total', ARRAY[' AFF9','AFF9',''], 'aprovacao', 500, 5)` → `expert_affiliates` = `{AFF9}`; o jogador da casa A com `affiliate_id='AFF9'` fica com `expert='Marina'`; o jogador da casa B com `AFF9` não muda.
  - `it("save_expert rejects an affiliate id owned by another expert of the same house")`: salvar Marina com `AFF1` → erro com mensagem que contém `affiliate_taken:AFF1`.
  - `it("same affiliate id is allowed in two different houses")`: expert da casa B com `AFF1` → ok.
  - `it("removing an affiliate id clears that player's label")`: Queiroz salvo só com `{AFF1}` → jogador de `AFF2` fica com `expert` NULL.
  - `it("delete_expert refuses an expert with a user")` e `it("delete_expert clears labels and deletes")`.
  - `it("tenant_unassigned_affiliate_ids lists only ids without expert, by lead count")`.
  - `it("expert_affiliates rejects a row whose tenant differs from the expert's")`.
  - `it("authenticated cannot execute save_expert")`: `SET ROLE authenticated; select save_expert(...)` → permission denied.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/lib/expert-model.db.test.ts`
  Expected: FAIL (arquivos de migration inexistentes, ENOENT)

- [ ] **Step 3: Write the two migrations** com o conteúdo definido no bloco Interfaces. A primeira contém só `ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'expert';`.

- [ ] **Step 4: Run test to verify it passes**

  Run: `npx vitest run src/lib/expert-model.db.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261025100000_add_expert_app_role.sql supabase/migrations/20261025100100_expert_model.sql src/lib/expert-model.db.test.ts
git commit -m "feat(expert): expert role, experts entity and per-house affiliate ids"
```

---

### Task 2: RLS do expert (negar por padrão + liberar leads por tipo)

**Files:**
- Create: `supabase/migrations/20261025100200_expert_rls.sql`
- Test: `src/lib/expert-rls.db.test.ts`

**Interfaces:**
- Consumes: Task 1 (`experts.user_id/tipo/ativo`, `expert_affiliates`, role `expert`).
- Produces (SQL, todas `STABLE SECURITY DEFINER`, `GRANT EXECUTE TO authenticated`):
  - `expert_tenant_ids() RETURNS uuid[]`: casas em que `auth.uid()` tem linha `user_roles.role='expert'` **e** um registro `experts` com `user_id = auth.uid() AND ativo`.
  - `current_expert_tenant_id() RETURNS uuid`:
    - Usa o `x-active-tenant` de `request.headers`, lido como em `current_tenant_id()` (`20261003100000_active_tenant_request_context.sql`), se ele estiver em `expert_tenant_ids()`.
    - Sem esse cabeçalho, devolve a primeira casa em ordem de `tenant_id`.
    - Se houver cabeçalho e ele não for uma casa do expert, devolve NULL.
  - `expert_can_see_player(_tenant uuid, _affiliate_id text) RETURNS boolean`: verdadeiro se existe um expert ativo de `auth.uid()` em `_tenant` com `tipo='total'`, ou com `btrim(_affiliate_id)` em `expert_affiliates` dele.
- Políticas novas (PERMISSIVE, `FOR SELECT TO authenticated`):
  - `players_expert_select ON players USING (tenant_id = (select current_expert_tenant_id()) AND expert_can_see_player(tenant_id, affiliate_id))`
  - `deposits_expert_select` e `withdrawals_expert_select`: `USING (EXISTS (SELECT 1 FROM players p WHERE p.id = player_id))`. Esse EXISTS herda a RLS de `players`.
  - `experts_expert_select_own ON experts USING (user_id = auth.uid())`
  - `expert_affiliates_expert_select_own USING (expert_id IN (SELECT id FROM experts WHERE user_id = auth.uid()))`
- **Nenhuma** alteração em `current_tenant_id`, `has_tenant_access`, `accessible_tenant_ids` ou `managed_tenant_ids`.

- [ ] **Step 1: Write the failing test** `src/lib/expert-rls.db.test.ts`

  O schema do teste:
  - Copia **literalmente** as definições mais novas de `is_super_admin` (`20260609200834`), `has_tenant_access` (`20261003093000`), `current_tenant_id` (`20261003100000`) e `accessible_tenant_ids` (`20261015090000`). Copiar o corpo exato num comentário-guia, para o teste provar que o expert fica de fora dessas funções.
  - Cria `players`, `deposits` e `withdrawals` com as políticas atuais (`players_tenant_rls`, `deposits_tenant_select`, `withdrawals_tenant_select`, com as mesmas expressões da produção) e uma tabela representativa da casa, `sms_campaigns`, com política `is_super_admin() OR tenant_id = current_tenant_id()`.
  - Executa as migrations das Tasks 1 e 2.
  - Simula o JWT com `set_config('request.jwt.claims', ...)` e o cabeçalho com `set_config('request.headers', '{"x-active-tenant":"..."}')`.

  Personas:
  - `admin_A`;
  - `restrito_A`, com `AFF1`;
  - `total_A`;
  - `restrito_vazio_A`, sem IDs;
  - `inativo_A`, com `AFF1` e `ativo=false`.

  Dados: casa A com jogadores `AFF1` (1), `AFF2` (1) e sem afiliado (1), mais 1 depósito para cada; casa B com jogador `AFF1` (1).

  Asserts:
  - `it("restricted expert sees only players of own affiliate ids")`: `restrito_A` → 1 jogador (o de `AFF1` da casa A) e 1 depósito.
  - `it("total expert sees all players of the house and none of other houses")`: `total_A` → 3 jogadores, todos da casa A.
  - `it("restricted expert without ids sees no players")`: `restrito_vazio_A` → 0.
  - `it("deactivated expert sees nothing")`: `inativo_A` → 0 jogadores e 0 depósitos.
  - `it("expert is outside house membership")`: para `total_A`, `current_tenant_id()` é NULL, `has_tenant_access(A)` é false, `accessible_tenant_ids()` é `{}` e `sms_campaigns` → 0 linhas.
  - `it("expert with x-active-tenant of another house sees nothing")`: `total_A` com cabeçalho B → 0 jogadores.
  - `it("admin of the house still sees all players")`: `admin_A` → 3 (regressão).
  - `it("expert sees own experts row only")`: `restrito_A` lê 1 linha em `experts`.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/lib/expert-rls.db.test.ts`
  Expected: FAIL (migration inexistente)

- [ ] **Step 3: Write `20261025100200_expert_rls.sql`** com as funções e políticas do bloco Interfaces.

- [ ] **Step 4: Run test to verify it passes**

  Run: `npx vitest run src/lib/expert-rls.db.test.ts src/lib/expert-model.db.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261025100200_expert_rls.sql src/lib/expert-rls.db.test.ts
git commit -m "feat(expert): deny-by-default RLS granting experts only their visible leads"
```

---

### Task 3: Aposentar o CRM_EXPERT

**Files:**
- Create: `supabase/migrations/20261025100300_retire_crm_expert.sql`
- Modify: `src/lib/webhook-process.server.ts:14-52` (remover `DEFAULT_EXPERT_SOURCE_TENANT_ID`, `ExpertTenantRow`, `expertMirrorTargets`), `:59` (remover a opção `mirror`), `:1020-1101` (remover o bloco de espelhamento)
- Modify: todos os chamadores que passam `{ mirror: false }` (`grep -rn "mirror:" src`)
- Modify: `src/lib/tenants.functions.ts:78` e o handler de `updateTenantSettings`
- Modify: `src/routes/tenants.tsx:1251-1269`
- Delete: `src/lib/webhook-expert-mirror.test.ts`
- Modify: `src/lib/demo-inbound.test.ts:150-196` (remover o describe "CRM Expert mirror excludes demo tenants")
- Test: `src/lib/retire-crm-expert.db.test.ts` e `src/lib/tenants-crm-model.test.ts`

**Interfaces:**
- Consumes: Task 1 (`expert_affiliates`, `save_expert`).
- Produces:
  - Migration: para cada casa `crm_model='CRM_EXPERT' AND NOT is_demo`:
    - A casa de origem é `metadata->>'source_tenant_id'`, ou `'00000000-0000-0000-0000-000000000001'`.
    - Cada ID de `metadata->'expert_affiliate_ids'` que ainda não existe em `expert_affiliates` da casa de origem é ligado a um expert de nome `regexp_replace(t.nome, '^CRM Expert - ', '')`, reaproveitando o expert desse nome se já existir.
    - A casa fica com `status='canceled'` e `metadata || {"archived_at": now(), "archived_reason": "crm_expert_retired"}`.
    - Os fluxos dela ficam inativos: `sms_flows.is_active=false`, `email_flows.active=false`, `call_flows.is_active=false`.
    - Os guards existentes do webhook, do orquestrador e do cashback que olham `CRM_EXPERT` continuam como estão: eles mantêm a casa arquivada inerte.
  - `updateTenantSettings`: mudar `crm_model` **para** `CRM_EXPERT` numa casa que não é CRM_EXPERT → erro `"O modelo CRM Expert foi descontinuado. Cadastre experts dentro da casa, em Experts."`. Manter o valor atual é permitido. Na criação de casa, o enum aceita só `CRM_PLATAFORMA`.
  - `tenants.tsx`: o item `CRM_EXPERT` do Select só aparece quando o valor atual já é `CRM_EXPERT`, e nesse caso aparece desabilitado com o rótulo "CRM Expert (descontinuado)".

- [ ] **Step 1: Write the failing tests**
  - `retire-crm-expert.db.test.ts` (PGlite; schema mínimo de `tenants(id,nome,status,crm_model,metadata,is_demo)`, fluxos e o schema da Task 1):
    - `it("archives non-demo CRM_EXPERT houses and deactivates their flows")`;
    - `it("links metadata affiliate ids to an expert in the source house without duplicating existing ones")` (a casa de origem já tem Queiroz com `AFF1`; a metadata traz `AFF1,AFF2`; resultado: Queiroz com `{AFF1,AFF2}` e um único expert);
    - `it("leaves demo CRM_EXPERT houses untouched")`.
  - `tenants-crm-model.test.ts` (estilo de `src/lib/tenants-plan-reason.test.ts`, com mocks): `it("refuses switching a house to CRM_EXPERT")` (mensagem exata acima) e `it("keeps CRM_EXPERT when it is already the current model")`.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/lib/retire-crm-expert.db.test.ts src/lib/tenants-crm-model.test.ts`
  Expected: FAIL

- [ ] **Step 3: Write the migration, the `updateTenantSettings` guard and the `tenants.tsx` change; remove the mirror code, its option and the two obsolete tests**

- [ ] **Step 4: Run the tests and the webhook suites**

  Run: `npx vitest run src/lib/retire-crm-expert.db.test.ts src/lib/tenants-crm-model.test.ts src/lib/demo-inbound.test.ts && npm run typecheck`
  Expected: PASS, sem erros de tipo

- [ ] **Step 5: Commit**

```bash
git add -A supabase/migrations/20261025100300_retire_crm_expert.sql src/lib src/routes/tenants.tsx
git commit -m "feat(expert): retire CRM_EXPERT houses and the webhook mirror"
```

---

### Task 4: Webhook rotula o lead pelo `expert_affiliates`

**Files:**
- Create: `src/lib/expert-lookup.server.ts`
- Modify: `src/lib/webhook-process.server.ts:161-170` (trocar a consulta `experts.affiliate_id` pela nova função)
- Test: `src/lib/expert-lookup.server.test.ts`

**Interfaces:**
- Consumes: Task 1 (`expert_affiliates`).
- Produces: `lookupExpertName(sb: SupabaseLike, tenantId: string, affiliateId: string | null): Promise<string | null>`:
  - `affiliateId` nulo ou vazio após `trim()` → `null`, sem consulta;
  - senão, `from("expert_affiliates").select("experts(nome)").eq("tenant_id", tenantId).eq("affiliate_id", affiliateId.trim()).maybeSingle()` → `experts.nome` ou `null`;
  - erro de consulta → `null`, com `console.warn`, porque o rótulo nunca deve derrubar o webhook.
  - O rótulo vale mesmo com o expert inativo.

- [ ] **Step 1: Write the failing test** `expert-lookup.server.test.ts`, com um fake `sb` que registra os filtros:
  - `it("returns null without querying for empty affiliate id")`;
  - `it("trims the affiliate id and scopes by tenant")` (asserta os filtros `tenant_id` e `affiliate_id='AFF1'` para a entrada `' AFF1 '`);
  - `it("returns the expert name")`;
  - `it("returns null on query error")`.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/lib/expert-lookup.server.test.ts`
  Expected: FAIL (módulo inexistente)

- [ ] **Step 3: Implement `lookupExpertName` and use it in `webhook-process.server.ts`**

- [ ] **Step 4: Run tests**

  Run: `npx vitest run src/lib/expert-lookup.server.test.ts src/lib/demo-inbound.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/expert-lookup.server.ts src/lib/expert-lookup.server.test.ts src/lib/webhook-process.server.ts
git commit -m "feat(expert): webhook labels leads via per-house expert affiliate ids"
```

---

### Task 5: Contexto do expert e server functions do expert

**Files:**
- Create: `src/lib/expert-access.server.ts`
- Create: `src/lib/expert-leads.ts` (puro)
- Create: `src/lib/expert-leads.functions.ts`
- Test: `src/lib/expert-access.server.test.ts`, `src/lib/expert-leads.test.ts`, `src/lib/expert-leads.functions.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `export type ExpertTipo = "restrito" | "total";`
  - `export type ExpertContext = { tenantId: string; tenantNome: string; expertId: string; nome: string; tipo: ExpertTipo; affiliateIds: string[] };`
  - `export class ExpertAccessError extends Error {}`
  - `resolveExpertContext(userId: string, requestedTenantId?: string | null): Promise<ExpertContext | null>` (supabaseAdmin):
    - lê as linhas `user_roles` com `role='expert'` do usuário e os `experts` ativos com `user_id=userId` nessas casas;
    - escolhe `requestedTenantId` se for uma delas, senão a primeira por `tenant_id`;
    - se `requestedTenantId` for informado e não for casa do expert → `null`.
  - `requireExpertContext(userId, requestedTenantId?): Promise<ExpertContext>`:
    - `null` → `ExpertAccessError("Acesso de expert não encontrado ou desativado.")`;
    - casa com status `suspended`/`canceled` (usar `assertTenantCanOperate` de `tenant-access.server.ts`) → `ExpertAccessError("Esta casa está indisponível no momento.")`.
  - `diasSemDepositar(ultimoDeposito: string | null, now: Date): number | null`: dias inteiros desde o último depósito (arredondado para baixo), ou `null` sem depósito.
  - `export type ExpertLeadRow = { id: string; nome: string; telefone: string | null; totalDepositado: number; ultimoDeposito: string | null; diasSemDepositar: number | null; risco: string; vip: boolean };`
  - `getExpertHome` (createServerFn GET, `requireSupabaseAuth`) → `{ nome, tipo, tenantNome, totalLeads: number }`.
  - `listExpertLeads` (createServerFn POST), entrada `{ search?: string (máx. 80), page: int ≥ 0 }`, tamanho de página fixo 50 → `{ rows: ExpertLeadRow[]; total: number }`. Exportar `listExpertLeadsFor(ctx, data)` para teste.
    - Consulta com o **cliente do usuário** (`ctx.supabase`, sujeito a RLS e com o cabeçalho de casa ativa).
    - Seleciona só `id,nome,telefone,total_depositado,ultimo_deposito,risco,vip`, com `.eq("tenant_id", ctx.tenantId)`.
    - Se `tipo='restrito'`, também `.in("affiliate_id", affiliateIds)`. Com `affiliateIds` vazio, devolve `{ rows: [], total: 0 }` sem consultar.
    - `search` faz `ilike` em `nome`, e também em `telefone` quando a busca tem dígitos.
    - Ordem `total_depositado DESC`; `count: "exact"`.

- [ ] **Step 1: Write the failing tests**
  - `expert-leads.test.ts`: `diasSemDepositar(null, now)` → `null`; 3 dias e 5 horas atrás → `3`; mesmo dia → `0`.
  - `expert-access.server.test.ts` (mock de `supabaseAdmin`):
    - `it("returns null for a user without expert role")`;
    - `it("ignores inactive experts")`;
    - `it("picks the requested house when the user is expert there")`;
    - `it("returns null when the requested house is not one of the expert's")`;
    - `it("requireExpertContext throws ExpertAccessError with pt-BR message")`.
  - `expert-leads.functions.test.ts` (ctx fake com o builder do supabase registrando chamadas):
    - `it("restricted expert query filters by tenant and affiliate ids")`;
    - `it("restricted expert without ids returns empty without querying")`;
    - `it("total expert query filters only by tenant")`;
    - `it("never selects cpf, email or balances")` (asserta a string exata do select).

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/lib/expert-leads.test.ts src/lib/expert-access.server.test.ts src/lib/expert-leads.functions.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement the three modules**

- [ ] **Step 4: Run tests to verify they pass**

  Run: o mesmo comando
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/expert-access.server.ts src/lib/expert-leads.ts src/lib/expert-leads.functions.ts src/lib/expert-*.test.ts
git commit -m "feat(expert): expert context resolution and expert lead list"
```

---

### Task 6: Server functions do admin para experts + proteção na equipe

**Files:**
- Create: `src/lib/experts-admin.functions.ts`
- Modify: `src/lib/tenants.functions.ts` (`addUserToTenantFor` ~:810-900, `updateTenantUserRole` ~:918, `removeUserFromTenant` ~:990; extrair para uma função compartilhada a parte "achar ou convidar usuário por e-mail" de `addUserToTenantFor`)
- Test: `src/lib/experts-admin.functions.test.ts`, `src/lib/tenants-expert-guard.test.ts`

**Interfaces:**
- Consumes: Task 1 (`save_expert`, `delete_expert`, `tenant_unassigned_affiliate_ids`) e `requireTenantAdmin`, `assertTenantNotDemo`, `resolveOperationalTenantForRequest` e `auditTenant`.
- Produces:
  - Função extraída: `findOrInviteUserByEmail(email: string, opts: { invitedBy: string; tenantId: string }): Promise<{ userId: string; created: boolean }>`, usada por `addUserToTenantFor` e `inviteExpertFor`. Ela mantém o comportamento atual: usuário existente é reaproveitado; sem usuário, `inviteUserByEmail` com `data: { invited_by, tenant_id }`.
  - `export type ExpertAcesso = "sem_acesso" | "convite_pendente" | "ativo" | "inativo";` As regras, nesta ordem:
    - `user_id` nulo → `sem_acesso`;
    - `ativo=false` → `inativo`;
    - usuário sem `last_sign_in_at` → `convite_pendente`;
    - senão → `ativo`.
  - `export type ExpertAdminRow = { id; nome; tipo: ExpertTipo; ativo: boolean; envioModo: "livre" | "aprovacao"; tetoMensal: number | null; assumirPrazoDias: number; affiliateIds: string[]; leads: number; acesso: ExpertAcesso; email: string | null; createdAt: string };`
  - Server functions (cada uma com uma variante `…For(ctx, data)` exportada). Guard comum: casa via `resolveOperationalTenantForRequest(ctx.supabase, ctx.userId, ctx.activeTenantId)` e depois `requireTenantAdmin(ctx.supabase, tenantId, "Apenas o admin da casa gerencia experts.")`. As de escrita também chamam `assertTenantNotDemo` e gravam auditoria com `auditTenant` (`expert.saved`, `expert.invited`, `expert.access_removed`, `expert.activated`, `expert.deactivated`, `expert.deleted`).
    - `listExperts()` → `ExpertAdminRow[]`. `leads` vem de uma contagem `head` por expert: `total` = todos os jogadores da casa; `restrito` = `.in("affiliate_id", ids)`; restrito sem IDs = 0.
    - `listUnassignedAffiliates()` → `{ affiliateId: string; leads: number }[]`, via `tenant_unassigned_affiliate_ids`.
    - `saveExpert({ id?: uuid; nome: string 2..80; tipo; affiliateIds: string[] (máx. 20, cada um 1..64); envioModo; tetoMensal: number | null (≥0); assumirPrazoDias: int 1..30 })` → `{ id }`. Mapeamento de erros:
      - `affiliate_taken:X` → `"O ID de afiliado X já pertence a outro expert desta casa."`
      - `23505` em `experts_tenant_nome_uniq` → `"Já existe um expert com esse nome nesta casa."`
      - `expert_not_found` → `"Expert não encontrado."`
    - `inviteExpert({ expertId; email })`:
      - expert com `user_id` já preenchido → `"Este expert já tem acesso. Remova o acesso antes de convidar outra pessoa."`;
      - e-mail de super admin → `"Este e-mail é de um super admin."`;
      - usuário já com papel nesta casa → `"Este e-mail já tem acesso a esta casa como {Admin|Gestor|Membro|Expert}. Uma pessoa não pode ter dois papéis na mesma casa."`;
      - fora isso: `findOrInviteUserByEmail`, insere `user_roles(user_id, tenant_id, 'expert')` e grava `experts.user_id`.
    - `removeExpertAccess({ expertId })`: apaga a linha `user_roles` `expert` daquela casa e grava `user_id = NULL`.
    - `setExpertActive({ expertId; ativo: boolean })`.
    - `deleteExpert({ expertId })`: `expert_has_user` → `"Remova o acesso do expert antes de excluir."`
  - Proteção na equipe (`tenants.functions.ts`): `addUserToTenantFor` com usuário que já é `expert` na casa, e `updateTenantUserRole`/`removeUserFromTenant` quando o papel atual é `expert` → erro `"Esta pessoa é expert desta casa. Gerencie o acesso dela em Experts."`

- [ ] **Step 1: Write the failing tests** (mocks no estilo de `src/lib/tenant-admin-guard.test.ts`)
  - `experts-admin.functions.test.ts`:
    - `it("refuses non-admin callers")` (mensagem exata);
    - `it("maps affiliate_taken to the pt-BR message")`;
    - `it("maps duplicate name to the pt-BR message")`;
    - `it("invite refuses an email that already has a role in the house")` (mensagem com "como Gestor");
    - `it("invite refuses a super admin email")`;
    - `it("invite inserts expert role and links user_id")`;
    - `it("acesso is convite_pendente before first sign-in and inativo when deactivated")`;
    - `it("delete refuses expert with user")`;
    - `it("writes refuse demo houses")`.
  - `tenants-expert-guard.test.ts`: `it("team role change refuses an expert member")`, `it("team removal refuses an expert member")` e `it("adding an existing expert as member is refused")`.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/lib/experts-admin.functions.test.ts src/lib/tenants-expert-guard.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement `experts-admin.functions.ts`, extract `findOrInviteUserByEmail`, add the team guards**

- [ ] **Step 4: Run tests (incluindo as suítes existentes de tenants)**

  Run: `npx vitest run src/lib/experts-admin.functions.test.ts src/lib/tenants-expert-guard.test.ts src/lib/tenant-admin-guard.test.ts src/lib/tenants-*.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/experts-admin.functions.ts src/lib/tenants.functions.ts src/lib/experts-admin.functions.test.ts src/lib/tenants-expert-guard.test.ts
git commit -m "feat(expert): admin server functions to configure, invite and deactivate experts"
```

---

### Task 7: Navegação e shell do expert

**Files:**
- Modify: `src/lib/navigation.ts` (`ShellRole` :33, `SIDEBAR_SECTIONS`, `ROUTE_META`, `canSee`/`visibleSections`, mobile tabs, comentário do cabeçalho :27-29)
- Modify: `src/components/app-layout.tsx` (redirecionamento), `src/components/shell/account-menu.tsx` e `src/components/shell/mobile-nav.tsx` se lerem as seções diretamente
- Modify: `src/hooks/use-active-tenant.ts` (o tipo de `role` aceita `"expert"`)
- Test: `src/lib/navigation.test.ts`

**Interfaces:**
- Consumes: `getTenantSwitcherFor` já devolve o papel cru de `user_roles` por casa, então `"expert"` chega sem mudanças no servidor.
- Produces:
  - `export type ShellRole = "admin" | "gestor" | "member" | "super_admin" | "expert";`
  - `export const EXPERT_SECTIONS: NavSection[]`: uma seção "Expert" com `link("Início", "/expert", ...)` e `link("Leads", "/expert/leads", ...)`.
  - `export const EXPERT_MOBILE_TABS`: as mesmas duas entradas.
  - `visibleSections(role, isSuperAdmin)` devolve `EXPERT_SECTIONS` quando `role === "expert"`. As abas mobile, o rodapé e os links de conta seguem a mesma regra: o expert só vê os itens dele e o sair (sem "Conta e equipe").
  - `export function isExpertAllowedPath(pathname: string): boolean`: `true` para `/expert` e `/expert/*`, e para as rotas de autenticação e conta pessoal que existem em `routeTree.gen.ts` (login, reset de senha, troca de senha forçada). O implementador lista essas rotas a partir da árvore de rotas.
  - Na seção "Jogadores", o link `link("Experts", "/experts", <ícone>, { requires: "tenant_admin" })`. Sai o `alsoActiveOn: ["/experts"]` do "Assistente IA", e `ROUTE_META["/experts"]` passa para `{ section: "Jogadores", title: "Experts" }`.
  - `ROUTE_META["/expert"] = { section: "Expert", title: "Início" }` e `ROUTE_META["/expert/leads"] = { section: "Expert", title: "Leads" }`.
  - `app-layout.tsx`: quando `role === "expert"` e `!isExpertAllowedPath(pathname)`, faz `navigate({ to: "/expert", replace: true })` e não renderiza o conteúdo da casa durante o redirecionamento.

- [ ] **Step 1: Write the failing tests** em `navigation.test.ts`:
  - `it("expert sees only the expert section")` (as rotas visíveis são exatamente `["/expert", "/expert/leads"]`);
  - `it("expert has no account/team links")`;
  - `it("Experts admin link is visible to admin and super_admin, hidden to gestor, member and expert")`;
  - `it("isExpertAllowedPath allows expert and auth routes and blocks house routes")` (`/expert/leads` → true; `/players` → false; `/experts` → false);
  - `it("/experts is active under Jogadores")`.

  O teste existente "todas as rotas têm ROUTE_META" vai cobrir as novas rotas quando elas existirem (Task 9).

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/lib/navigation.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement the navigation changes and the layout redirect**

- [ ] **Step 4: Run tests**

  Run: `npx vitest run src/lib/navigation.test.ts && npm run typecheck`
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/navigation.ts src/lib/navigation.test.ts src/components src/hooks/use-active-tenant.ts
git commit -m "feat(expert): expert-only navigation and redirect away from house routes"
```

---

### Task 8: Tela Experts do admin

**Files:**
- Modify (reescrever): `src/routes/experts.tsx`
- Create: `src/components/experts/expert-form-dialog.tsx`, `src/components/experts/expert-invite-dialog.tsx`

**Interfaces:**
- Consumes: Task 6 (`listExperts`, `listUnassignedAffiliates`, `saveExpert`, `inviteExpert`, `removeExpertAccess`, `setExpertActive`, `deleteExpert`, `ExpertAdminRow`, `ExpertAcesso`).
- Produces: a tela `/experts`. Ela não usa mais o cliente supabase direto do navegador: tudo passa pelas server functions.
  - **Tabela:**
    - colunas Expert, Tipo ("Restrito" / "Acesso total"), IDs de afiliado (chips), Leads, Acesso (badge "Sem acesso" / "Convite pendente" / "Ativo" / "Inativo");
    - ações Editar, Convidar (quando sem acesso), Remover acesso, Desativar/Ativar, Excluir (só sem acesso, via `requestConfirmation`).
  - **Diálogo "Novo expert" / "Editar expert":**
    - Nome.
    - Tipo, com ajuda: "Restrito: vê só os leads que chegaram pelos IDs de afiliado dele." / "Acesso total: vê todos os leads da casa."
    - IDs de afiliado: entrada de chips, com sugestões de `listUnassignedAffiliates` mostrando "ID · N leads".
    - Envio de campanhas: "Livre" / "Com aprovação".
    - Teto mensal (R$, vazio = sem teto).
    - Prazo para assumir lead (dias, padrão 3).
    - Nota sob envio e teto: "Vale para as campanhas e fluxos do expert."
  - **Diálogo de convite:** campo de e-mail; os erros aparecem num toast com a mensagem do servidor.
  - **Cartão "IDs de afiliado sem expert":** os mais usados, cada um com o botão "Criar expert", que abre o diálogo com o ID já preenchido.

- [ ] **Step 1: Implement the page and the dialogs** seguindo os componentes que a tela atual já usa (`PageHeader`, `Card`, `Button`, `Input`, `Label`, `requestConfirmation`, `toast`) e o padrão de busca de dados das telas de configuração da casa (`src/routes` que usam `house-config.functions.ts`).

- [ ] **Step 2: Verify**

  Run: `npm run typecheck && npm run lint && npx vitest run src/lib/navigation.test.ts`
  Expected: sem erros

- [ ] **Step 3: Manual check com o tenant demo** (o tenant demo bloqueia escritas): a lista e as sugestões carregam, e salvar mostra o erro de casa demo. Numa casa não demo em ambiente local, quando disponível: criar, editar, sugerir ID, convidar, desativar e excluir.

- [ ] **Step 4: Commit**

```bash
git add src/routes/experts.tsx src/components/experts
git commit -m "feat(expert): admin Experts screen with config, invite and affiliate suggestions"
```

---

### Task 9: Telas do expert (Início e Leads)

**Files:**
- Create: `src/routes/expert.index.tsx` (`/expert`), `src/routes/expert.leads.tsx` (`/expert/leads`). Se o projeto usar outra convenção para rotas aninhadas planas, seguir a de `automacoes.sms.tsx`.
- Modify: `src/routeTree.gen.ts` (regenerado pelo plugin do router no build/dev; não editar à mão)

**Interfaces:**
- Consumes: Task 5 (`getExpertHome`, `listExpertLeads`, `ExpertLeadRow`, `ExpertAccessError`), Task 7 (rotas no menu e `ROUTE_META`).
- Produces:
  - `/expert`:
    - "Olá, {nome}";
    - badge do tipo e nome da casa;
    - cartão "Seus leads: {totalLeads}" com o botão "Ver leads".
  - `/expert/leads`:
    - busca (nome ou telefone, com debounce);
    - tabela Nome, Telefone, Dias sem depositar, Total depositado (BRL), Último depósito (data pt-BR), Risco;
    - paginação de 50.
    - Estado vazio: restrito → "Nenhum lead chegou pelos seus IDs de afiliado ainda."; total → "Nenhum lead encontrado."
  - Um não expert que abre `/expert*` vê "Esta área é exclusiva para experts." (a partir de `ExpertAccessError`).

- [ ] **Step 1: Implement both routes**

- [ ] **Step 2: Verify**

  Run: `npm run typecheck && npm run lint && npx vitest run src/lib/navigation.test.ts`
  Expected: PASS (o teste de cobertura de `ROUTE_META` passa a incluir `/expert` e `/expert/leads`)

- [ ] **Step 3: Commit**

```bash
git add src/routes/expert.index.tsx src/routes/expert.leads.tsx src/routeTree.gen.ts
git commit -m "feat(expert): expert home and lead list screens"
```

---

### Task 10: Verificação completa e aplicação em produção

**Files:** nenhum arquivo novo

- [ ] **Step 1: Full verification**

  Run: `npm run typecheck && npm run lint && npm test && npm run build`
  Expected: tudo passa. Registrar a saída dos testes.

- [ ] **Step 2: Pre-apply read-only check in production** (pooler, `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`): confirmar que ainda valem os fatos do topo do plano (CRM_EXPERT vazio, 4 linhas legadas em `experts`) e que nenhum ID de afiliado colide dentro de uma mesma casa.

- [ ] **Step 3: Pedir autorização explícita à usuária** para aplicar, nesta ordem, `20261025100000`, `20261025100100`, `20261025100200` e `20261025100300` em produção. Registrar cada uma em `supabase_migrations.schema_migrations(version, name, statements)`, como nas anteriores.

- [ ] **Step 4: Depois de aplicar, verificação só leitura**:
  - `experts` tem 2 linhas na casa "BetLeads Original" e `expert_affiliates` tem 4;
  - a casa CRM_EXPERT está `canceled` com `archived_at`;
  - as políticas novas aparecem em `pg_policies`.

- [ ] **Step 5: Integrar a branch** via superpowers:finishing-a-development-branch (merge em `main` e push, que dispara o deploy). Em seguida, convidar um expert de teste numa casa real só com autorização da usuária.
