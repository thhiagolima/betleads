# Relatório de rendimento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a página "Relatório de rendimento" (a mesma para o expert, para o membro da equipe com perfil e para o admin), a página "Rendimento da equipe" do admin e o histórico de cada lead, sobre os créditos da fase 3.

**Architecture:** As agregações ficam em funções SQL novas, só para service_role, que leem `expert_deposit_credits` e as tabelas existentes. Uma função de servidor decide **de quem** é o relatório: o próprio usuário (expert ou perfil de equipe) quando o cliente não manda `expertId`, ou qualquer perfil da casa quando o admin manda. Todas as consultas usam essa decisão. A UI é um componente compartilhado montado em três rotas, com um painel lateral para o histórico do lead.

**Tech Stack:** Supabase Postgres (plpgsql/sql), TanStack Start (createServerFn + zod), React + react-query, recharts via `src/components/ui/chart.tsx`, `src/components/ui/sheet.tsx`, Vitest + PGlite.

**Spec:** `docs/superpowers/specs/2026-10-28-relatorio-rendimento-design.md`

## Global Constraints

- Todo texto de interface em pt-BR, com as cópias exatas do spec.
- Saques ficam de fora. A regra de crédito não muda: esta entrega só lê `expert_deposit_credits`.
- Períodos: os de `EXPERT_PERIODS` (`src/lib/expert-period.ts`). Padrão das páginas de relatório: `"mes_atual"` (Este mês).
- O período anterior segue a regra do spec §4, bloco 1 (mesma duração, terminando no mesmo ponto relativo; para "Este mês", limitado ao fim de um mês anterior mais curto).
- Redepósito = crédito com `is_ftd = false`. FTD = `is_ftd`. Reativado = `is_reativacao`.
- "Clique→depósito" = leads distintos com crédito `via='clique'` no período ÷ leads distintos com clique humano nos links da pessoa no período. Mesma definição no relatório e no ranking.
- Total do bloco 1 = soma do extrato = soma da carteira, para o mesmo período.
- **Acesso:**
  - sem `expertId` no input, o relatório é do próprio usuário: `requireExpertContext` para quem tem papel `expert`; para a equipe, o perfil ativo vinculado, pela mesma regra de `getMyTeamExpertProfileFor` em `src/lib/team-expert.functions.ts`;
  - com `expertId`, só o admin: `requireExpertAdminTenant` + `loadExpert` (`src/lib/experts-admin.functions.ts`). Outra casa: "Expert não encontrado.".
  - um expert ou membro da equipe que manda `expertId` é recusado com "Apenas o admin da casa gerencia experts.".
