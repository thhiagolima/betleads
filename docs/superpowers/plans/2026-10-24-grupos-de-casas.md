# Grupos de casas e painel financeiro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grupos de casas com gestores de grupo, fechamento financeiro por casa (substitui `docs/Pixreals Fechamento.xlsx`) e painel do grupo com placar, comparativos e metas.

**Architecture:** Novas tabelas Postgres (grupos, financeiro, metas) com RLS só de leitura e funções SQL `security definer` que concentram **todas** as regras de permissão. As funções de servidor TanStack usam o client service-role e chamam essas funções SQL via `rpc` antes de ler ou gravar. As contas da planilha ficam num módulo TS puro (`src/lib/finance/calc.ts`), testado contra os números reais de outubro da planilha. A área do grupo é um conjunto de rotas `/grupo*` com menu próprio. O grupo ativo fica em `localStorage`, sem tocar no header `X-Active-Tenant`.

**Tech Stack:** Supabase Postgres (migrações SQL, PGlite nos testes), TanStack Start (`createServerFn`), React + react-query, shadcn/ui, vitest, zod v4.

**Spec:** `docs/superpowers/specs/2026-10-24-grupos-de-casas-design.md`. Leia o spec inteiro antes da primeira tarefa. Este plano não repete o porquê.

## Global Constraints

- **Nenhum acesso herdado.** As funções existentes `has_tenant_access`, `accessible_tenant_ids`, `managed_tenant_ids` e `current_tenant_id` **não podem mudar**. O gestor de grupo só lê dados financeiros e de grupo, e só pelas funções novas.
- Dias no fuso `America/Sao_Paulo` (mesmo corte de `refresh_tenant_daily_metric_day`).
- **Fórmula do resultado do dia**, exatamente:
  `Net − round2(GGR × tx_ggr) − round2(Dep × tx_mov) − round2(Saq × tx_mov) − round2(Net × tx_mov) − Anúncios`
  - vale inclusive com Net negativo, sem "corrigir";
  - `round2` imita o `ROUND(x;2)` do Excel: meio arredonda para longe do zero.
- **Taxas padrão** quando a casa não tem taxa cadastrada: GGR 16%, movimentação 2,7% (valores da planilha).
- **Faixas de cor das metas:**
  - verde quando bate a meta;
  - amarelo até 20% longe: `≥` com valor ≥ 80% da meta, `≤` com valor ≤ 120% da meta;
  - vermelho quando está mais longe;
  - meta ≤ 0 só tem verde e vermelho;
  - cinza quando há dia pendente numa métrica que depende de dado manual.
- **Uma casa pertence a no máximo um grupo.** Grupo demo só tem casas demo, e grupo real só tem casas reais.
- **Lançamentos retroativos** são permitidos para qualquer data ≤ hoje (Brasília). Datas futuras são rejeitadas. Não há trava de mês.
- **Toda escrita gera auditoria:**
  - ações de casa vão para `tenant_audit_logs`, com os nomes de ação listados nas tarefas;
  - ações de grupo do super admin vão para `admin_audit_logs`, pelo writer que já existe em `src/lib/admin.functions.ts`.
- **Textos de interface em pt-BR.** Valores em R$ com `Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })`.
- Rodar `npm run build` antes de declarar uma tarefa de UI pronta. Ele pega vazamentos de `*.server` para o bundle do client, que testes e typecheck não pegam.

## Review Focus

1. **Gestor de grupo tentando ler ou escrever fora do grupo**, por exemplo com um `tenantId` de outra casa na chamada: deve dar erro de permissão. Testado nas Tasks 2, 4 e 5.
2. **Gestor de grupo que não tem papel na casa chamando uma função operacional existente** (ex.: `getTenantManagementConsole` com essa casa): continua negado. Testado na Task 4.
3. **Mês com dias pendentes**: os totais de Net, Resultado e ROI somam só os dias completos. A meta de uma métrica manual fica cinza, e as métricas do CRM continuam somando. Testado na Task 3.
4. **Alterar taxa ou meta no meio do mês**: os dias anteriores mantêm a taxa ou meta antiga. A meta de soma de um período é Σ das metas diárias da época. Testado nas Tasks 2 e 3.
5. **Reset da demo**: o vínculo da casa demo com o grupo demo sobrevive, e os dados financeiros inventados são recriados. Testado na Task 9.

---

## File Structure

**Migrações** (`supabase/migrations/`):
- `20261101100000_tenant_groups.sql`: grupos, vínculos casa ↔ grupo e gestores de grupo; funções `group_*`; guards de demo.
- `20261101100100_tenant_finance.sql`: lançamentos diários, outros custos, taxas, liberações e metas; funções `finance_can_*`, `finance_days` e `finance_goal_days`.

**Servidor** (`src/lib/`):
- `tenant-audit.server.ts`: `auditTenant`, extraído de `tenants.functions.ts`.
- `finance/calc.ts`: contas puras (dia, período, metas, intervalos de datas).
- `finance/types.ts`: tipos compartilhados entre o servidor e a UI.
- `groups.functions.ts`: CRUD de grupos pelo super admin, "meus grupos", pessoas do grupo e painel do grupo.
- `finance.functions.ts`: mês da casa, lançamentos, outros custos, taxas, liberações e metas.
- `tenants.functions.ts` (modificar): o gestor de grupo gerencia pessoas; o seletor passa a incluir grupos e `can_view_finance`.

**UI:**
- `src/hooks/use-active-group.ts`.
- `src/components/finance/`: `finance-month-grid.tsx`, `finance-other-costs.tsx`, `finance-settings-panel.tsx`, `format.ts`.
- `src/components/group/`: `group-scoreboard.tsx`, `group-period-bar.tsx`, `group-totals.tsx`, `group-goals-editor.tsx`, `group-people.tsx`.
- Rotas:
  - `src/routes/financeiro.tsx`: `/financeiro`, a casa ativa.
  - `src/routes/grupo.tsx`: `/grupo`, o painel.
  - `src/routes/grupo_.casa.tsx`: `/grupo/casa?tenant=`.
  - `src/routes/grupo_.metas.tsx`.
  - `src/routes/grupo_.pessoas.tsx`.
  - `src/routes/grupos.tsx`: `/grupos`, gestão de grupos pelo super admin.
