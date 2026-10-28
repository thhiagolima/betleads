# Área do Expert — Fase 3 (crédito e painéis) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada depósito aprovado passa a ter no máximo um expert creditado, pela regra do spec (clique dentro da janela, senão afiliado depois do cadastro). O expert vê os próprios números e uma lista "Para chamar hoje" completa. O admin vê o ranking e o detalhe de cada expert.

**Architecture:** O crédito é calculado em SQL, não no webhook. A função `refresh_expert_credits(tenant, de, até)` recalcula de forma idempotente a tabela `expert_deposit_credits`, que tem uma linha por depósito e por isso impede crédito duplo. Um cron a mantém atualizada, no padrão de `refresh_crm_results_recent`. Assim cobre também os depósitos importados pelos scripts de sync, que não passam pelo webhook. As métricas saem de duas funções SQL de leitura (`expert_metrics` e `expert_metrics_daily`), chamadas por server functions com guard: o expert só vê a própria linha e o admin vê todas. O crédito do expert é independente do crédito da casa: `conversion_attributions` e `crm_results_daily` não mudam.

**Tech Stack:** Supabase Postgres (plpgsql, pg_cron), TanStack Start (createServerFn + zod), React + react-query, recharts via `src/components/ui/chart.tsx`, Vitest + PGlite.

**Spec:** `docs/superpowers/specs/2026-10-23-area-expert-design.md` (seções 6, 7 e 7.1; regra de afiliado = opção B, só depósitos depois do cadastro; 7.1 = perfil de rendimento para gestores, extrato para comissão por fora sobre o total depositado)

## Decisões que este plano toma

- **Cálculo em lote, não no webhook.** Os depósitos importados pelos scripts de sync não passam pelo webhook, e os cliques sempre vêm antes do depósito. Por isso recalcular uma faixa de datas a qualquer momento dá o mesmo resultado. O cron roda a cada 10 min para os últimos 2 dias e uma vez por dia para os últimos 8 dias.
- **"Depois do cadastro" =** o depósito acontece depois de `greatest(experts.created_at, expert_affiliates.created_at)`. Um ID de afiliado ligado depois só vale dali em diante.
- **Janela de clique:** 72 horas por padrão, configurável por casa entre 1 e 720 horas, numa tabela nova `expert_settings`. O admin altera na tela Experts.
- **Reativação:** o depósito acontece depois de um intervalo sem depósito aprovado maior ou igual a `gamification_settings.sleeping_after_days` da casa (padrão 7). É o mesmo critério que marca o lead como "Dormindo" na ficha.
- **FTD:** o primeiro depósito aprovado da vida do lead. Não pode haver depósito aprovado anterior, e `players.ftd_em` é nulo ou está a até 10 minutos do depósito, o mesmo critério de `refresh_crm_results_day`.
- **Clique válido:** só cliques humanos (`click_events.is_human`), em links do expert (`link_dispatches.source_type = 'expert'`, `send_status = 'sent'`) enviados para o próprio lead. Vence o clique mais recente dentro da janela.
- **Consumo, retorno e fila de aprovação** dependem das campanhas do expert e ficam para a fase 4. Nesta fase essas colunas e cartões não aparecem.
- **Quem lê os dados dos experts:** as tabelas `expert_lead_*`, `expert_links`, `expert_message_templates` e `expert_deposit_credits` passam a ser legíveis só por admin e gestor (`managed_tenant_ids()`), não por qualquer membro da casa.

## Global Constraints

- Todo texto de interface e mensagem de erro em pt-BR.
- Migrations com timestamp ≥ `20261103100000`. A última existente é `20261102100000_allow_multiple_tenant_admins.sql`; a `20261027100000_expert_lead_sheet.sql` (fase 2) **ainda não foi aplicada em produção**; a aplicação em produção segue a ordem.
- Funções SQL novas: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, só para service_role. Tabelas novas: RLS ligada e escrita revogada de `anon` e `authenticated`.
- Dias e períodos no fuso `America/Sao_Paulo`, como `refresh_crm_results_day` (`(_day::timestamp at time zone 'America/Sao_Paulo')`).
- Depósito aprovado = `deposits.status = 'aprovado'`. O momento do depósito é `deposits.created_at` (convenção de todo o SQL do CRM).
- Um depósito tem no máximo um expert (`PRIMARY KEY (deposit_id)`).
- Período padrão dos painéis: últimos 30 dias. Presets: os mesmos de `CentralPeriodPicker` (`src/components/crm-results/shared.tsx`, `PERIODS` em `crm-results/search.ts`).
- Guards:
  - funções do expert: `requireExpertContext`. O expert só vê o próprio `expert_id`.
  - funções do admin: `resolveOperationalTenantForRequest` e depois `requireTenantAdmin(…, "Apenas o admin da casa gerencia experts.")`, como em `src/lib/experts-admin.functions.ts`.