- Funções SQL novas: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL ... FROM public, anon, authenticated`, `GRANT EXECUTE ... TO service_role`.
- Migrations novas: `20261106153000_expert_report.sql` e `20261106153100_expert_portfolio.sql`. Antes de criar, confira que esses números não existem em `supabase/migrations` nem em `origin/main`. Se existirem, use o próximo minuto livre e avise no relatório.
- Dias em São Paulo (`at time zone 'America/Sao_Paulo'`, `src/lib/tz.ts`).
- Nunca importar `*.server.ts` em código de cliente. Não usar `git stash`.
- Gate de typecheck: nenhum erro novo, além dos que já existirem em `origin/main` (registre a contagem de base antes de começar).
- Verificação final: `npm run typecheck`, `npm run lint` (0 erros), `npm test` e `npm run build`.

## Review Focus

1. **Expert ou membro da equipe mandando `expertId` de outra pessoa**, em qualquer função (relatório, carteira, histórico, extrato, CSV): recusado, sem retornar nada. Teste na Task 3.
2. **Histórico de um lead que nunca teve relação com a pessoa** (passando um `playerId` qualquer da casa): devolve vazio, e não os depósitos do lead. Teste na Task 2.
3. **Período sem nenhum crédito, inclusive no período anterior:** os cartões mostram zero e a variação "—", sem divisão por zero. A carteira e o gráfico ficam vazios, com os textos de estado vazio. Teste nas Tasks 1 e 2.
4. **"Este mês" no dia 31 comparado a um mês anterior de 30 dias**, e "Mês passado" em janeiro (comparado com dezembro do ano anterior): limites corretos. Teste na Task 1.
5. **Busca da carteira com `%`, `_` ou aspas:** tratada como texto, sem erro e sem casar tudo. Teste na Task 2.

---

### Task 1: Período anterior

**Files:**
- Modify: `src/lib/expert-period.ts`
- Test: `src/lib/expert-period.test.ts`

**Interfaces:**
- Produces:
  - `comparisonRange(key: PeriodKey, now: Date): { current: { from: string; to: string }; previous: { from: string; to: string } }`. `current` é igual a `periodRange(key, now)`; `previous` segue a regra do spec §4 bloco 1.
  - `DEFAULT_REPORT_PERIOD: PeriodKey = "mes_atual"`.
  - `variationPct(current: number, previous: number): number | null`. Devolve `null` quando `previous` é 0; senão, a variação percentual arredondada a 1 casa decimal.

- [ ] **Step 1: Write the failing tests:**
  - `it("hoje compares with yesterday up to the same time")`: com `now = 2026-10-28T17:00:00Z` (14:00 em SP), `previous` = 2026-10-27 03:00Z até 2026-10-27 17:00Z;
  - `it("ontem compares with the day before")`;
  - `it("7/30/90 shift back by N days keeping the partial today")`;
  - `it("mes_atual on Oct 31 compares with Sep 1..Sep 30 end")`: o mês anterior é mais curto, então `previous.to` = 2026-10-01 03:00Z;
  - `it("mes_anterior in January compares with the previous December")`: `now = 2027-01-15T15:00Z` → `current` = dezembro inteiro de 2026, `previous` = novembro inteiro de 2026;
  - `it("variationPct is null without a previous base and rounds to 1 decimal")`.
- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/expert-period.test.ts`
  Expected: FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify it passes** — Expected: PASS
- [ ] **Step 5: Commit** (`feat(rendimento): previous-period comparison ranges`)

---

### Task 2: Funções SQL do relatório, da carteira, do histórico e da equipe

**Files:**
- Create: `supabase/migrations/20261106153000_expert_report.sql` (resumo, série diária e equipe)
- Create: `supabase/migrations/20261106153100_expert_portfolio.sql` (carteira e histórico do lead)
- Test: `src/lib/expert-report.db.test.ts`