- Modificar:
  - `src/lib/navigation.ts`: `GROUP_SECTIONS`, a regra `requires: "finance"` e `ROUTE_META`;
  - `src/components/shell/use-shell-nav.ts`;
  - `src/components/active-tenant-switcher.tsx`.

**Demo:**
- `scripts/demo/clone-plan.mjs`: classificar as tabelas novas.
- `scripts/demo/seed-demo-finance.mjs`: novo.
- `scripts/demo/clone-core.mjs`: chamar o seed.

---

### Task 1: Esquema de grupos e funções de acesso

**Files:**
- Create: `supabase/migrations/20261101100000_tenant_groups.sql`
- Test: `src/lib/tenant-groups.db.test.ts`. Use o padrão A de `src/lib/demo-tenant-flag.db.test.ts`:
  - SCHEMA com stubs de `auth.users` (com `raw_app_meta_data`), `public.tenants` (com `is_demo`), `public.user_roles`, `app_role` e `public.is_super_admin(_user_id uuid)`;
  - aplicar a migração duas vezes, para provar que é idempotente.

**Interfaces:**
- Produces (tabelas):
  - `public.tenant_groups(id uuid pk default gen_random_uuid(), nome text not null check (length(trim(nome)) > 0), is_demo boolean not null default false, created_at timestamptz default now(), created_by uuid)`
  - `public.tenant_group_tenants(group_id uuid references tenant_groups on delete cascade, tenant_id uuid unique references tenants on delete cascade, created_at, primary key (group_id, tenant_id))`. O `unique` em `tenant_id` garante no máximo um grupo por casa.
  - `public.tenant_group_managers(group_id uuid references tenant_groups on delete cascade, user_id uuid references auth.users on delete cascade, created_at, created_by uuid, primary key (group_id, user_id))`
- Produces (funções `security definer stable set search_path = public`, executáveis por `authenticated, service_role`):
  - `group_ids_managed_by(_user uuid) returns setof uuid`: todos os grupos se `is_super_admin(_user)`; senão, os grupos em que ele é gestor.
  - `can_view_group(_user uuid, _group uuid) returns boolean`
  - `is_group_manager_of_tenant(_user uuid, _tenant uuid) returns boolean`: só gestor de grupo de verdade. Super admin **não** conta aqui.
  - `group_tenant_ids(_group uuid) returns setof uuid`
- Produces (guards e códigos de erro):
  - trigger em `tenant_group_tenants`: `tenants.is_demo` tem que ser igual a `tenant_groups.is_demo`, senão `raise exception 'GROUP_DEMO_MISMATCH'`;
  - trigger em `tenant_groups`: update de `is_demo` dá `'GROUP_DEMO_IMMUTABLE'`;
  - trigger em `tenant_group_managers`: se `auth.users.raw_app_meta_data->>'is_demo_user' = 'true'`, o grupo tem que ser `is_demo`, senão `'DEMO_USER_GROUP_VIOLATION'`.
- RLS ligado nas três tabelas:
  - select para `authenticated` quando `can_view_group(auth.uid(), group_id)` (ou `id`);
  - nenhuma policy de escrita: só o service_role escreve;
  - `grant select ... to authenticated; grant all ... to service_role`.

- [ ] **Step 1: Escrever os testes que falham**, com estes nomes e asserts:
  - `"a house belongs to at most one group"`: o segundo insert da mesma casa em outro grupo dá erro de unique.
  - `"demo house cannot join a real group"` e `"real house cannot join a demo group"`: `.rejects.toThrow(/GROUP_DEMO_MISMATCH/)`.
  - `"group is_demo cannot change"`: `/GROUP_DEMO_IMMUTABLE/`.
  - `"demo user can only manage demo groups"`: `/DEMO_USER_GROUP_VIOLATION/`. Inserir num grupo demo funciona.
  - `"group_ids_managed_by"`: o gestor de G1 recebe `[G1]`, o gestor de G1 e G2 recebe os dois, o super admin recebe todos, e um estranho recebe `[]`.
  - `"is_group_manager_of_tenant is false for super admin without group role and for houses outside the group"`.
  - `"authenticated sees only own groups via RLS"`: com `request.jwt.claims` `{sub: managerG1, role: "authenticated"}`, `select id from tenant_groups` retorna só G1.
- [ ] **Step 2: Rodar** `npx vitest run src/lib/tenant-groups.db.test.ts`. Esperado: FAIL (a migração ainda não existe).
- [ ] **Step 3: Escrever a migração.**
- [ ] **Step 4: Rodar o mesmo comando.** Esperado: PASS.
- [ ] **Step 5: Commit** `feat(db): tenant groups schema and access helpers`.

---

### Task 2: Esquema financeiro, permissões e funções de dados

**Files:**
- Create: `supabase/migrations/20261101100100_tenant_finance.sql`
- Test: `src/lib/tenant-finance.db.test.ts`. Mesmo padrão: aplicar a migração da Task 1 + esta, sobre stubs de:
  - `players(id, tenant_id, ftd_em)`;
  - `deposits(id, tenant_id, player_id, valor, status, created_at, completed_at)`;
  - `tenant_daily_metrics` (as colunas reais);
  - `marketing_ad_metrics_daily(tenant_id, provider, metric_date, spend)`.