- A casa demo não roda o cron (o mesmo filtro `is_demo` de `refresh_crm_results_recent`).
- Não usar `git stash`.
- Verificação final: `npm run typecheck`, `npm run lint` (0 erros), `npm test`, `npm run build`.

## Review Focus

1. **Dois experts com clique no mesmo lead antes do mesmo depósito:** só o clique mais recente dentro da janela leva o crédito, e o depósito aparece uma vez só no ranking. Teste na Task 1.
2. **Clique fora da janela, clique de robô, clique antes do envio ou link para outro lead:** não geram crédito por clique. Cai para afiliado, se houver. Teste na Task 1.
3. **Recalcular duas vezes a mesma faixa, ou uma faixa que cruza a meia-noite de São Paulo:** o resultado é idêntico e sem duplicatas. Os depósitos das 00:30 de São Paulo caem no dia certo. Teste nas Tasks 1 e 2.
4. **Expert desativado ou excluído:** o crédito histórico continua no ranking enquanto o expert existe (desativado aparece com o badge "Inativo"). Um perfil com créditos não pode ser excluído (Task 8), e um sem créditos some do ranking. Teste nas Tasks 2 e 8.
5. **Expert de acesso total numa casa com 35 mil leads:** "Entraram em risco" traz no máximo 20 leads, ordenados por total depositado, sem varrer a casa inteira na tela. Teste na Task 4.
6. **Gestor com perfil vinculado:** gera o link na ficha da casa e o crédito vai para o perfil dele. O acesso de gestor não muda. Desvincular não remove o papel de gestor. Teste na Task 7.

---

### Task 1: Tabela de créditos, regra de atribuição e cron

**Files:**
- Create: `supabase/migrations/20261103100000_expert_credits.sql`
- Test: `src/lib/expert-credits.db.test.ts`