**Interfaces:**
- Consumes: `expert_deposit_credits`, `expert_links`, `expert_lead_contacts`, `expert_affiliate_history`, `experts` (`created_at`, `desativado_em`), `expert_settings`, `deposits`, `players`, `link_dispatches`, `click_events` (migrations `20261105143000` e `20261105143100`, e a da fase 2 `20261027100000`).
- Produces (todas só para service_role):
  - `expert_report(_tenant uuid, _expert uuid, _from timestamptz, _to timestamptz) RETURNS TABLE(depositado numeric, depositado_clique numeric, depositado_afiliado numeric, ftds integer, valor_ftd numeric, redepositos integer, valor_redeposito numeric, reativados integer, depositantes integer, links integer, leads_com_link integer, leads_clicaram integer, leads_depositaram_clique integer, contatos integer)`:
    - uma linha;
    - o servidor chama duas vezes (atual e anterior);
    - `leads_com_link` = leads distintos que receberam link da pessoa no período;
    - `leads_clicaram` = leads distintos com clique humano no período nesses links.
  - `expert_report_daily(_tenant, _expert, _from, _to) RETURNS TABLE(dia date, valor_ftd numeric, valor_redeposito numeric, depositantes integer)`: dias de SP, com zeros nos dias sem movimento.
  - `expert_team_report(_tenant, _from, _to) RETURNS TABLE(expert_id uuid, depositado numeric, ftds integer, redepositos integer, reativados integer, leads_clicaram integer, leads_depositaram_clique integer, depositos integer)`:
    - uma linha por perfil da casa, inclusive inativos e com zeros;
    - o servidor chama duas vezes (atual e anterior).
  - `house_deposit_totals(_tenant, _from, _to) RETURNS TABLE(depositado numeric, ftds integer)`:
    - depósitos aprovados da casa no período;
    - FTD pelo mesmo critério da fase 3: nenhum depósito aprovado anterior, e `ftd_em` nulo ou a até 10 minutos do depósito.
  - `expert_last_computed_at(_tenant) RETURNS timestamptz`: maior `computed_at` dos créditos da casa, ou NULL.
  - `expert_portfolio(_tenant, _expert, _from, _to, _search text, _only_ftd boolean, _only_reativados boolean, _limit integer, _offset integer) RETURNS TABLE(player_id uuid, nome text, telefone text, creditado numeric, depositos integer, origem text, primeiro_credito timestamptz, ultimo_deposito timestamptz, ultimo_contato_resultado text, ultimo_contato_em timestamptz, tem_ftd boolean, reativado boolean, total_count bigint)`:
    - leads com ao menos um crédito da pessoa no período;
    - `origem` ∈ `'clique' | 'afiliado' | 'ambos'`;
    - `primeiro_credito` = o primeiro crédito da pessoa para o lead, considerando todo o histórico;
    - `ultimo_deposito` = o último depósito aprovado do lead;
    - o último contato vem de `expert_lead_contacts` da pessoa;
    - `_search` com `ilike` sobre `nome` e `telefone`, com `%`, `_` e `\` escapados dentro da função;
    - ordenação por `creditado desc, player_id`;
    - `total_count` = total de linhas antes do limite (window `count(*) over ()`).
  - `expert_lead_timeline(_tenant, _expert, _player, _before timestamptz, _limit integer) RETURNS TABLE(at timestamptz, kind text, titulo text, detalhe text, valor numeric, status text)`:
    - `kind` ∈ `'link' | 'clique' | 'contato' | 'deposito'`;
    - itens com `at < coalesce(_before, 'infinity')`, os `_limit` mais recentes;
    - depósitos aprovados do lead a partir de `least(primeiro link da pessoa para o lead, primeiro crédito da pessoa para o lead)`;
    - sem link nem crédito da pessoa para esse lead, não devolve nada;
    - para depósito, `status` ∈ `'creditado' | 'outra_pessoa' | 'nao_creditado'`;
    - `detalhe` traz o motivo. Para creditado: `"clique em {dd/mm hh:mi}"` ou `"afiliado"`. Para não creditado, o primeiro que se aplicar, nesta ordem:
      1. `"antes do seu cadastro"` (depósito anterior a `experts.created_at`);
      2. `"perfil desativado na data"` (depósito em ou depois de `desativado_em`);
      3. `"ID de afiliado não era seu na data"` (o lead tem `affiliate_id`, mas o histórico de afiliados não o liga à pessoa naquele instante, e não houve clique);
      4. `"sem clique seu nas {janela}h anteriores"`;
    - para outra pessoa: `"contou para outro membro da equipe"`.

- [ ] **Step 1: Write the failing test** `src/lib/expert-report.db.test.ts` (PGlite). Reaproveita o setup de `src/lib/expert-credits.db.test.ts` e roda as migrations de expert em ordem, mais as duas novas. Monta créditos reais com `refresh_expert_credits`. Asserts:
  - `it("expert_report splits ftd/redeposit values and counts depositors, links, clicked and click-converted leads")`
  - `it("report total equals the sum of the portfolio creditado for the same period")`
  - `it("expert_report_daily fills São Paulo days with zeros")`
  - `it("expert_team_report has one row per profile including inactive with zeros")`
  - `it("house_deposit_totals counts approved deposits and FTDs of the whole house")`
  - `it("portfolio filters only_ftd / only_reativados, paginates with total_count and escapes % _ in search")`
  - `it("timeline marks deposits as creditado with click reason, outra_pessoa, and nao_creditado with the right reason")` (um caso por motivo)
  - `it("timeline is empty for a lead without any link or credit from the expert")`
  - `it("timeline paginates by _before")`
  - `it("authenticated cannot execute the new functions")`
- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/expert-report.db.test.ts`
  Expected: FAIL