**Interfaces:**
- Consumes: as funções e tabelas da Task 1 e `is_super_admin(_user_id uuid)`.
- Produces (tabelas, todas com RLS de select `finance_can_view(auth.uid(), tenant_id)` e escrita só pelo service_role):
  - `tenant_finance_daily(tenant_id uuid references tenants on delete cascade, metric_date date, ad_spend numeric(14,2) check (ad_spend >= 0), ggr numeric(14,2), updated_by uuid, updated_at timestamptz default now(), primary key (tenant_id, metric_date))`. `null` significa "não lançado".
  - `tenant_finance_other_costs(id uuid pk, tenant_id, month date check (extract(day from month) = 1), descricao text not null, valor numeric(14,2) not null check (valor >= 0), created_by, created_at, updated_at)`
  - `tenant_finance_rates(tenant_id, valid_from date, ggr_fee_pct numeric(6,3) check (between 0 and 100), movement_fee_pct numeric(6,3) check (between 0 and 100), updated_by, updated_at, primary key (tenant_id, valid_from))`
  - `tenant_finance_viewers(tenant_id, user_id references auth.users on delete cascade, granted_by, created_at, primary key (tenant_id, user_id))`
  - `tenant_goals(tenant_id, metric text check (metric in ('registrations','ftds','deposits','net','cash_result','cost_per_registration','cost_per_ftd','roi')), valid_from date, direction text check (direction in ('gte','lte')), daily_value numeric(14,4), updated_by, updated_at, primary key (tenant_id, metric, valid_from))`. Com `daily_value null`, a meta foi removida a partir de `valid_from`.
- Produces (permissões, todas `(_user uuid, _tenant uuid) returns boolean`, `security definer stable`, para `authenticated, service_role`):

  | Função | Retorna true para |
  |---|---|
  | `finance_can_view` | super admin; admin da casa; `is_group_manager_of_tenant`; `gestor` da casa **com** linha em `tenant_finance_viewers` |
  | `finance_can_edit_values` | super admin; admin da casa |
  | `finance_can_edit_rates` | super admin; admin; gestor do grupo |
  | `finance_can_manage_viewers` | igual a `finance_can_edit_rates` |
  | `finance_can_manage_goals` | super admin; gestor do grupo |

- Produces (dados, `security definer stable`, **só `service_role`**):
  - `finance_days(_tenants uuid[], _from date, _to date) returns table(tenant_id uuid, metric_date date, registrations int, ftds int, ftd_deposit_amount numeric, deposit_amount numeric, withdrawal_amount numeric, ad_spend numeric, ad_spend_suggested numeric, ggr numeric, ggr_fee_pct numeric, movement_fee_pct numeric)`
    - uma linha por casa × dia (`generate_series`), mesmo sem dados;
    - os campos do CRM vêm de `tenant_daily_metrics`, com coalesce para 0;
    - `ftd_deposit_amount` = soma, para os players da casa com `(ftd_em at time zone 'America/Sao_Paulo')::date = dia`, do `valor` do primeiro depósito `status = 'aprovado'` (ordenado por `coalesce(completed_at, created_at)`) via `lateral ... limit 1`;
    - `ad_spend_suggested` = `sum(spend)` de `marketing_ad_metrics_daily` com `provider = 'meta'` naquele dia, ou null se não houver linha;
    - taxas = a linha de `tenant_finance_rates` com o maior `valid_from <= dia`, senão 16 e 2.7.
  - `finance_goal_days(_tenants uuid[], _from date, _to date) returns table(tenant_id uuid, metric_date date, metric text, direction text, daily_value numeric)`
    - para cada casa × dia × métrica, a linha com o maior `valid_from <= dia`;
    - omite quando não há linha ou quando `daily_value` é null.
- Antes de escrever o `lateral`, rode no banco de produção, só leitura e pelo pooler (memória `db-access-pooler`): `select indexdef from pg_indexes where tablename='deposits'`.
  - Se não houver índice começando por `player_id`, acrescente na migração `create index if not exists deposits_player_id_created_idx on public.deposits (player_id, created_at) where status = 'aprovado';`.
  - Avise no relatório da tarefa que esse índice será criado em produção.

- [ ] **Step 1: Escrever os testes que falham:**
  - `"finance_can_view matrix"`: admin true; gestor sem liberação false; gestor com liberação true; gestor de grupo true; gestor do grupo G1 numa casa de G2 false; super admin true; `member` com liberação false.
  - `"finance_can_edit_values: group manager is false"`.
  - `"finance_can_manage_goals: tenant admin is false, group manager true"`.
  - `"finance_days returns one row per tenant-day with CRM zeros"`: 3 dias, 2 casas, 6 linhas.
  - `"finance_days uses the rate valid on each day"`: taxa de 16% desde 2026-10-01 e 18% desde 2026-10-10. O dia 9 traz 16, o dia 10 traz 18, e uma casa sem linha traz 16 e 2.7.
  - `"ftd_deposit_amount sums only the first approved deposit of players whose ftd_em is that day"`. Cenário: o player A tem `ftd_em` no dia 5 (SP), com depósitos aprovados de 50 e depois 100 e um pendente de 999. Esperado: 50.
  - `"ftd day boundary is Sao Paulo"`: `ftd_em = '2026-10-06 02:30Z'` cai no dia 5.
  - `"finance_goal_days applies goal history and removal"`: meta de 100 desde o dia 1, 120 desde o dia 10 e null desde o dia 20. Dia 9 = 100, dia 10 = 120, dia 20 sem linha.
  - `"RLS: authenticated gestor without grant reads no tenant_finance_daily rows"`.