**Interfaces:**
- Consumes: `experts`, `expert_affiliates` (fase 1); `expert_links` e as tabelas `expert_lead_*` (fase 2); `deposits`, `players`, `link_dispatches`, `click_events`, `gamification_settings`, `managed_tenant_ids()`.
- Produces (SQL):
  - `expert_settings(tenant_id uuid PK → tenants ON DELETE CASCADE, click_window_hours integer NOT NULL DEFAULT 72 CHECK (click_window_hours BETWEEN 1 AND 720), updated_at timestamptz NOT NULL DEFAULT now())`.
  - `expert_deposit_credits`:
    - colunas: `deposit_id uuid PRIMARY KEY → deposits ON DELETE CASCADE`, `tenant_id`, `player_id → players ON DELETE CASCADE`, `expert_id → experts ON DELETE CASCADE`, `via text NOT NULL CHECK (via IN ('clique','afiliado'))`, `valor numeric NOT NULL`, `deposit_at timestamptz NOT NULL`, `link_dispatch_id uuid NULL`, `click_at timestamptz NULL`, `is_ftd boolean NOT NULL`, `is_reativacao boolean NOT NULL`, `click_window_hours integer NOT NULL` (a janela usada no cálculo), `rule_version integer NOT NULL DEFAULT 1`, `computed_at timestamptz NOT NULL DEFAULT now()`;
    - índices `(tenant_id, expert_id, deposit_at desc)` e `(tenant_id, deposit_at desc)`.
  - `refresh_expert_credits(_tenant uuid, _from timestamptz, _to timestamptz) RETURNS integer`:
    - apaga os créditos da casa com `deposit_at` em `[_from, _to)` e reinsere, devolvendo quantos inseriu;
    - para cada depósito aprovado da casa nessa faixa:
      1. **clique:** o clique humano mais recente (`order by c.occurred_at desc, c.id desc`) em `link_dispatches` com `source_type='expert'`, `send_status='sent'`, `recipient_player_id = d.player_id` e `c.occurred_at` entre `greatest(ld.sent_at, d.created_at - janela)` e `d.created_at`. O `expert_id` é `ld.source_id::uuid` e precisa existir em `experts` da mesma casa;
      2. **senão, afiliado:** `expert_affiliates ea` da casa com `ea.affiliate_id = btrim(p.affiliate_id)` e `d.created_at >= greatest(e.created_at, ea.created_at)`;
      3. **senão,** sem crédito.
    - `is_ftd` e `is_reativacao` seguem as decisões do plano. A janela vem de `expert_settings` (padrão 72).
  - `refresh_expert_credits_recent(_days integer DEFAULT 2) RETURNS integer`:
    - advisory lock `hashtext('betleads.refresh_expert_credits')`; se o lock estiver ocupado, devolve -1;
    - percorre as casas não demo que têm ao menos um expert, com `exception when others` + `raise warning` por casa, como `refresh_crm_results_recent`;
    - a faixa vai de `(current_date em São Paulo - _days)` 00:00 até agora.
  - Cron (só se `pg_cron` existir, no padrão das migrations de `crm_results`): `'betleads-expert-credits-recent'` em `'*/10 * * * *'` → `refresh_expert_credits_recent(2)`, e `'betleads-expert-credits-week'` em `'30 6 * * *'` → `refresh_expert_credits_recent(8)`, ambos com `statement_timeout = '300s'`.
  - Políticas: `DROP` e recriação das políticas SELECT de `expert_links`, `expert_lead_contacts`, `expert_lead_followups`, `expert_lead_claims` e `expert_message_templates` (definidas em `20261027100000`, mesmo nome) como `is_super_admin() OR tenant_id = ANY(managed_tenant_ids())`. A mesma política vale para `expert_deposit_credits` e `expert_settings`.

- [ ] **Step 1: Write the failing test** `src/lib/expert-credits.db.test.ts` (PGlite).
  - Schema mínimo de `tenants`, `players`, `deposits`, `link_dispatches`, `click_events`, `gamification_settings` e `managed_tenant_ids()`, seguindo `src/lib/expert-lead-sheet.db.test.ts`.
  - Executa as migrations `20261025100000`, `20261025100100`, `20261027100000` e a nova.
  - Asserts:
    - `it("click within 72h credits the clicking expert with via 'clique'")`
    - `it("latest click wins between two experts")`
    - `it("click older than the window, bot click, click before sent_at or link for another player does not credit by click")`
    - `it("falls back to the affiliate expert only for deposits after greatest(expert, affiliate) created_at")`
    - `it("click beats affiliate")`
    - `it("non-approved deposits get no credit")`
    - `it("click_window_hours from expert_settings is honoured")` (janela 24h e clique de 30h atrás → sem crédito por clique)
    - `it("is_ftd for the first approved deposit and is_reativacao after sleeping_after_days without deposit")` (casa com `sleeping_after_days = 10`: intervalo de 9 dias → false; 10 dias → true)
    - `it("refresh is idempotent and only touches the given range")`
    - `it("deposit at 00:30 São Paulo falls in that São Paulo day range")`
    - `it("recent refresh skips demo houses and returns -1 when the lock is held")` (o lock pode ser simulado com `pg_advisory_xact_lock` numa transação aberta, ou o caso do lock pode ficar só documentado se o PGlite não suportar)
    - `it("authenticated cannot read expert tables as member, can as gestor via managed_tenant_ids")`

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/lib/expert-credits.db.test.ts`
  Expected: FAIL (migration inexistente)

- [ ] **Step 3: Write the migration**

- [ ] **Step 4: Run tests**

  Run: `npx vitest run src/lib/expert-credits.db.test.ts src/lib/expert-lead-sheet.db.test.ts src/lib/expert-model.db.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit** (`feat(expert): per-deposit expert credit with click window and affiliate fallback`)

---

### Task 2: Funções de métricas por expert

**Files:**
- Create: `supabase/migrations/20261103100100_expert_metrics.sql`
- Test: `src/lib/expert-metrics.db.test.ts`