- [ ] **Step 3: Write both migrations** (cada uma dentro de `begin; … commit;`)
- [ ] **Step 4: Run** `npx vitest run src/lib/expert-report.db.test.ts src/lib/expert-credits.db.test.ts src/lib/expert-metrics.db.test.ts` — Expected: PASS
- [ ] **Step 5: Commit** (`feat(rendimento): report, portfolio, lead timeline and team SQL`)

---

### Task 3: Server functions do relatório

**Files:**
- Create: `src/lib/expert-report-subject.server.ts`
- Create: `src/lib/expert-report.functions.ts`
- Modify: `src/lib/expert-metrics.functions.ts` (`listExpertCredits` e `exportExpertCreditsCsv` passam a aceitar `expertId` opcional e a resolver o dono pelo módulo de sujeito; sem `expertId`, servem a própria pessoa)
- Test: `src/lib/expert-report-subject.server.test.ts`, `src/lib/expert-report.functions.test.ts`, mais os testes existentes de `expert-metrics.functions.test.ts` (que continuam verdes)

**Interfaces:**
- Consumes: as funções SQL da Task 2; `comparisonRange`, `variationPct`, `DEFAULT_REPORT_PERIOD` (Task 1); `requireExpertContext`; `getMyTeamExpertProfileFor`; `requireExpertAdminTenant`, `loadExpert`, `buildExpertAdminRow`.
- Produces:
  - `export type ReportSubject = { tenantId: string; expertId: string; nome: string; tipoLabel: string; viewer: "self" | "admin" }`. `tipoLabel` ∈ "Expert restrito" / "Expert total" / "Equipe ({Admin|Gestor|Membro})".
  - `resolveReportSubject(ctx: ServerContext, expertId?: string | null): Promise<ReportSubject>`:
    - sem `expertId`: expert, ou então perfil de equipe. Sem perfil: "Você não tem um perfil de rendimento nesta casa.";
    - com `expertId`: guard de admin.
  - `export type ReportBlock = { depositado; depositadoClique; depositadoAfiliado; ftds; valorFtd; redepositos; valorRedeposito; ticketRedeposito: number | null; reativados; depositantes; links; leadsComLink; leadsClicaram; leadsDepositaramClique; contatos }` (números).
  - `getExpertReport({ period: PeriodKey; expertId?: uuid })` → `{ subject: ReportSubject; current: ReportBlock; previous: ReportBlock; variacao: { depositado: number | null; ftds: number | null; redepositos: number | null; reativados: number | null }; serie: { dia: string; valorFtd: number; valorRedeposito: number; depositantes: number }[]; topLeads: PortfolioRow[] (10); janelaHoras: number; atualizadoEm: string | null }`.
  - `export type PortfolioRow = { playerId; nome; telefone: string | null; creditado: number; depositos: number; origem: "clique" | "afiliado" | "ambos"; primeiroCredito: string; ultimoDeposito: string | null; ultimoContato: { resultado: string; em: string } | null; temFtd: boolean; reativado: boolean }`.
  - `listExpertPortfolio({ period; expertId?; search?: string (máx. 80); onlyFtd?: boolean; onlyReativados?: boolean; page: int ≥ 0 })` → `{ rows: PortfolioRow[]; total: number }`, 50 por página.
  - `exportExpertPortfolioCsv({ period; expertId?; search?; onlyFtd?; onlyReativados? })` → `{ filename; csv }`:
    - mesmo padrão do extrato da fase 3 (`;`, BOM, vírgula decimal, datas de SP, neutralização de fórmula);
    - cabeçalho exato `Lead;Telefone;Creditado;Depósitos;Origem;1º crédito;Último depósito;Último contato;FTD;Reativado`.
  - `getExpertLeadTimeline({ playerId: dbUuid; expertId?; before?: string })` → `{ resumo: { creditado: number; depositos: number; desde: string | null }; items: { at; kind; titulo; detalhe: string | null; valor: number | null; status: "creditado" | "outra_pessoa" | "nao_creditado" | null }[]; nextBefore: string | null }`:
    - 100 itens por vez;
    - o resumo cobre todo o histórico da pessoa com o lead.
  - Todas com `…For(ctx, data)` exportado.