- [ ] **Step 2: Rodar** `npx vitest run src/lib/tenant-finance.db.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Escrever a migração.**
- [ ] **Step 4: Rodar o mesmo comando.** Esperado: PASS.
- [ ] **Step 5: Commit** `feat(db): tenant finance schema, permissions and day functions`.

---

### Task 3: Contas puras da planilha

**Files:**
- Create: `src/lib/finance/types.ts`, `src/lib/finance/calc.ts`
- Create: `src/lib/finance/__fixtures__/pixreals-outubro.json`, gerado a partir da planilha
- Test: `src/lib/finance/calc.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type GoalMetric = "registrations"|"ftds"|"deposits"|"net"|"cash_result"|"cost_per_registration"|"cost_per_ftd"|"roi";
  export type GoalDirection = "gte"|"lte";
  export type GoalStatus = "green"|"yellow"|"red"|"gray";
  export type FinanceDayInput = { date: string; registrations: number; ftds: number; ftdDepositAmount: number;
    depositAmount: number; withdrawalAmount: number; adSpend: number|null; adSpendSuggested: number|null;
    ggr: number|null; ggrFeePct: number; movementFeePct: number };
  export type FinanceDay = FinanceDayInput & { pending: boolean; net: number|null; ggrFee: number|null;
    movementFee: number|null; cashResult: number|null; roi: number|null; costPerRegistration: number|null; costPerFtd: number|null };
  export type PeriodSummary = { days: number; pendingDays: number; registrations: number; ftds: number;
    ftdDepositAmount: number; depositAmount: number; withdrawalAmount: number; adSpend: number; ggr: number;
    net: number; ggrFee: number; movementFee: number; otherCosts: number|null; cashResult: number;
    roi: number|null; costPerRegistration: number|null; costPerFtd: number|null; avgDailyCashResult: number|null };
  export type GoalDay = { date: string; metric: GoalMetric; direction: GoalDirection; dailyValue: number };
  export type GoalEvaluation = { metric: GoalMetric; direction: GoalDirection; target: number; value: number|null; status: GoalStatus };
  export type DateRange = { from: string; to: string };   // "YYYY-MM-DD", inclusivo
  export type PeriodPreset = "today"|"yesterday"|"7d"|"month"|"custom";
  export type CompareMode = "previous"|"same_weekday_last_week"|"last_week";
  ```
- Produces (`calc.ts`):
  - `round2(x: number): number`: igual ao Excel, com meio para longe do zero; `round2(1.005) === 1.01`, `round2(-0.005) === -0.01`.
  - `computeDay(d: FinanceDayInput): FinanceDay`
    - `pending = adSpend === null || ggr === null`;
    - quando pendente: `net`, as taxas, `cashResult` e `roi` ficam null;
    - `costPerRegistration` e `costPerFtd` são null quando `adSpend` é null ou o divisor é 0;
    - `roi` é null quando `adSpend === 0`.
  - `summarize(days: FinanceDay[], otherCosts: number|null): PeriodSummary`
    - `registrations`, `ftds`, os depósitos, os saques e o `adSpend` (só os confirmados) somam **todos** os dias;
    - `net`, `ggr`, as taxas e `cashResult` somam só os dias **não pendentes**;
    - `cashResult` = Σ dos resultados dos dias completos − (`otherCosts ?? 0`);
    - `roi` = `cashResult` ÷ Σ `adSpend` dos dias completos, null se esse Σ for 0;
    - `costPerFtd` = `adSpend` ÷ `ftds`, e `costPerRegistration` = `adSpend` ÷ `registrations`, ambos null quando o divisor é 0;
    - `avgDailyCashResult` = `cashResult` ÷ número de dias completos, ou null.
  - `metricValue(s: PeriodSummary, m: GoalMetric): number|null`. O mapeamento é `deposits → depositAmount`, `cash_result → cashResult`.
  - `isSumMetric(m: GoalMetric): boolean`: true para registrations, ftds, deposits, net e cash_result.
  - `dependsOnManual(m: GoalMetric): boolean`: false só para registrations, ftds e deposits.
  - `evaluateGoal(goalDays: GoalDay[], summary: PeriodSummary, range: DateRange): GoalEvaluation|null`
    - os `goalDays` já vêm filtrados para uma casa e uma métrica;
    - retorna null se não houver nenhum;
    - métrica de soma: `target` = Σ `dailyValue`;
    - métrica de razão: `target` = o `dailyValue` do último dia ≤ `range.to`;
    - `direction` = a do último dia;
    - status cinza quando `dependsOnManual && summary.pendingDays > 0` ou quando `value === null`;
    - fora isso, aplica as faixas das Global Constraints.
  - `presetRange(p: Exclude<PeriodPreset,"custom">, now: Date): DateRange`
    - "hoje" é calculado em `America/Sao_Paulo` com `Intl.DateTimeFormat("en-CA", { timeZone })`;
    - `7d` = os 7 dias até hoje, inclusive;
    - `month` = do dia 1 até hoje.
  - `compareRange(r: DateRange, mode: CompareMode, preset: PeriodPreset): DateRange`
    - `previous`: a janela do mesmo tamanho imediatamente antes. Com `preset === "month"`, vai do dia 1 do mês anterior até `min(mesmo dia, último dia do mês anterior)`;
    - `last_week`: a janela deslocada 7 dias para trás;
    - `same_weekday_last_week`: igual a `last_week`. A UI só oferece essa opção para janelas de 1 dia.
  - `pctChange(cur: number|null, prev: number|null): number|null`: null quando `prev` é null ou 0.

- [ ] **Step 1: Gerar a fixture a partir da planilha**:
  ```bash
  python -c "import openpyxl,json;ws=openpyxl.load_workbook('docs/Pixreals Fechamento.xlsx',data_only=True)['Outubro'];rows=[dict(date=r[0].strftime('%Y-%m-%d'),ads=r[1],registrations=r[2],ftds=r[4],ftdDeposits=r[6],deposits=r[7],withdrawals=r[8],net=r[9],ggr=r[10],roi=r[11],cashResult=r[12]) for r in ws.iter_rows(min_row=2,max_row=32,values_only=True) if r[1] is not None];json.dump(rows,open('src/lib/finance/__fixtures__/pixreals-outubro.json','w'),indent=1)"
  ```
  Esperado: 20 linhas, de 2026-10-01 a 2026-10-20.
- [ ] **Step 2: Escrever os testes que falham:**
  - `"matches every October day of the spreadsheet"`: para cada linha da fixture, com taxas 16 e 2.7, `computeDay(...).cashResult` fica `toBeCloseTo(row.cashResult, 2)` e `net` fica `toBeCloseTo(row.net, 2)`.
  - `"matches the October month close"`: `summarize(all, 0)`. `cashResult` ≈ 43706.07, `movementFee` ≈ 27979.78, `ggrFee` ≈ 39431.51, `adSpend` ≈ 113362.15, `roi` ≈ 0.3855437639 (6 casas), `avgDailyCashResult` ≈ 2185.3035.
  - `"negative net lowers the movement fee"`: dep 100, saq 300, ggr 0, ads 0. Resultado = −200 − 2.7 − 8.1 − (−5.4) = −205.4.
  - `"pending days"`: 3 dias, com o do meio sem GGR. `pendingDays === 1`; `ftds` soma os 3; `cashResult` soma só 2; a meta `cash_result ≥ 0` fica `"gray"`; a meta `ftds ≥ 1` não fica cinza.
  - `"other costs only reduce the period result when provided"`.
  - `"goal bands"`, com uma tabela de casos:
    - `gte` 100: 100 green, 80 yellow, 79 red;
    - `lte` 90: 90 green, 108 yellow, 109 red;
    - `gte` 0 (ROI): 0.01 green, −0.01 red.
  - `"sum goal target is the sum of each day's goal"`: 100 nos dias 1–9 e 120 no dia 10, com range de 1 a 10 → `target` 1020.
  - `"ratio goal uses the last day's value"`.
  - `"presetRange uses Sao Paulo"`: `now = 2026-10-25T02:00Z` → today `2026-10-24`.
  - `"compareRange"`:
    - `previous` de `2026-10-10..2026-10-16` → `2026-10-03..2026-10-09`;
    - `month` de `2026-03-01..2026-03-31` → `2026-02-01..2026-02-28`;
    - `month` de `2026-10-01..2026-10-24` → `2026-09-01..2026-09-24`;
    - `last_week` de `2026-10-24..2026-10-24` → `2026-10-17..2026-10-17`.
  - `"round2 matches Excel"`.
- [ ] **Step 3: Rodar** `npx vitest run src/lib/finance/calc.test.ts`. Esperado: FAIL.
- [ ] **Step 4: Implementar** `types.ts` e `calc.ts`.
- [ ] **Step 5: Rodar o mesmo comando.** Esperado: PASS.
- [ ] **Step 6: Commit** `feat(finance): spreadsheet math, goals and date ranges`.

---

### Task 4: Grupos no servidor (super admin, seletor e pessoas)

**Files:**
- Create: `src/lib/tenant-audit.server.ts`. Move para cá o `auditTenant` de `tenants.functions.ts`, exportado com a mesma assinatura, e `tenants.functions.ts` passa a importá-lo.
- Create: `src/lib/groups.functions.ts`
- Modify: `src/lib/tenants.functions.ts`: `canManageTenant`, `addUserToTenantFor`, `updateTenantUserRole`, `removeUserFromTenant`, `getTenantSwitcherFor`.
- Test: `src/lib/groups.functions.test.ts` e `src/lib/tenant-group-people.test.ts`. Use o padrão `createFakeDb` de `src/lib/demo-action-guard.coverage.test.ts`, com `onRpc` para as funções SQL.

**Interfaces:**
- Consumes: as RPCs `is_super_admin`, `group_ids_managed_by`, `is_group_manager_of_tenant` e `finance_can_view` (Tasks 1 e 2).
- Produces (`groups.functions.ts`), cada uma como `createServerFn` + uma função `xxxFor(ctx, data)` exportada, no padrão de `tenants.functions.ts`:
  - Só super admin (senão `Error("Apenas o super admin pode gerenciar grupos")`), com auditoria em `admin_audit_logs`:

    | Função | Ação de auditoria |
    |---|---|
    | `listGroupsAdminFor(ctx)` → `{ groups: Array<{ id, nome, is_demo, tenants: {id,nome}[], managers: {user_id,email}[] }>, ungroupedTenants: {id,nome,is_demo}[] }` | — |
    | `createGroupFor(ctx, { nome, isDemo })` → `{ id }` | `group.created` |
    | `renameGroupFor(ctx, { groupId, nome })` | `group.renamed` |
    | `deleteGroupFor(ctx, { groupId })` | `group.deleted` |
    | `setGroupTenantsFor(ctx, { groupId, tenantIds: string[] })`: substitui o conjunto. O erro de unique do Postgres vira `Error("A casa já pertence a outro grupo")` | `group.tenants_changed` |
    | `addGroupManagerFor(ctx, { groupId, email })`: o usuário tem que existir (sem convite) e não pode ser super admin | `group.manager_added` |
    | `removeGroupManagerFor(ctx, { groupId, userId })` | `group.manager_removed` |

  - Gestor de grupo:
    - `getGroupPeopleFor(ctx, { groupId })` → `{ tenants: Array<{ id, nome, is_demo, members: Array<{ user_id, email, role, canViewFinance }> }> }`
      - exige `group_ids_managed_by` contendo `groupId`;
      - reutiliza a busca de membros de `buildTenantDetail`; extraia essa busca para um helper exportado se precisar.
- Mudanças em `tenants.functions.ts`:
  - `canManageTenant`: true também quando `is_group_manager_of_tenant(ctx.userId, tenantId)`.
  - Em `addUserToTenantFor`, `updateTenantUserRole` e `removeUserFromTenant`, a regra "Apenas o super admin pode definir o admin" vira `actorCanSetAdmin = superAdmin || isGroupManagerOfTenant`. A regra de pelo menos um admin continua. O guard demo continua.
  - `getTenantSwitcherFor` passa a retornar `{ activeTenantId, tenants: Array<{ ...atual, can_view_finance: boolean }>, groups: Array<{ id, nome, is_demo }> }`.
    - `can_view_finance` vem da RPC `finance_can_view`, uma chamada por casa;
    - `groups` vem de `group_ids_managed_by` + `tenant_groups`, ordenado por nome.
  - `getTenantManagementConsole` e `getAccessibleTenants` **não** mudam.

- [ ] **Step 1: Escrever os testes que falham:**
  - `"non super admin cannot create groups"`.
  - `"setGroupTenants maps unique violation to friendly error"`.
  - `"addGroupManager rejects super admin targets"`.
  - `"group manager can add an admin to a house of the group"`: `addUserToTenantFor` com `role: "admin"`, a RPC `is_group_manager_of_tenant` → true; resolve.
  - `"group manager cannot manage a house outside the group"`: a RPC retorna false, então `/Sem permissão/`.
  - `"house admin still cannot set admin and still can add gestor"`.
  - `"group manager without house role is still denied by getTenantManagementConsole"` (Review Focus 2).
  - `"switcher returns groups and can_view_finance"`.
  - `"getGroupPeople rejects a group the user does not manage"`.
- [ ] **Step 2: Rodar** `npx vitest run src/lib/groups.functions.test.ts src/lib/tenant-group-people.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar.** As funções de grupo **não** chamam `assertTenantNotDemo`, porque a demo entra em grupo de propósito. Os guards SQL da Task 1 garantem a separação entre demo e real. Não as acrescente às `entries` de `demo-action-guard.coverage.test.ts`.
- [ ] **Step 4: Rodar** os testes acima e `npx vitest run src/lib/demo-action-guard.coverage.test.ts src/lib/demo-global-views.test.ts`. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(groups): super admin group management and group-manager people rights`.

---

### Task 5: Financeiro no servidor (casa e painel do grupo)

**Files:**
- Create: `src/lib/finance.functions.ts`
- Test: `src/lib/finance.functions.test.ts` (fake db; `onRpc("finance_days")` e `onRpc("finance_goal_days")` retornam linhas fixas)

**Interfaces:**
- Consumes: as RPCs da Task 2 e `computeDay`, `summarize`, `evaluateGoal`, `compareRange` e `pctChange` da Task 3.
- Produces. Todas exigem a permissão indicada, senão `Error("Sem permissão")`. Todas as escritas chamam `assertTenantNotDemo(tenantId)` e entram nas `entries` de `demo-action-guard.coverage.test.ts`. A demo só recebe dados pelo seed (Task 9).

  | Função | Permissão | Auditoria (`tenant_audit_logs`) |
  |---|---|---|
  | `getTenantFinanceMonthFor(ctx, { tenantId, month: "YYYY-MM" })` → `{ tenant: {id,nome}, days: FinanceDay[], summary: PeriodSummary, otherCosts: Array<{id,descricao,valor}>, rates: { current: {ggrFeePct,movementFeePct,validFrom:string|null}, history: Array<{validFrom,ggrFeePct,movementFeePct}> }, viewers: Array<{user_id,email,canView}> (gestores da casa; vazio se não puder gerenciar), goals: GoalEvaluation[] (mês inteiro), permissions: { canEditValues, canEditRates, canManageViewers, canManageGoals } }`. Os dias futuros do mês corrente não aparecem. | `finance_can_view` | — |
  | `saveFinanceDaysFor(ctx, { tenantId, entries: Array<{ date, adSpend?: number\|null, ggr?: number\|null }> })`. Até 62 entradas. Campo ausente = não muda; `null` = limpa. Data > hoje (SP) → `Error("Data futura não permitida")`. `adSpend < 0` é rejeitado no zod. Upsert por (tenant, data) e uma auditoria por dia alterado, com `before`/`after`. | `finance_can_edit_values` | `finance.day_updated` |
  | `saveOtherCostFor(ctx, { tenantId, id?, month: "YYYY-MM", descricao, valor })` | `finance_can_edit_values` | `finance.other_cost_saved` |
  | `deleteOtherCostFor(ctx, { tenantId, id })` | `finance_can_edit_values` | `finance.other_cost_deleted` |
  | `setFinanceRatesFor(ctx, { tenantId, validFrom?: string (default hoje SP), ggrFeePct, movementFeePct })`. Upsert em (tenant, validFrom). | `finance_can_edit_rates` | `finance.rates_changed` |
  | `setFinanceViewerFor(ctx, { tenantId, userId, canView })`. O alvo tem que ser `gestor` da casa, senão `Error("Só gestores da casa podem ser liberados")`. | `finance_can_manage_viewers` | `finance.viewer_changed` |
  | `setTenantGoalFor(ctx, { tenantId, metric, direction, dailyValue: number\|null, validFrom?: string (default hoje SP) })` | `finance_can_manage_goals` | `finance.goal_changed` |
  | `getGroupOverviewFor(ctx, { groupId, range: DateRange, compare: CompareMode, preset: PeriodPreset })` → `{ group: {id,nome}, range, compareRange, totals: { current: PeriodSummary, previous: PeriodSummary }, tenants: Array<{ id, nome, current: PeriodSummary, previous: PeriodSummary, goals: GoalEvaluation[] }> }` | `group_ids_managed_by` contém `groupId` | — |

- Regras de `getGroupOverviewFor`:
  - Faz **uma** chamada `finance_days` para todas as casas e as duas janelas: um único `_from`/`_to` cobrindo as duas, depois particiona por data.
  - `otherCosts` entra no `summarize` só quando `range` é exatamente um mês do calendário. Nesse caso é a soma de `tenant_finance_other_costs` do mês; senão é null.
  - Os totais do grupo são `summarize` sobre a concatenação dos dias de todas as casas, com `otherCosts` somados.
  - A janela de comparação usa a mesma regra de mês.

- [ ] **Step 1: Escrever os testes que falham:**
  - `"gestor without grant cannot read month"`.
  - `"group manager reads month read-only"`: `permissions.canEditValues === false` e `canManageGoals === true`.
  - `"saveFinanceDays rejects future dates"`.
  - `"saveFinanceDays accepts past dates and audits each changed day"`: 2 entradas, 1 sem mudança → 1 auditoria.
  - `"saveFinanceDays: group manager is rejected"`.
  - `"setFinanceViewer only targets gestores"`.
  - `"overview: otherCosts only for full calendar month"`.
  - `"overview: group manager of G1 cannot read G2"` (Review Focus 1).
  - `"overview totals recompute roi from sums"`: a casa A tem ROI 2 e a casa B tem ROI 0; o ROI do total é `Σresult/Σads`, não a média.
  - `"demo writes are blocked"`: `saveFinanceDaysFor` numa casa demo → `DEMO_ACTION_BLOCKED`.
- [ ] **Step 2: Rodar** `npx vitest run src/lib/finance.functions.test.ts src/lib/demo-action-guard.coverage.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar o mesmo comando.** Esperado: PASS.
- [ ] **Step 5: Commit** `feat(finance): server functions for house month and group overview`.