**Interfaces:**
- Consumes: `expert_deposit_credits` (Task 1), `expert_links`, `expert_lead_contacts`, `link_dispatches`, `click_events`.
- Produces (SQL, só para service_role):
  - `expert_metrics(_tenant uuid, _from timestamptz, _to timestamptz) RETURNS TABLE(...)`:
    - colunas: `expert_id uuid, depositado numeric, depositado_clique numeric, depositado_afiliado numeric, depositos integer, depositantes integer, reativacoes integer, ftds integer, links integer, cliques integer, contatos integer`;
    - uma linha por expert da casa, inclusive inativos e com zeros;
    - `cliques` = cliques humanos em dispatches `source_type='expert'` do expert no período;
    - `links` = linhas de `expert_links` criadas no período;
    - `contatos` = linhas de `expert_lead_contacts` no período.
  - `expert_metrics_daily(_tenant uuid, _expert_id uuid, _from timestamptz, _to timestamptz) RETURNS TABLE(dia date, depositado numeric, depositado_clique numeric, depositado_afiliado numeric, cliques integer)`:
    - um dia por linha, com dia calculado em São Paulo;
    - dias sem movimento aparecem com zeros (`generate_series`).

- [ ] **Step 1: Write the failing test** `src/lib/expert-metrics.db.test.ts` (reusa o schema da Task 1). Asserts:
  - `it("sums credits per expert split by via, counts distinct depositors, reativacoes and ftds")`
  - `it("returns zero rows for experts without activity, including inactive ones")`
  - `it("counts links, human clicks and contacts inside the period only")`
  - `it("daily series fills missing São Paulo days with zeros")`
  - `it("a deleted expert disappears together with its credits")`
  - `it("authenticated cannot execute the metric functions")`

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/lib/expert-metrics.db.test.ts`
  Expected: FAIL

- [ ] **Step 3: Write the migration**

- [ ] **Step 4: Run tests** (os dois arquivos db de crédito e de métrica) — Expected: PASS

- [ ] **Step 5: Commit** (`feat(expert): per-expert metrics and daily series SQL`)

---

### Task 3: Server functions de painel e ranking

**Files:**
- Create: `src/lib/expert-period.ts` (puro, client-safe)
- Create: `src/lib/expert-metrics.functions.ts`
- Test: `src/lib/expert-period.test.ts`, `src/lib/expert-metrics.functions.test.ts`

**Interfaces:**
- Consumes: as funções SQL da Task 2; `expert_settings` (Task 1); `requireExpertContext`; guards do admin de `src/lib/experts-admin.functions.ts`; `PERIODS` / `PeriodKey` de `src/components/crm-results/search.ts`. Se esse módulo puxa React, extrair a parte pura para `expert-period.ts` sem mudar o comportamento atual.
- Produces:
  - `periodRange(key: PeriodKey, now: Date): { from: string; to: string }`: ISO dos limites em dias de São Paulo (hoje = 00:00 de hoje até agora; ontem = o dia inteiro; 7, 30 e 90 = os N últimos dias incluindo hoje). `DEFAULT_EXPERT_PERIOD: PeriodKey` = o de 30 dias.
  - `export type ExpertMetrics = { expertId: string; depositado: number; depositadoClique: number; depositadoAfiliado: number; depositos: number; depositantes: number; reativacoes: number; ftds: number; links: number; cliques: number; contatos: number }`
  - `getExpertDashboard({ period: PeriodKey })` → `{ metrics: ExpertMetrics; serie: { dia: string; depositado: number; cliques: number }[]; janelaHoras: number }`. Só o próprio expert.
  - `listExpertsRanking({ period })` (admin) → `{ rows: (ExpertMetrics & { nome: string; tipo: ExpertTipo; ativo: boolean })[]; janelaHoras: number }`, ordenado por `depositado` desc.
  - `getExpertDetail({ expertId: uuid; period })` (admin) → `{ expert: ExpertAdminRow; metrics: ExpertMetrics; serie: (dia, depositado, depositadoClique, depositadoAfiliado, cliques)[]; links: { id; oferta; leadNome; createdAt; clicado: boolean }[] (últimos 20); contatos: { leadNome; resultado; createdAt }[] (últimos 20); assumidos: { leadNome; expiresAt }[] (vigentes) }`. Expert de outra casa → "Expert não encontrado.".
  - `saveExpertSettings({ clickWindowHours: int 1..720 })` (admin) → `{ clickWindowHours }`. Também dispara `refresh_expert_credits_recent(8)` para a casa, pela função de uma casa só: `refresh_expert_credits` com a faixa dos últimos 8 dias.
  - Todas com `…For(ctx, data)` exportado.

- [ ] **Step 1: Write the failing tests**
  - `expert-period.test.ts`:
    - `it("hoje starts at 00:00 São Paulo")`
    - `it("30 days includes today")`
    - `it("ontem is the full previous São Paulo day")` (relógio fixo em 2026-10-24T02:00Z)
  - `expert-metrics.functions.test.ts`:
    - `it("expert dashboard returns only the caller's row")`
    - `it("ranking refuses non-admin")`
    - `it("ranking is sorted by depositado desc and maps snake_case to camelCase")`
    - `it("detail of an expert from another house is 'Expert não encontrado.'")`
    - `it("detail lists only that expert's links, contacts and active claims")`
    - `it("saveExpertSettings validates 1..720 and refreshes the last 8 days")`

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/lib/expert-period.test.ts src/lib/expert-metrics.functions.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests** — Expected: PASS

- [ ] **Step 5: Commit** (`feat(expert): dashboard, ranking and detail server functions`)

---

### Task 4: "Para chamar hoje" completo

**Files:**
- Modify: `src/lib/expert-lead-actions.functions.ts` (duas listas novas)
- Test: `src/lib/expert-lead-actions.functions.test.ts`

**Interfaces:**
- Consumes: `requireExpertContext`, `isExpertAffiliate`, `situationSettingsFromRow`, `link_dispatches`/`click_events`, `deposits`.
- Produces:
  - `listExpertLeadsEnteredRisk()` → `{ playerId; nome; diasSemDepositar: number; totalDepositado: number }[]`:
    - leads visíveis ao expert cujo último depósito (`ultimo_deposito ?? ftd_em`) está entre `sleeping_after_days` e `sleeping_after_days + 7` dias atrás, ou seja, que viraram "Dormindo" nos últimos 7 dias;
    - ordenados por `total_depositado` desc, no máximo 20;
    - para o restrito, a consulta já filtra por `affiliate_id in expert.affiliateIds`, com o refiltro de trim igual ao de `loadVisibleLead`;
    - para o total, a consulta é por casa, sempre limitada por faixa de data e `.limit(20)`.
  - `listExpertClickedNoDeposit()` → `{ playerId; nome; clicadoEm: string; oferta: string | null }[]`:
    - leads com clique humano num link do expert nas últimas 24h e sem depósito aprovado depois desse clique;
    - um por lead (clique mais recente), no máximo 20, mais recentes primeiro.

- [ ] **Step 1: Write the failing tests** (acrescentar ao arquivo de testes existente):
  - `it("entered-risk lists only leads that became dormant in the last 7 days, max 20, by total depositado")`
  - `it("entered-risk for restricted expert only includes own affiliate leads")`
  - `it("clicked-no-deposit excludes leads that deposited after the click and bot clicks")`
  - `it("clicked-no-deposit only uses the caller's dispatches")`

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/lib/expert-lead-actions.functions.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests** — Expected: PASS

- [ ] **Step 5: Commit** (`feat(expert): entered-risk and clicked-without-deposit lists`)

---

### Task 5: Início do expert com números do período

**Files:**
- Modify: `src/routes/expert.index.tsx`
- Create: `src/components/expert/expert-metric-cards.tsx`

**Interfaces:**
- Consumes: `getExpertDashboard`, `periodRange`/`DEFAULT_EXPERT_PERIOD` (Task 3), `listExpertLeadsEnteredRisk` e `listExpertClickedNoDeposit` (Task 4), `listExpertFollowupsDue` (fase 2), `CentralPeriodPicker`.
- Produces:
  - **Topo:** "Olá, {nome}", tipo e casa (como hoje), mais o seletor de período (padrão 30 dias).
  - **Cartões** (`ExpertMetricCards`, reaproveitado pelo admin na Task 6):
    - "Depositado atribuído", com o valor em R$ e, embaixo, "por clique R$ X · por afiliado R$ Y";
    - "Reativados";
    - "Primeiros depósitos";
    - "Cliques / links".
  - **Gráfico:** depositado por dia no período, em barras, via `ChartContainer` (`src/components/ui/chart.tsx`).
  - **"Para chamar hoje"**, com três blocos:
    - "Retornos" (o que já existe);
    - "Entraram em risco" (até 20, cada um levando à ficha, com "{n} dias sem depositar");
    - "Clicaram no seu link e não depositaram (24h)" (até 20, com oferta e horário).
    - Vazio total: "Nada para hoje. Bom trabalho!".
  - **"Seus leads: {totalLeads}"** continua, num cartão menor.
  - Nota abaixo dos cartões: "Depósitos contam para você quando o lead clica no seu link e deposita em até {janelaHoras}h, ou quando chega pelo seu ID de afiliado."

- [ ] **Step 1: Implement** seguindo os padrões da própria `expert.index.tsx` e dos cartões de `src/components/crm-results/overview.tsx` (mobile em coluna única).
- [ ] **Step 2: Verify** — `npm run typecheck`, `npx eslint` nos arquivos tocados, `npm run build`
- [ ] **Step 3: Commit** (`feat(expert): expert home with period metrics and full today list`)

---

### Task 6: Ranking e detalhe no admin

**Files:**
- Modify: `src/routes/experts.tsx` (ranking e configuração da janela)
- Create: `src/routes/experts.$expertId.tsx`
- Create: `src/components/experts/expert-settings-dialog.tsx`
- Modify: `src/lib/navigation.ts` (`ROUTE_META["/experts/$expertId"] = { section: "Jogadores", title: "Expert" }`, com "Experts" ativo no menu), `src/routeTree.gen.ts` (regenerado)

**Interfaces:**
- Consumes: `listExpertsRanking`, `getExpertDetail`, `saveExpertSettings` (Task 3), `ExpertMetricCards` (Task 5), os diálogos de edição e convite da fase 1, `CentralPeriodPicker`.
- Produces:
  - **`/experts`:**
    - seletor de período e botão "Regras de crédito", que abre o diálogo da janela: "Janela de clique (horas)", com ajuda "Padrão 72h. Vale para os próximos cálculos e recalcula os últimos 8 dias.";
    - a tabela atual ganha as colunas "Depositado", "Por clique", "Por afiliado", "Reativações", "FTD" e "Cliques", ordenada por depositado;
    - o nome do expert leva ao detalhe;
    - as ações atuais (editar, convidar, ativar ou desativar, excluir) e o cartão de "IDs de afiliado sem expert" continuam.
  - **`/experts/$expertId`:**
    - cabeçalho com nome, tipo, badge de acesso e o botão "Editar";
    - seletor de período e `ExpertMetricCards`;
    - gráfico diário de barras empilhadas por clique e por afiliado;
    - três cartões de atividade: "Links gerados" (oferta, lead, data, "Clicou" ou "—"), "Contatos registrados" e "Leads assumidos";
    - expert não encontrado → "Expert não encontrado." com link de volta.

- [ ] **Step 1: Implement** seguindo `src/routes/experts.tsx` e os padrões de gráfico de `src/components/crm-results/overview.tsx`.
- [ ] **Step 2: Verify** — `npm run build` (regenera o route tree), `npm run typecheck`, `npx eslint` nos arquivos tocados, `npx vitest run src/lib/navigation.test.ts`
- [ ] **Step 3: Commit** (`feat(expert): admin ranking, credit settings and expert detail`)

---

### Task 7: Perfil de rendimento para a equipe e link rastreado na ficha da casa

**Files:**
- Create: `src/lib/expert-link-core.server.ts` (o núcleo compartilhado de geração de link, extraído de `generateExpertLinkFor`)
- Modify: `src/lib/expert-links.functions.ts` (passa a usar o núcleo, com o mesmo comportamento)
- Create: `src/lib/team-expert.functions.ts`
- Modify: `src/lib/experts-admin.functions.ts` (vincular/desvincular equipe; `ExpertAcesso` ganha `"equipe"`; `removeExpertAccessFor` só apaga linha de `user_roles` com `role='expert'`)
- Modify: `src/routes/experts.tsx` (ação "Vincular a alguém da equipe"; badge "Equipe ({Admin|Gestor|Membro})"), `src/routes/players.$playerId.tsx` (cartão de link rastreado)
- Create: `src/components/players/team-tracked-link-card.tsx`
- Test: `src/lib/team-expert.functions.test.ts`, `src/lib/experts-admin.functions.test.ts` (acrescentar)

**Interfaces:**
- Consumes: `createTrackedLinkForRecipient`, `DestinationNotAllowedError`, `ShortenerUnavailableError` (`shortio.server.ts`); `assertTenantCanSendExternally`; `HOUSE_MEMBER_ROLES` (`src/lib/house-member-roles.ts`); `resolveOperationalTenantForRequest`.
- Produces:
  - `createExpertLinkCore(input: { tenantId: string; expertId: string; playerId: string; url: string; oferta: string }): Promise<{ id: string; sentUrl: string; shortened: boolean }>`:
    - faz a validação de URL e oferta, `assertTenantCanSendExternally`, o link, o insert em `expert_links` e a compensação;
    - mantém as mensagens pt-BR atuais;
    - `generateExpertLinkFor` fica `requireExpertContext` → `loadVisibleLead` → `createExpertLinkCore`.
  - `linkExpertToTeamMember({ expertId: uuid; userId: uuid })` (admin):
    - o usuário precisa ter papel `admin`, `gestor` ou `member` nesta casa. Senão: "Escolha alguém da equipe desta casa.";
    - o expert não pode ter `user_id`. Senão: "Este perfil já está vinculado.";
    - o usuário não pode ter outro perfil nesta casa. Senão: "Esta pessoa já tem um perfil de rendimento.";
    - grava `experts.user_id` e a auditoria `expert.team_linked`.
  - `listTeamMembersForLinking()` (admin) → `{ userId; email; papel: "admin" | "gestor" | "member" }[]`: só membros sem perfil.
  - `ExpertAcesso` ganha `"equipe"`: tem `user_id`, mas o papel do usuário na casa não é `expert`. `ExpertAdminRow` ganha `papelEquipe: "admin" | "gestor" | "member" | null`.
  - `getMyTeamExpertProfile()` → `{ expertId: string; nome: string } | null`: perfil ativo do usuário logado na casa atual, só para quem tem papel da equipe.
  - `generateTeamTrackedLink({ playerId: uuid; url: string; oferta: string })` → `{ id; sentUrl; shortened }`:
    - guard: casa via `resolveOperationalTenantForRequest`, papel do usuário em `HOUSE_MEMBER_ROLES`, perfil ativo vinculado. Sem perfil: "Você não tem um perfil de rendimento nesta casa.";
    - jogador da casa (`players.tenant_id`). Senão: "Jogador não encontrado.";
    - então `createExpertLinkCore`.
  - Cartão **"Link rastreado (seu rendimento)"** na ficha do jogador da casa, só quando `getMyTeamExpertProfile()` não é nulo:
    - campos URL e oferta, "Gerar link", "Copiar";
    - um botão "Abrir no WhatsApp" com o link já no texto (`normalizeBrazilianPhone`, sem modelos).

- [ ] **Step 1: Write the failing tests**
  - `team-expert.functions.test.ts`:
    - `it("gestor with a linked active profile generates a link credited to that profile")` (asserta `sourceId` = `expertId`, `source_type 'expert'`)
    - `it("member without a profile is refused with the pt-BR message")`
    - `it("expert role users cannot use the team path")`
    - `it("player of another house is 'Jogador não encontrado.'")`
    - `it("inactive profile is treated as no profile")`
  - `experts-admin.functions.test.ts`:
    - `it("link refuses a user outside the house team and a user who already has a profile")`
    - `it("acesso is 'equipe' with papelEquipe for team-linked profiles")`
    - `it("removing access of a team-linked profile clears user_id and keeps the user's gestor role")`
  - O teste existente de `generateExpertLinkFor` continua verde, sem mudança.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/lib/team-expert.functions.test.ts src/lib/experts-admin.functions.test.ts src/lib/expert-links.functions.test.ts`
  Expected: FAIL nos novos