- [ ] **Step 1: Write the failing tests:**
  - `it("self subject for an expert, for a team member with an active profile, refused without profile")`
  - `it("expertId as expert or team member is refused with the admin message")`
  - `it("admin subject of another house is 'Expert não encontrado.'")`
  - `it("report maps both periods, computes variation via variationPct and ticket = valorRedeposito/redepositos")`
  - `it("report total equals listExpertCredits somaValor for the same subject and period")`
  - `it("portfolio csv has the exact header and escapes")`
  - `it("timeline returns nextBefore when 100 items came back")`
  - `it("listExpertCredits without expertId serves the caller's own statement; with expertId requires admin")`
- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/expert-report-subject.server.test.ts src/lib/expert-report.functions.test.ts src/lib/expert-metrics.functions.test.ts`
  Expected: FAIL nos novos
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run tests** — Expected: PASS
- [ ] **Step 5: Commit** (`feat(rendimento): report subject resolution and report server functions`)

---

### Task 4: Rendimento da equipe (server) e o sinal de perfil no menu

**Files:**
- Modify: `src/lib/expert-report.functions.ts` (`getTeamReport`, `exportTeamReportCsv`)
- Modify: `src/lib/tenants.functions.ts` (`getTenantSwitcherFor`: cada casa ganha `has_team_profile`)
- Modify: `src/hooks/use-active-tenant.ts` (tipo)
- Test: `src/lib/expert-report.functions.test.ts`, `src/lib/tenants-team-profile-flag.test.ts`

**Interfaces:**
- Consumes: `expert_team_report`, `house_deposit_totals`, `expert_last_computed_at` (Task 2); `comparisonRange` / `variationPct` (Task 1); `HOUSE_MEMBER_ROLES`.
- Produces:
  - `getTeamReport({ period })` (admin) → `{ totais: { creditado: number; pctCasaDepositado: number | null; ftds: number; pctCasaFtds: number | null; redepositos: number; reativados: number }; rows: { expertId; nome; tipoLabel; ativo: boolean; creditado; variacao: number | null; ftds; redepositos; reativados; cliqueDeposito: number | null; ticket: number | null }[]; janelaHoras: number; atualizadoEm: string | null }`:
    - ordenado por creditado desc;
    - `cliqueDeposito` como fração de 0 a 1, ou null sem cliques.
  - `exportTeamReportCsv({ period })` (admin) → `{ filename; csv }`, com cabeçalho exato `Pessoa;Tipo;Creditado;Variação;FTD;Redepósitos;Reativados;Clique→depósito;Ticket médio`.
  - `getTenantSwitcherFor`: cada opção ganha `has_team_profile: boolean`. É verdadeiro quando o usuário tem papel em `HOUSE_MEMBER_ROLES` naquela casa e um `experts` ativo com `user_id` = ele, na mesma casa. Deve vir de uma consulta única para todas as casas.
- [ ] **Step 1: Write the failing tests:**
  - `it("team report refuses non-admin")`
  - `it("team report computes house shares and handles zero house totals")`
  - `it("team csv header is exact")`
  - `it("switcher flags has_team_profile only for house roles with an active linked profile")`
- [ ] **Step 2: Run to verify it fails** (os arquivos de teste acima) — Expected: FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run tests** (mais `src/lib/tenants-*.test.ts`) — Expected: PASS
- [ ] **Step 5: Commit** (`feat(rendimento): team report and team-profile flag in the house switcher`)

---

### Task 5: Navegação e rotas

**Files:**
- Modify: `src/lib/navigation.ts`, `src/lib/navigation.test.ts`, `src/components/shell/use-shell-nav.ts` (e onde `canSee` recebe `canViewFinance`)
- Create: `src/routes/expert.rendimento.tsx`, `src/routes/rendimento.tsx` (a própria página), `src/routes/rendimento.equipe.tsx`, `src/routes/rendimento.equipe.$expertId.tsx` (por enquanto, cada uma renderiza um placeholder com `PageHeader`; o conteúdo vem nas Tasks 6 e 7)
- Modify: `src/routes/experts.$expertId.tsx` (vira redirect para `/rendimento/equipe/$expertId`)
- Modify: `src/routeTree.gen.ts` (regenerado pelo build)

**Interfaces:**
- Consumes: `has_team_profile` (Task 4).
- Produces:
  - `NavAccess.requires` ganha `"team_profile"`, que fica visível quando a casa ativa tem `has_team_profile`.
  - `canSee` e `visibleSections` recebem esse sinal, seguindo o mesmo padrão de `canViewFinance`.
  - Na seção do link "Resultados do CRM", entram dois links:
    - `link("Meu rendimento", "/rendimento", <ícone>, { requires: "team_profile" })`;
    - `link("Rendimento da equipe", "/rendimento/equipe", <ícone>, { requires: "tenant_admin" })`.
  - `EXPERT_SECTIONS` e `EXPERT_MOBILE_TABS` ganham `link("Rendimento", "/expert/rendimento", <ícone>)`.
  - `ROUTE_META`:
    - `"/expert/rendimento"` → Expert / "Rendimento";
    - `"/rendimento"` → Resultados / "Meu rendimento";
    - `"/rendimento/equipe"` → Resultados / "Rendimento da equipe";
    - `"/rendimento/equipe/$expertId"` → Resultados / "Relatório de rendimento", com "Rendimento da equipe" ativo no menu.
  - `rendimento.tsx` renderiza `<Outlet/>` só nas rotas filhas, no padrão de `expert.leads.tsx`.

- [ ] **Step 1: Write the failing tests** em `navigation.test.ts`:
  - `it("Meu rendimento shows only with a team profile")`
  - `it("Rendimento da equipe only for tenant_admin")`
  - `it("expert sections include /expert/rendimento")`
  - `it("person report path keeps Rendimento da equipe active")`
- [ ] **Step 2: Run** `npx vitest run src/lib/navigation.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** (inclui o placeholder das rotas e o redirect)
- [ ] **Step 4: Verify** — `npm run build` (regenera o route tree), `npx vitest run src/lib/navigation.test.ts`, typecheck gate, `npx eslint` nos arquivos tocados
- [ ] **Step 5: Commit** (`feat(rendimento): navigation and routes for the report pages`)