---

### Task 6: Tela "Financeiro" da casa

**Files:**
- Create: `src/routes/financeiro.tsx`
- Create: `src/components/finance/format.ts`, `finance-month-grid.tsx`, `finance-other-costs.tsx`, `finance-settings-panel.tsx`
- Modify: `src/lib/navigation.ts`
  - `NavAccess.requires` ganha `"finance"`;
  - `canSee(access, role, isSuperAdmin, canViewFinance = false)` retorna `isSuperAdmin || canViewFinance` para `"finance"`;
  - `visibleSections` repassa `canViewFinance`;
  - nova entrada `link("Financeiro", "/financeiro", Wallet, { requires: "finance" })` na seção de resultados (ao lado de `/resultados`);
  - `ROUTE_META["/financeiro"]`.
- Modify: `src/components/shell/use-shell-nav.ts`: passa `active?.can_view_finance`.
- Test: `src/lib/navigation.test.ts` (estender) e `src/components/finance/format.test.ts`.

**Interfaces:**
- Consumes: as funções da Task 5 e `useActiveTenant()` (agora com `can_view_finance`).
- Produces: `<FinanceMonthView tenantId={string} readOnly?={boolean} />`, exportado de `finance-month-grid.tsx`. É reutilizado pela Task 7 em `/grupo/casa`.