- [ ] **Step 3: Implement** (server, depois UI)

- [ ] **Step 4: Verify**: os testes acima passam; `npm run typecheck`, `npx eslint` nos arquivos tocados, `npm run build`

- [ ] **Step 5: Commit** (`feat(expert): team performance profiles and tracked links from the house player page`)

---

### Task 8: Extrato de créditos (base da comissão) e proteção do histórico

**Files:**
- Modify: `src/lib/expert-metrics.functions.ts`
- Modify: `src/lib/experts-admin.functions.ts` (`deleteExpertFor`)
- Modify: `src/routes/experts.$expertId.tsx` (cartão "Extrato de créditos")
- Test: `src/lib/expert-metrics.functions.test.ts`, `src/lib/experts-admin.functions.test.ts` (acrescentar)

**Interfaces:**
- Consumes: `expert_deposit_credits` (Task 1), `expert_links`, `periodRange` (Task 3).
- Produces:
  - `export type ExpertCreditRow = { depositId: string; depositAt: string; leadNome: string; valor: number; via: "clique" | "afiliado"; oferta: string | null; clickAt: string | null; isFtd: boolean; isReativacao: boolean }`
  - `listExpertCredits({ expertId: uuid; period: PeriodKey; page: int ≥ 0 })` (admin) → `{ rows: ExpertCreditRow[]; total: number; somaValor: number }`:
    - 100 por página, ordenado por `deposit_at` desc;
    - `oferta` vem de `expert_links` pelo `link_dispatch_id`;
    - `somaValor` é o total do período inteiro, não da página.
  - `exportExpertCreditsCsv({ expertId: uuid; period: PeriodKey })` (admin) → `{ filename: string; csv: string }`:
    - todas as linhas do período;
    - separador `;`, BOM UTF-8, valores com vírgula decimal, datas `dd/mm/aaaa hh:mm` em São Paulo;
    - cabeçalho exato: `Data;Lead;Valor;Origem;Oferta;Clique em;Primeiro depósito;Reativação`;
    - Origem "Clique" ou "Afiliado"; Sim/Não nas duas últimas colunas;
    - última linha `Total;;{soma};;;;;`;
    - `filename` = `extrato-{slug do nome}-{aaaa-mm-dd}-a-{aaaa-mm-dd}.csv`.
  - `deleteExpertFor`: se o expert tem qualquer linha em `expert_deposit_credits` → "Este perfil tem créditos registrados. Desative em vez de excluir, para manter o histórico."
  - Cartão **"Extrato de créditos"** no detalhe:
    - tabela paginada com as colunas do CSV;
    - total do período no topo ("Total depositado creditado: R$ X");
    - botão "Exportar CSV", que baixa o arquivo no navegador.