---

### Task 6: Componente do relatório e histórico do lead

**Files:**
- Create: `src/components/rendimento/report-view.tsx` (blocos 1 a 6)
- Create: `src/components/rendimento/report-cards.tsx`, `src/components/rendimento/report-funnel.tsx`, `src/components/rendimento/report-chart.tsx`, `src/components/rendimento/portfolio-table.tsx`, `src/components/rendimento/lead-history-sheet.tsx`
- Modify: `src/routes/expert.rendimento.tsx`, `src/routes/rendimento.tsx`, `src/routes/rendimento.equipe.$expertId.tsx` (montam `ReportView`)
- Modify: `src/routes/expert.index.tsx` (atalho "Ver relatório completo")
- Move: o cartão do extrato de `src/routes/experts.$expertId.tsx` para `src/components/rendimento/credit-statement.tsx`, reaproveitado no bloco 5 (o arquivo da rota já é só um redirect)

**Interfaces:**
- Consumes: Tasks 1, 3 e 5; `CentralPeriodPicker` com `EXPERT_PERIODS` (como em `src/routes/expert.index.tsx`); `ChartContainer`; `Sheet`; `ExpertFormDialog` e `setExpertActive` para "Editar" e "Desativar" no modo admin.
- Produces:
  - `ReportView({ expertId?: string })`. Sem `expertId`, é o relatório do próprio usuário; com `expertId`, é o modo admin.
    - **Cabeçalho:** nome, tipo, casa, período (padrão `DEFAULT_REPORT_PERIOD`), "Exportar CSV" (o extrato) e "Atualizado às {hh:mm}" (ou "Os créditos são calculados a cada 10 minutos." quando `atualizadoEm` for null). No modo admin, também "Editar" e "Desativar".
    - **Bloco 1:** quatro cartões com as cópias do spec, a variação ▲/▼ (verde/vermelho) ou "—", o detalhe "clique R$ X · afiliado R$ Y", "R$ {valorFtd} em 1º depósito", "R$ {valorRedeposito} · ticket R$ {ticket}" e "leads que estavam dormindo".
    - **Bloco 2:** o funil "Links gerados → Leads que clicaram ({pct}%) → Depositaram em até {janelaHoras}h ({pct}% dos que clicaram)", mais "Contatos registrados".
    - **Bloco 3:** barras empilhadas FTD × redepósito, com uma linha de depositantes.
    - **Bloco 4:** "Leads que mais depositaram".
    - **Bloco 5:** o extrato.
    - **Bloco 6:** "Leads do período", com busca (debounce), "Só FTD", "Só reativados", paginação de 50 e "Exportar CSV".
    - **Painel lateral** (`LeadHistorySheet`): resumo, linha do tempo e "Carregar mais".
      - Depósitos não creditados aparecem em cinza; a casa pinta o creditado com o motivo.
      - "Abrir ficha do lead" leva a `/expert/leads/$playerId` quando quem vê é expert, e a `/players/$playerId` para os demais.
    - **Estados vazios:** "Nenhum crédito neste período." (cartões e gráfico) e "Nenhum lead com crédito neste período." (carteira).