**Comportamento:**
- Seletor de mês (padrão: o mês atual) e uma grade com uma linha por dia e as colunas do spec §5, na ordem da planilha. Rodapé com TOTAL, MÉDIA DIÁRIA, TAXA DE MOVIMENTAÇÃO, TAXA GGR, OUTROS CUSTOS e RESULTADO DO MÊS.
- Quando `permissions.canEditValues` é true, Anúncios e GGR são inputs na própria grade:
  - editar vários dias e clicar em "Salvar alterações" envia um único `saveFinanceDays`;
  - se o dia tem `adSpendSuggested` e `adSpend` está vazio, o input mostra a sugestão como placeholder, com um botão "usar valor da Meta".
- Dia pendente aparece com o rótulo "pendente" nas colunas calculadas.
- `finance-other-costs.tsx`: lista do mês com adicionar, editar e excluir.
- `finance-settings-panel.tsx`:
  - taxas atuais + histórico; edição quando `canEditRates`, com o campo "vale a partir de" (padrão hoje);
  - liberação por gestor (switches) quando `canManageViewers`.
- Casa demo: os inputs ficam desabilitados com `DemoDisabledTooltip`, igual a `creditos-sms.tsx`.

- [ ] **Step 1: Testes que falham:**
  - em `navigation.test.ts`: `"finance link visible only with can_view_finance or super admin"`;
  - em `format.test.ts`: `formatBRL(1234.5) === "R$ 1.234,50"` (normalize o NBSP), `formatPct(0.3855) === "38,6%"` e `formatRatio(null) === "n.a."`.