- [ ] **Step 1: Write the failing tests**
  - `it("credits list is scoped to the expert and period, paginated by 100, with somaValor of the whole period")`
  - `it("csv has the exact header, ';' separator, BOM, comma decimals, São Paulo dates and a Total line")`
  - `it("csv escapes lead names containing ';' or quotes")`
  - `it("credits endpoints refuse non-admin and experts of another house")`
  - `it("delete is refused when the expert has credits")`

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/lib/expert-metrics.functions.test.ts src/lib/experts-admin.functions.test.ts`
  Expected: FAIL nos novos

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify**: testes passam; `npm run typecheck`, `npx eslint` nos arquivos tocados, `npm run build`

- [ ] **Step 5: Commit** (`feat(expert): credit statement with CSV export and history protection`)

---

### Task 9: Verificação e produção

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm test && npm run build`. Tudo passa; registrar a saída.
- [ ] **Step 2:** Com autorização explícita da usuária, aplicar em produção, nesta ordem: `20261027100000_expert_lead_sheet.sql` (fase 2, pendente), `20261103100000_expert_credits.sql` e `20261103100100_expert_metrics.sql`. Registrar cada uma em `schema_migrations`. Depois:
  - rodar `select public.refresh_expert_credits_recent(8)` uma vez;
  - verificar, só leitura, os jobs no `cron.job`, a contagem de créditos por casa e uma amostra de `expert_metrics` na casa que tiver experts.
- [ ] **Step 3:** Merge em `main` e push, com autorização da usuária.