- [ ] **Step 1: Implement**, seguindo os padrões de `src/routes/expert.index.tsx` (gráfico, período) e `src/components/expert/*` (cartões). No mobile, uma coluna e o painel em tela cheia.
- [ ] **Step 2: Verify** — `npm run build`, typecheck gate, `npx eslint` nos arquivos tocados, `npx vitest run src/lib/navigation.test.ts`
- [ ] **Step 3: Commit** (`feat(rendimento): shared report view with lead history`)

---

### Task 7: Página Rendimento da equipe e tela Experts só de configuração

**Files:**
- Modify: `src/routes/rendimento.equipe.tsx`
- Modify: `src/routes/experts.tsx` (remove as colunas de métricas e o seletor de período; o nome passa a levar a `/rendimento/equipe/$expertId`; "Regras de crédito" continua ali)
- Create: `src/components/rendimento/team-ranking.tsx`

**Interfaces:**
- Consumes: `getTeamReport` e `exportTeamReportCsv` (Task 4); `ExpertSettingsDialog` (fase 3).
- Produces:
  - **`/rendimento/equipe`:**
    - período (padrão Este mês) e "Atualizado às…";
    - quatro cartões de topo: "Total creditado à equipe" com "· {pct}% do depositado na casa", "FTDs da equipe" com "· {pct}% dos FTDs da casa", "Redepósitos" e "Reativados";
    - ranking com as colunas do spec §5, cabeçalhos ordenáveis no cliente e badge "Inativo";
    - o nome leva ao relatório da pessoa;
    - botões "Exportar CSV" e "Regras de crédito".
  - **`/experts`:** só cadastro e configuração, com as ações e os cartões atuais.
- [ ] **Step 1: Implement**
- [ ] **Step 2: Verify** — `npm run build`, typecheck gate, `npx eslint` nos arquivos tocados
- [ ] **Step 3: Commit** (`feat(rendimento): team performance page; Experts back to configuration`)

---

### Task 8: Verificação e produção

- [ ] **Step 1:** `npm run typecheck` (gate), `npm run lint`, `npm test` e `npm run build`. Registrar as saídas.
- [ ] **Step 2:** Com autorização explícita da usuária:
  - conferir que os números das duas migrations continuam livres em produção (`schema_migrations`);
  - aplicar as duas migrations e registrá-las;
  - verificação só leitura: `expert_report` e `expert_team_report` respondem numa casa com experts.
- [ ] **Step 3:** Merge em `main` e push, com autorização da usuária.