- [ ] **Step 2: Rodar** `npx vitest run src/lib/navigation.test.ts src/components/finance/format.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar a rota e os componentes.**
- [ ] **Step 4: Rodar** os testes acima, depois `npm run typecheck` e `npm run build`. Esperado: tudo PASS.
- [ ] **Step 5: Commit** `feat(finance): house financial close page`.

---

### Task 7: Área do grupo (seletor, menu, painel, casa, metas e pessoas)

**Files:**
- Create: `src/hooks/use-active-group.ts`
  - `useActiveGroup(): { groups, active: {id,nome,is_demo}|null, setActive(id: string): void }`;
  - lê e grava em `localStorage["betleads:active-group"]`, dentro de try/catch;
  - valida contra `useActiveTenant().data.groups` e cai no primeiro grupo.
- Modify: `src/components/active-tenant-switcher.tsx`
  - seção "Grupos" no topo do dropdown quando `groups.length > 0`;
  - escolher um grupo chama `setActive(id)` e navega para `/grupo`, **sem** reload e **sem** mudar `betleads:active-tenant`;
  - escolher uma casa continua como hoje;
  - estando numa rota `/grupo*`, o rótulo do botão mostra o nome do grupo;
  - o seletor passa a aparecer quando `tenants.length + groups.length >= 2`.
- Modify: `src/lib/navigation.ts`
  - `GROUP_SECTIONS: NavSection[]` com Painel `/grupo`, Metas `/grupo/metas`, Pessoas `/grupo/pessoas` e um link "Voltar às casas" para `/`;
  - `isGroupPath(pathname: string): boolean`, que é `pathname === "/grupo" || pathname.startsWith("/grupo/")`;
  - entradas em `ROUTE_META`.
- Modify: `src/components/shell/use-shell-nav.ts`: em `isGroupPath`, `sections = GROUP_SECTIONS`.
- Create: rotas `src/routes/grupo.tsx`, `grupo_.casa.tsx`, `grupo_.metas.tsx` e `grupo_.pessoas.tsx`
- Create: `src/components/group/group-period-bar.tsx`, `group-totals.tsx`, `group-scoreboard.tsx`, `group-goals-editor.tsx` e `group-people.tsx`
- Test: `src/lib/navigation.test.ts` (`isGroupPath("/grupos") === false`, `isGroupPath("/grupo/metas") === true`) e `src/components/group/group-scoreboard.test.tsx`

**Comportamento:**
- **`/grupo`** (layout aprovado em `.superpowers/brainstorm/5093-1792850661/content/painel-grupo.html`):
  - `GroupPeriodBar` com os presets e o "comparar com". "Mesmo dia da semana passada" só aparece quando a janela tem 1 dia. O personalizado usa o `dashboard-date-range-picker.tsx` que já existe.
  - `GroupTotals` com 6 cartões: Depósitos, Saques, Net bruto, FTDs, Anúncios e Resultado caixa, cada um com `pctChange`. Quando há dias pendentes, mostra o aviso "N dias pendentes".
  - `GroupScoreboard`: tabela com uma linha por casa e as colunas Depósitos, FTDs, Custo/FTD, Net, Resultado e ROI. Cadastros e GGR ficam atrás de um toggle "mais colunas".
    - cada célula mostra o valor e a variação;
    - a célula com meta recebe a classe de status (`green`/`yellow`/`red`/`gray`) e a legenda "meta X";
    - o cabeçalho ordena a tabela;
    - clicar na linha leva a `/grupo/casa?tenant=<id>`.
  - Quando o período não é um mês fechado, aparece a nota: "Resultado sem outros custos do mês (só entram em mês fechado)".
- **`/grupo/casa`**: `<FinanceMonthView tenantId readOnly />`. A casa precisa pertencer ao grupo ativo; senão mostra "Casa fora do grupo".
- **`/grupo/metas`**: `GroupGoalsEditor`. Uma tabela por casa com as 8 métricas, e cada linha com direção, valor diário e "vale a partir de" (padrão hoje). Salvar chama `setTenantGoal`; o valor vazio remove a meta.
- **`/grupo/pessoas`**: `GroupPeople`.
  - lista por casa, vinda de `getGroupPeople`;
  - adicionar pessoa por e-mail com papel (admin, gestor ou membro), trocar papel e remover, usando `addUserToTenant`, `updateTenantUserRole` e `removeUserFromTenant`;
  - um switch "vê o financeiro" para gestores, via `setFinanceViewer`.
- Um usuário sem grupos que acessa `/grupo*` vê um estado vazio: "Você não gerencia nenhum grupo".

- [ ] **Step 1: Testes que falham:**
  - `isGroupPath`;
  - `group-scoreboard.test.tsx`: `"renders goal status class and sorts by result desc on header click"`, com o testing-library já usado em `src/components/demo-banner.test.tsx`.
- [ ] **Step 2: Rodar** `npx vitest run src/lib/navigation.test.ts src/components/group/group-scoreboard.test.tsx`. Esperado: FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar** os testes, `npm run typecheck` e `npm run build`. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(groups): group area with scoreboard, goals and people`.

---

### Task 8: Tela de grupos do super admin

**Files:**
- Create: `src/routes/grupos.tsx`
- Modify: `src/lib/navigation.ts`: `link("Grupos", "/grupos", Network)` na seção "Administração" (`requires: "super_admin"`) e `ROUTE_META["/grupos"]`.

**Comportamento:**
- Lista de grupos, cada um com casas e gestores, e o selo "demo" quando `is_demo`.
- Criar grupo (nome + checkbox "grupo de demonstração"), renomear e excluir (com `AlertDialog`).
- Gerenciar casas com um multi-select das casas sem grupo + as do próprio grupo. No grupo demo aparecem só casas demo, e no grupo real só casas reais.
- Gerenciar gestores com adicionar por e-mail e remover.

- [ ] **Step 1: Implementar.** As permissões já foram testadas na Task 4.
- [ ] **Step 2: Rodar** `npm run typecheck`, `npm run build` e `npx vitest run src/lib/navigation.test.ts`. Esperado: PASS.
- [ ] **Step 3: Commit** `feat(groups): super admin groups page`.

---

### Task 9: Demo — grupo demo e dados financeiros inventados

**Files:**
- Modify: `scripts/demo/clone-plan.mjs`
  - acrescentar `tenant_finance_daily`, `tenant_finance_other_costs`, `tenant_finance_rates`, `tenant_finance_viewers` e `tenant_goals` a `NOT_CLONED`;
  - `KEEP_ON_RESET` passa a manter também `tenant_group_tenants`.
- Create: `scripts/demo/seed-demo-finance.mjs`
  - exporta `seedDemoFinance(client, { demoTenantId, days = 60, seed = demoTenantId })`, determinístico (PRNG com semente; reutilize o que `anonymize.mjs` usar, se houver);
  - para cada dia com `tenant_daily_metrics`:
    - `ad_spend = round2(ftds × U(60,110))`;
    - `ggr = round2((approved_deposit_amount − approved_withdrawal_amount) × U(0.7,1.2))`;
  - deixa os **2 últimos dias sem GGR**, para mostrar dias pendentes;
  - taxas 16 e 2.7 desde o primeiro dia;
  - metas: `ftds ≥ ceil(média diária de FTDs × 1.1)` e `cost_per_ftd ≤ 90`;
  - outros custos do mês corrente: "CRM" R$ 1.500 e "SMS" R$ 800;
  - garante o grupo `"Grupo Demo"` (`is_demo = true`) com a casa demo, criando-o se não existir;
  - se receber `demoUserIds`, torna esses usuários gestores do grupo.
- Modify: `scripts/demo/clone-core.mjs`: chamar `seedDemoFinance` depois do bloco de `REBUILT_TABLES`, na mesma transação.
- Modify: `scripts/demo/create-demo-login.mjs`: depois de criar o login demo, inserir em `tenant_group_managers` do grupo demo, se ele existir.
- Test: `scripts/demo/seed-demo-finance.db.test.ts`, com `createMigratedDb()` de `scripts/demo/test-support/migrated-pglite.mjs`.

- [ ] **Step 1: Testes que falham:**
  - `"seed is deterministic"`: rodar duas vezes deixa as mesmas linhas;
  - `"last two days are pending"`;
  - `"demo group exists with the demo tenant and survives reset"`: simular o delete de reset do `clone-core` (a mesma regra `KEEP_ON_RESET`) e verificar que `tenant_group_tenants` ainda tem a casa;
  - `"rates and goals seeded"`.
- [ ] **Step 2: Rodar** `npx vitest run scripts/demo/seed-demo-finance.db.test.ts scripts/demo/clone-tenant-demo.db.test.ts`. Esperado: FAIL só nos testes novos.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar o mesmo comando.** Esperado: PASS.
- [ ] **Step 5: Commit** `feat(demo): demo group with generated financial data`.

---

### Task 10: Verificação final

- [ ] **Step 1:** `npm test`. Esperado: tudo PASS, sem regressão.
- [ ] **Step 2:** `npm run typecheck`, `npm run lint` e `npm run build`. Esperado: sem erros.
- [ ] **Step 3: Conferência manual com a skill `run`**, num banco local ou de preview:
  - um super admin cria um grupo com 2 casas e um gestor;
  - o gestor vê o grupo no seletor, abre `/grupo` e vê o placar;
  - o gestor tenta abrir `/campanhas` numa casa sem papel e o acesso é negado;
  - o admin da casa lança GGR retroativo em `/financeiro`, e o placar se atualiza.
- [ ] **Step 4: Não aplicar** migrações em produção nem rodar o seed da demo sem o ok explícito do usuário (memória `db-access-pooler`).
