# PG1 — Tabela de preços e saldo único — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar os créditos SMS por um saldo único em R$, com estas regras:
- os preços vêm do banco: SMS R$ 0,08 por segmento, voz R$ 0,09 por bloco de 30 s, e-mail com 100.000 grátis por mês e R$ 0,002 depois;
- o plano `interno` isenta a casa de tudo;
- os créditos SMS atuais são convertidos para o saldo novo;
- nenhum preço fica fixo no código.

Esta fase ainda não recebe dinheiro: o saldo é abastecido por ajuste do superadmin, como hoje.

**Architecture:**
- **Tabelas novas:**
  - de preços: `billing_plans`, `billing_price_book`, `tenant_price_overrides`;
  - de saldo: `tenant_wallets`, `wallet_ledger` (razão append-only), `tenant_monthly_usage`.
- **Mudança de saldo:** toda mudança passa por um único RPC interno, `wallet_mutation`, idempotente e com `FOR UPDATE`.
- **Envio de SMS** (individual e em massa): continua com a lógica de "gerações" de referência de cobrança, mas reserva `segmentos × preço` no razão novo via `src/lib/billing/wallet.server.ts`.
- **Custos em relatórios** (Central de Resultados, campanha, dashboard, jornadas, editor): passam a ler `billing_report_unit_price`. Para casas `interno`, essa função devolve o custo do provedor, que é o comportamento atual das 3 casas (R$ 0,059).
- **Tabelas `sms_credit_*`:** ficam só como histórico.

**Tech Stack:**
- TypeScript: TanStack Start, `createServerFn` + `requireSupabaseAuth` + zod.
- Supabase/Postgres: migrations em `supabase/migrations`.
- Testes: Vitest, com PGlite nos `*.db.test.ts`.
- Interface: React + shadcn/ui.

**Spec:** `docs/ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md` (seções 1, 2, 5 e a fase PG1; PG3-02 antecipada aqui porque o envio de SMS muda nesta fase)

## Global Constraints

- **Preços iniciais em `billing_price_book`:**

  | item | unit_price | provider_unit_cost | free_monthly_units |
  |---|---|---|---|
  | `sms` | 0.08 | 0.059 | 0 |
  | `voice_30s` | 0.09 | null | 0 |
  | `email` | 0.002 | null | 100000 |

- **Plano:** `crm_unico` custa R$ 4.000,00 (`price_cents = 400000`). `interno` custa 0, com `exempt_all = true`.
- **Isenção:** casa isenta é aquela com `tenants.plano = 'interno'`, o valor que já existe no CHECK de `tenants`.
  - Nesta fase entram nele os slugs `pixpgf`, `pixreals`, `forrandobet` e a casa com `is_demo = true`.
  - Casa isenta não é debitada, mas o consumo é registrado com `amount = 0`.
- **Conversão dos créditos SMS:** 1 crédito antigo vale o preço novo de SMS da casa (R$ 0,08), nunca o preço legado de R$ 0,12.
- **Unidades:** dinheiro do saldo em `numeric(14,4)`; preço unitário em `numeric(12,4)`.
- **Mês da franquia:** `date_trunc('month', now() at time zone 'America/Sao_Paulo')::date`.
- **Créditos não expiram:** não existe `entry_type = 'expiration'`.
- **Segmentos de SMS:**
  - GSM-7: 1 segmento até 160 unidades; acima disso, `ceil(n/153)`. Os caracteres de extensão (`^ { } \ [ ~ ] | €`) contam 2 unidades.
  - Qualquer caractere fora do GSM-7 força UCS-2: 1 segmento até 70; acima disso, `ceil(n/67)`, contando unidades UTF-16.
  - Texto vazio = 0 segmentos.
  - A contagem é sempre feita sobre o texto **final**, depois de trocar as variáveis e encurtar os links.
- **Erros dos RPCs:**
  - saldo insuficiente: exceção `insufficient_balance`;
  - chamada sem permissão: `forbidden`.
  - Mensagem para o usuário: "Saldo insuficiente".
- **Chaves de idempotência do SMS:** mantêm os formatos atuais, `sms-reserve:<ref>` e `sms-refund:<ref>`, com `reference_type = 'sms_send'`.
- **Migrations:**
  - Prefixo `20261022…`.
  - Cada uma termina com `notify pgrst, 'reload schema';`.
  - `src/integrations/supabase/types.ts` é atualizado à mão com o que for criado.
- **Produção:** qualquer escrita (aplicar migration, rodar a conversão) exige autorização explícita do usuário no momento.
- **Custo do fornecedor só para o superadmin** (regra da migration `20261021120000_hide_sms_provider_cost.sql`, já em produção). `provider_unit_cost` e qualquer margem nunca chegam a um usuário de casa:
  - `billing_effective_price` e `wallet_summary` removem `provider_unit_cost` quando `auth.uid() is not null and not is_super_admin()`. É o mesmo padrão de `sms_effective_pricing`.
  - `billing_price_book` e `wallet_ledger` têm grant de SELECT por coluna para `authenticated`, sem `provider_unit_cost`.
  - `tenant_price_overrides` só pode ser lida pelo superadmin.
  - As funções de servidor de casa removem o custo, como faz `withoutProviderCost` em `src/lib/sms-credits.functions.ts`.
  - Os números de linha citados neste plano são do `main` antigo. Localize pelo nome da função.
- **Textos:** em pt-BR.

## Review Focus

1. **Casa que já está como `plano = 'interno'` sem ser uma das 4.** Ela ficaria isenta sem ninguém perceber. A migration da Task 2 deve listar essas casas com `raise notice`, e o passo de virada (Task 9) mostra a lista para aprovação antes de aplicar.
2. **Envio entre a conversão e o deploy.** Um SMS que reservou no razão antigo e depois recebe o estorno pelo código novo: `wallet_refund` precisa responder `reservation_not_found` sem lançar exceção. Além disso, a conversão é refeita depois do deploy e lança só a diferença, como `migration`. Os testes ficam nas Tasks 3 e 4.
3. **Emoji ou acento depois de trocar variáveis.** Exemplo: `{nome}` = "João" faz a mensagem virar UCS-2 e passar de 1 para 2 segmentos. O editor mostra a estimativa com o texto de exemplo, mas a cobrança usa o texto final. O teste fica na Task 5.
4. **Estorno de um SMS cobrado com o preço antigo depois de uma troca de preço.** O estorno devolve o `amount` exato da reserva, nunca `units × preço atual`. O teste fica na Task 3.
5. **Franquia de e-mail na virada do mês.** Uma reserva feita em 31/10 23:59 (horário de Brasília) e estornada em 01/11 devolve a unidade grátis para outubro, não para novembro. O teste fica na Task 3.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/sms-segments.ts` | `countSmsSegments` puro, compartilhado entre o cliente e o servidor |
| `supabase/migrations/20261022100000_billing_price_book.sql` | Planos, tabela de preços, exceções por casa, isenção, funções de preço, marcação `interno` |
| `supabase/migrations/20261022100100_billing_wallet.sql` | Saldo, razão, uso mensal, RPCs de reserva, estorno, ajuste, resumo e integridade |
| `supabase/migrations/20261022100200_billing_legacy_sms_conversion.sql` | Função de conversão dos créditos SMS (não roda sozinha) |
| `supabase/migrations/20261022100300_billing_prices_in_reports.sql` | `sms_send_logs.billed_units`, Central de Resultados e diretório de usuários com os preços novos |
| `src/lib/billing/wallet.server.ts` | `reserveUsage` e `refundUsage` (chamam os RPCs) |
| `src/lib/billing/pricing.server.ts` | `getReportUnitPrices`, `getEffectivePrices` |
| `src/lib/billing/billing.functions.ts` | Funções de servidor: preços para o editor, portal da casa e console do superadmin |
| Testes | `src/lib/sms-segments.test.ts`, `src/lib/billing/billing-price-book.db.test.ts`, `src/lib/billing/billing-wallet.db.test.ts`, `src/lib/billing/legacy-conversion.db.test.ts`, `src/lib/billing/pricing.server.test.ts`, `src/lib/billing/no-hardcoded-prices.test.ts` |

---

### Task 1: Contador de segmentos de SMS

**Files:**
- Create: `src/lib/sms-segments.ts`
- Test: `src/lib/sms-segments.test.ts`

**Interfaces:**
- Produces: `countSmsSegments(text: string): { encoding: "GSM-7" | "UCS-2"; units: number; segments: number }`

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ["", "GSM-7", 0],
  ["a".repeat(160), "GSM-7", 1],
  ["a".repeat(161), "GSM-7", 2],
  ["a".repeat(306), "GSM-7", 2],
  ["a".repeat(307), "GSM-7", 3],
  ["{".repeat(80), "GSM-7", 1],      // extensão = 2 unidades → 160
  ["{".repeat(81), "GSM-7", 2],
  ["ç".repeat(70), "GSM-7", 1],      // ç está no GSM-7 básico
  ["ã".repeat(70), "UCS-2", 1],
  ["ã".repeat(71), "UCS-2", 2],
  ["ã".repeat(134), "UCS-2", 2],
  ["ã".repeat(135), "UCS-2", 3],
  ["Oi 😀", "UCS-2", 1],             // emoji = 2 unidades UTF-16
])("%j → %s, %i segmento(s)", (text, encoding, segments) => {
  expect(countSmsSegments(text)).toMatchObject({ encoding, segments });
});
```

- [ ] **Step 2: Run `npx vitest run src/lib/sms-segments.test.ts`.** Expected: FAIL (o módulo não existe).
- [ ] **Step 3: Implement `countSmsSegments` in `src/lib/sms-segments.ts`.** Use duas strings constantes, uma com o alfabeto básico GSM 03.38 e outra com a extensão `^{}\[~]|€`. O texto é GSM-7 se todo caractere estiver em uma das duas. Para UCS-2, `units = text.length` (unidades UTF-16).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): count SMS segments (GSM-7/UCS-2)`

---

### Task 2: Tabela de preços, planos e isenção

**Files:**
- Create: `supabase/migrations/20261022100000_billing_price_book.sql`
- Test: `src/lib/billing/billing-price-book.db.test.ts`

Siga o padrão de stubs de `src/lib/aquisicao-ltv.db.test.ts`: `auth.role()` lido de `test.role`, `has_tenant_access` lido de `test.access` e `is_super_admin` lido de `test.super`. Crie também uma tabela `tenants (id, slug, plano, is_demo)` mínima.

**Interfaces:**
- **Tabelas:**
  - `billing_plans(code text pk, name, price_cents bigint, interval text, included jsonb, exempt_all boolean, is_active boolean)`, com as linhas `crm_unico` e `interno`.
  - `billing_price_book(item text check in ('sms','voice_30s','email'), valid_from timestamptz, unit_price numeric(12,4), provider_unit_cost numeric(12,4) null, free_monthly_units integer default 0, created_by uuid)`, com PK `(item, valid_from)` e as linhas de Global Constraints com `valid_from = '2026-10-01'`.
  - `tenant_price_overrides(tenant_id, item, valid_from, unit_price, created_by)`, com PK `(tenant_id, item, valid_from)`.
- **Funções:**
  - `billing_tenant_exempt(_tenant uuid) returns boolean`: verdadeiro quando `tenants.plano` aponta para um `billing_plans` com `exempt_all`.
  - `billing_effective_price(_tenant uuid, _item text, _at timestamptz default now()) returns jsonb`. Devolve as chaves `item`, `unit_price`, `provider_unit_cost`, `free_monthly_units`, `exempt` e `source` (`'override'` ou `'default'`). A linha vigente é a de maior `valid_from <= _at`, e a exceção da casa vence o padrão.
  - `billing_report_unit_price(_tenant uuid, _item text, _at timestamptz default now()) returns numeric`:
    - casa isenta: `coalesce(provider_unit_cost, unit_price)`;
    - demais casas: `unit_price` efetivo.
  - `admin_set_price(_item, _unit_price, _provider_unit_cost, _free_monthly_units)`: insere uma vigência nova com `now()`. Só superadmin.
  - `admin_set_tenant_price(_tenant, _item, _unit_price)`: só superadmin.
  - `admin_clear_tenant_price(_tenant, _item)`: insere uma vigência nova com `unit_price` nulo, que significa "volta ao padrão". `billing_effective_price` ignora a exceção quando ela é nula. Só superadmin.
- **Acesso:**
  - As funções de leitura seguem a mesma regra de `sms_effective_pricing` (`has_tenant_access`, superadmin ou service_role); caso contrário, `forbidden`.
  - Nas tabelas, RLS com SELECT para `is_super_admin() OR tenant_id = ANY(accessible_tenant_ids())`. Para preços e planos, que não têm `tenant_id`, SELECT para `authenticated`. Escrita só por RPC.
- **Proteção:** trigger `tenants_plan_guard` (BEFORE UPDATE OF plano em `tenants`) lança `forbidden` quando `plano` muda e quem chama não é superadmin nem service_role. Segue o padrão do trigger de `is_demo` em `20261018100000_demo_tenant_flag.sql`.
- **Dados:** um bloco `do $$` atualiza para `'interno'` o `plano` das casas `pixpgf`, `pixreals`, `forrandobet` e da casa com `is_demo`. Ele falha se não encontrar exatamente as 3 casas por slug e faz `raise notice` com os slugs de qualquer outra casa que já estava como `interno`.

- [ ] **Step 1: Write the failing tests.**
  - `billing_effective_price(normal, 'sms')` devolve `unit_price = 0.08`, `provider_unit_cost = 0.059`, `exempt = false` e `source = 'default'`.
  - Com uma exceção de 0.07 a partir de `now()`, devolve 0.07 com `source = 'override'`. Com `_at` anterior à exceção, devolve 0.08.
  - `admin_set_price('sms', 0.09, …)` não muda o preço de `_at = now() - 1 minute`.
  - `billing_effective_price(normal, 'email').free_monthly_units = 100000`.
  - Na casa `interno`: `billing_tenant_exempt = true`, `billing_report_unit_price(interno, 'sms') = 0.059` e `billing_report_unit_price(interno, 'email') = 0.002` (o custo é nulo, então cai no preço).
  - `test.access = 'off'`, sem superadmin e sem service_role: `billing_effective_price` lança `forbidden`.
  - `admin_set_price` sem superadmin lança `forbidden`.
  - Item `'whatsapp'` viola o CHECK.
  - `update tenants set plano = 'interno'` com `test.role = 'authenticated'` e sem superadmin lança `forbidden`. Com `test.super = 'on'`, passa.
- [ ] **Step 2: Run `npx vitest run src/lib/billing/billing-price-book.db.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Write the migration.** No teste, inclua no seed os slugs `pixpgf`, `pixreals` e `forrandobet` para o bloco de dados passar.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Add the new tables and functions to `src/integrations/supabase/types.ts`, then run `npm run typecheck`.** Expected: sem erros.
- [ ] **Step 6: Commit** — `feat(billing): price book, plans and interno exemption`

---

### Task 3: Saldo único e razão

**Files:**
- Create: `supabase/migrations/20261022100100_billing_wallet.sql`
- Test: `src/lib/billing/billing-wallet.db.test.ts` (aplica as migrations das Tasks 2 e 3)

**Interfaces:**
- Consumes: `billing_effective_price` e `billing_tenant_exempt` (Task 2).
- **Tabelas:**
  - `tenant_wallets(tenant_id pk, balance numeric(14,4) check >= 0, lifetime_purchased, lifetime_used, updated_at)`.
  - `wallet_ledger`:
    - `id uuid`, `tenant_id`;
    - `entry_type` check in (`'purchase','manual_adjustment','usage_reservation','usage_refund','migration'`);
    - `item text null`, `units int`, `free_units int`, `usage_month date null`;
    - `unit_price numeric(12,4)`, `provider_unit_cost numeric(12,4)`;
    - `amount numeric(14,4)` (com sinal) e `balance_after numeric(14,4)`;
    - `reference_type`, `reference_id`, `idempotency_key`, `reason`, `metadata jsonb`, `created_by`, `created_at`.
    - Restrições: UNIQUE `(tenant_id, idempotency_key)` e índice em `(tenant_id, reference_id)`.
  - `tenant_monthly_usage(tenant_id, month date, item, units bigint, free_units_used bigint, billed_amount numeric(14,4))`, com PK `(tenant_id, month, item)`.
- **RPCs** (SECURITY DEFINER; o RPC interno não recebe grant de `authenticated`):
  - `wallet_mutation(_tenant, _amount numeric, _entry_type, _item, _units, _free_units, _usage_month, _unit_price, _provider_unit_cost, _reference_type, _reference_id, _idempotency_key, _reason, _metadata, _created_by) returns jsonb`. É interno.
    - Com chave repetida, devolve `{ok:true, idempotent:true, ledger_id, amount, balance}`.
    - Senão, trava o saldo com `FOR UPDATE`, lança `insufficient_balance` se o saldo ficaria abaixo de 0, grava a linha e devolve `{ok:true, idempotent:false, ledger_id, amount, balance}`.
  - `wallet_reserve(_tenant uuid, _item text, _units integer, _reference_type text, _reference_id text, _idempotency_key text) returns jsonb`. Só service_role ou superadmin.
    - `free = least(_units, free_monthly_units - free_units_used do mês)`.
    - `amount = -(_units - free) × unit_price`, ou 0 se a casa for isenta.
    - Atualiza `tenant_monthly_usage` só quando a mutação **não** é idempotente.
    - A resposta inclui `exempt`.
  - `wallet_refund(_tenant uuid, _reference_id text, _idempotency_key text, _reason text) returns jsonb`. Só service_role ou superadmin.
    - Procura a última `usage_reservation` com esse `reference_id`. Se não achar, devolve `{ok:false, reason:'reservation_not_found'}` sem lançar exceção.
    - Se achar, lança `amount = -reserva.amount`, os mesmos `units`, `free_units` e `usage_month`, e desconta esses valores do `tenant_monthly_usage` **do `usage_month` da reserva**.
  - `admin_adjust_wallet(_tenant uuid, _amount numeric, _reason text, _idempotency_key text default gen_random_uuid()::text) returns jsonb`. Só superadmin, com `entry_type = 'manual_adjustment'` e motivo obrigatório (`invalid_reason` se vier vazio).
  - `wallet_summary(_tenant uuid default current_tenant_id()) returns jsonb`. Devolve `balance`, `lifetime_purchased`, `lifetime_used`, `exempt`, `month_usage` (lista com `item`, `units`, `free_units_used` e `billed_amount`) e `prices` (um `billing_effective_price` por item). A regra de acesso é a mesma de `sms_credit_summary`.
  - `billing_wallet_integrity() returns table(tenant_id uuid, balance numeric, ledger_sum numeric)`. Lista só as casas em que `balance <> sum(amount)`. Só service_role ou superadmin.

- [ ] **Step 1: Write the failing tests.**
  - **Reserva simples:** saldo de R$ 1,00 (via `admin_adjust_wallet`); `wallet_reserve(t,'sms',2,…,'sms-reserve:a')` resulta em `amount = -0.16` e `balance = 0.84`. Repetir a mesma chave devolve `idempotent: true` e o saldo continua 0.84.
  - **Saldo insuficiente:** com saldo 0.84, 11 segmentos (0,88) lançam `insufficient_balance` e o saldo continua 0.84.
  - **Reservas em sequência:** 20 reservas de 1 SMS sobre saldo 1.00 resultam em 12 aceitas (0,96), 8 com `insufficient_balance` e saldo final 0.04, nunca negativo.
  - **Estorno:** `wallet_refund(t, 'a', 'sms-refund:a', 'x')` volta para 1.00. Repetido, é idempotente.
  - **Estorno sem reserva:** `wallet_refund` de uma referência inexistente devolve `{ok:false, reason:'reservation_not_found'}`.
  - **Troca de preço:** reservar 1 SMS (0.08), mudar o preço para 0.10 e estornar devolve exatamente 0.08.
  - **Franquia de e-mail:** com `free_units_used = 99_999` no mês, `wallet_reserve(t,'email',2)` gera `free_units = 1` e `amount = -0.002`. A próxima reserva de 1 custa 0.002.
  - **Virada do mês:** fixe o mês da reserva por meio de um parâmetro de teste `test.now` lido por uma função `billing_now()` (que em produção é `now()`). Reserva em `'2026-10-31 23:59-03'`, estorno com `test.now = '2026-11-01 00:01-03'`: o estorno desconta de outubro, e novembro continua sem uso.
  - **Casa interno:** `wallet_reserve` de 5 SMS com saldo 0 devolve `ok`, `exempt: true` e `amount = 0`. A linha no razão tem `units = 5` e `provider_unit_cost = 0.059`.
  - **Integridade:** `billing_wallet_integrity()` vem vazia. Depois de um `update tenant_wallets set balance = balance + 1` direto, lista a casa.
  - **Permissões:** `wallet_reserve` com `test.role = 'authenticated'` e sem superadmin lança `forbidden`. `admin_adjust_wallet` com motivo vazio lança `invalid_reason`.
- [ ] **Step 2: Run `npx vitest run src/lib/billing/billing-wallet.db.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Write the migration.** Inclua `billing_now()` (`stable`, que lê `test.now` se existir e senão usa `now()`) e use-a para calcular o mês. Grants: `select` para `authenticated` nas tabelas (com RLS por casa), e `execute` para `authenticated` só em `wallet_summary` e `admin_adjust_wallet`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Update `types.ts` and run `npm run typecheck`.** Expected: sem erros.
- [ ] **Step 6: Commit** — `feat(billing): single BRL wallet with idempotent ledger and email free tier`

---

### Task 4: Conversão dos créditos SMS

**Files:**
- Create: `supabase/migrations/20261022100200_billing_legacy_sms_conversion.sql`
- Test: `src/lib/billing/legacy-conversion.db.test.ts` (aplica a migration de criação dos créditos SMS, `20260922193000_create_sms_credit_billing.sql`, e as migrations das Tasks 2, 3 e 4)

**Interfaces:**
- Consumes: `wallet_mutation` e `billing_effective_price` (Tasks 2 e 3) e `tenant_sms_credit_balances` (legado).
- Produces: `billing_convert_legacy_sms_credits(_apply boolean default false) returns table(tenant_id uuid, slug text, legacy_balance integer, already_converted integer, delta_credits integer, unit_price numeric, amount numeric, skipped_reason text)`. Só superadmin ou service_role.
  - **O que lê:** para cada casa com linha em `tenant_sms_credit_balances`, pega o saldo legado atual e `already_converted` (soma de `(metadata->>'legacy_credits')::int` das linhas `migration` dela).
  - **Preço usado:** o preço **novo** de SMS da casa, `billing_effective_price(tenant,'sms').unit_price` (R$ 0,08 no padrão). Assim, 1 crédito antigo = 1 SMS no saldo novo (decisão do usuário, 21/10). O preço legado (R$ 0,12) **não** é usado.
  - **Casas puladas:** a casa isenta recebe `skipped_reason = 'interno'` e não é convertida.
  - **Com `_apply`:** para cada `delta_credits <> 0`, lança `entry_type = 'migration'` com `amount = delta × preço`, metadata `{legacy_credits: delta}` e chave `legacy-sms:<tenant>:<already_converted>:<legacy_balance>`.
  - **Delta negativo** (consumo entre duas rodadas): se o saldo não comportar, lança só até zerar e preenche `skipped_reason = 'clamped'`.

- [ ] **Step 1: Write the failing tests.**
  - **Simulação:** a casa A tem 1000 créditos (o preço legado dela é 0.12, que deve ser ignorado); a casa interno tem 99.999.999. `_apply = false` mostra A com `unit_price = 0.08` e `amount = 80.0000` e interno com `skipped_reason = 'interno'`, e o `wallet_ledger` continua vazio.
  - **Aplicação:** com `_apply = true`, A fica com saldo 80. Rodar `_apply = true` de novo dá `delta 0` para A e nenhuma linha nova.
  - **Diferença posterior:** o legado de A cai para 990 (envio pelo código antigo). A próxima rodada lança `-0.80`, e o saldo vai para 79.20.
  - **Permissão:** sem superadmin nem service_role, lança `forbidden`.
- [ ] **Step 2: Run the test.** Expected: FAIL.
- [ ] **Step 3: Write the migration.** O cabeçalho deve dizer que a função **não** roda sozinha e que a Task 9 define quando executá-la.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): re-runnable legacy SMS credit conversion`

---

### Task 5: Envio de SMS cobra do saldo novo, por segmento

**Files:**
- Create: `src/lib/billing/wallet.server.ts`
- Modify:
  - `src/lib/sms.functions.ts:609-690` (`reserveSmsCredit`, `refundSmsCredit`, `smsCreditWasRefunded`, `reserveSmsCreditForDelivery`)
  - `src/lib/sms.functions.ts:~836` (chamada no envio individual)
  - `src/lib/sms-bulk.server.ts:~758` (chamada no envio em massa)
  - `src/lib/sms-bulk.test-support.ts:186-215` (`installCreditLedger`)
- Test: `src/lib/sms-bulk.server.test.ts` e `src/lib/demo-send-guard.channels.test.ts` (já existem, e precisam continuar verdes), mais os casos novos em `src/lib/sms-bulk.server.test.ts`.

**Interfaces:**
- Consumes: `countSmsSegments` (Task 1), `wallet_reserve` e `wallet_refund` (Task 3).
- **`wallet.server.ts`:**
  - `reserveUsage(args: { tenantId: string; item: "sms" | "voice_30s" | "email"; units: number; referenceType: string; referenceId: string; idempotencyKey: string }): Promise<{ ok: true; idempotent: boolean; exempt: boolean; amount: number } | { ok: false; error: "Saldo insuficiente" }>`. Converte `insufficient_balance` nesse erro; qualquer outro erro é lançado.
  - `refundUsage(args: { tenantId: string; referenceId: string; idempotencyKey: string; reason: string }): Promise<void>`. Registra no log `reservation_not_found` e falhas, sem lançar.
- **Mudanças no envio de SMS:**
  - `reserveSmsCreditForDelivery(tenantId, deliveryKey, segments: number)` ganha o parâmetro `segments`. A lógica de gerações fica igual.
  - `smsCreditWasRefunded` passa a consultar `wallet_ledger` com a chave `sms-refund:<ref>`.
  - Quem chama passa `countSmsSegments(conteúdoFinal).segments`, onde o conteúdo final é `preparedContent` no envio individual e `content` no envio em massa.
- **Simulador de testes:** `installCreditLedger(db, { balance?: () => number })` passa a simular `wallet_reserve` e `wallet_refund` sobre `db.rows("wallet_ledger")`, com `units` vindo do argumento e preço 0.08. O `charged()` passa a devolver unidades.

- [ ] **Step 1: Write the failing tests** em `sms-bulk.server.test.ts`:
  - Um item com conteúdo de 161 caracteres GSM reserva `units = 2`, e `charged()` dá 2.
  - Um item com `{nome}` trocado por "João" e texto de 70 caracteres com acento reserva `units = 1`. Com 71 caracteres, reserva 2.
  - `balance: () => 1` e um item de 2 segmentos: o item falha com o erro `"Saldo insuficiente"` e não é enviado.
  - Recusa do provedor: há estorno com a chave `sms-refund:<ref>`, e o reenvio do mesmo `deliveryKey` usa a geração 1.
- [ ] **Step 2: Run `npx vitest run src/lib/sms-bulk.server.test.ts`.** Expected: os casos novos falham.
- [ ] **Step 3: Implement `wallet.server.ts`, update the simulator and switch both call sites.** Grave `billed_units` no `logSend` e no `logRow` (a coluna é criada na Task 6; até lá, `looseDb`).
- [ ] **Step 4: Run `npx vitest run src/lib/sms-bulk.server.test.ts src/lib/demo-send-guard.channels.test.ts`.** Expected: PASS.
- [ ] **Step 5: Run `npm test`.** Expected: tudo verde. Atualize as expectativas do texto antigo, "Saldo de créditos SMS insuficiente", para "Saldo insuficiente".
- [ ] **Step 6: Commit** — `feat(billing): SMS sends reserve segments x price from the wallet`

---

### Task 6: Preços novos nos números do banco

**Files:**
- Create: `supabase/migrations/20261022100300_billing_prices_in_reports.sql`
- Test: `src/lib/billing/no-hardcoded-prices.test.ts` (só a parte de SQL; a de TS fica na Task 7)

**Interfaces:**
- Consumes: `billing_report_unit_price` (Task 2) e `wallet_ledger` (Task 3).
- **Coluna nova:** `sms_send_logs.billed_units smallint null` (as linhas antigas valem 1).
- **`refresh_crm_results_day`:** copie a definição **mais recente**, que está em `20261019120000_crm_click_conversion_incremental.sql`, e mude só o custo:
  - `v_price := billing_report_unit_price(_tenant, 'sms', v_from)`;
  - `cost = sum(coalesce(billed_units,1)) filter (where is_sent) × v_price`, com `billed_units` vindo do CTE `sends`.
- **`check_crm_results_day`:** copie a definição mais recente, que está em `20261016200000_sms_price_0059.sql`. Mude:
  - o mesmo `v_price`;
  - o custo bruto passa a ser `(sum(units) das linhas 'usage_reservation' − sum(units) das linhas 'usage_refund')` de `wallet_ledger` com `item = 'sms'` no dia, × `v_price`;
  - somado às linhas legadas de `sms_credit_ledger` do mesmo dia, para os dias antes da virada.
- **`admin_list_users_with_usage`:** copie a definição mais recente, que está em `20261003133000_fix_admin_user_directory_call_duration.sql`, e troque `platform_pricing` por:
  - `billing_price_book` vigente para SMS e e-mail;
  - voz = `sum(ceil(duração em segundos / 30)) × preço de voice_30s`.

- [ ] **Step 1: Write the failing test.** Lê o arquivo SQL da migration e verifica:
  - não contém os literais `0.12` nem `platform_pricing`;
  - contém `billing_report_unit_price(_tenant, 'sms'` e `coalesce(s.billed_units, 1)`.

  Junto, um teste PGlite **apenas** de `check_crm_results_day`, montado com stubs mínimos de `crm_results_daily`, `sms_send_logs`, `conversion_attributions`, `crm_results_health` e `sms_credit_ledger`:
  - 3 reservas de 2 segmentos no `wallet_ledger` mais `crm_results_daily.cost = 0.48` resultam em `cost ok = true`;
  - com `cost = 0.24`, o resultado é `ok = false`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Write the migration** (as três funções inteiras mais a coluna, com os mesmos grants das originais).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Add `billed_units` to `sms_send_logs` in `types.ts`, remove the `looseDb` added in Task 5 and run `npm run typecheck`.**
- [ ] **Step 6: Commit** — `feat(billing): CRM results and user directory use the price book and segments`

---

### Task 7: Nenhum preço fixo no código

**Files:**
- Create: `src/lib/billing/pricing.server.ts`, `src/lib/billing/billing.functions.ts`
- Modify:
  - `src/lib/journeys.functions.ts:482-485` (custo da jornada) e `:986-1002` (estimativa de publicação)
  - `src/lib/dashboard.functions.ts:76` (`FALLBACK_SMS_UNIT_PRICE`)
  - `src/lib/conversion-report.functions.ts:1082-1096` e `:1201`
  - `src/lib/sms.functions.ts:1735-1738`
  - `src/routes/sms.tsx:290-294` e `:2068-2071` (`smsCount` e `custoUnit = 0.18`), além dos usos em `:375` e `:1003`
- Test: `src/lib/billing/pricing.server.test.ts`, `src/lib/billing/no-hardcoded-prices.test.ts` (parte de TS)

**Interfaces:**
- Consumes: `billing_report_unit_price`, `billing_effective_price` (Task 2) e `countSmsSegments` (Task 1).
- **`pricing.server.ts`:**
  - `getReportUnitPrices(tenantId: string): Promise<{ sms: number; voice_30s: number; email: number }>`: três chamadas a `billing_report_unit_price` via `supabaseAdmin`. Lança erro se alguma vier nula.
  - `getEffectivePrices(tenantId: string): Promise<Record<"sms" | "voice_30s" | "email", { unitPrice: number; freeMonthlyUnits: number; exempt: boolean }>>`.
- **`billing.functions.ts`:** `getBillingPrices`, um `createServerFn GET` com `requireSupabaseAuth`. Resolve a casa ativa como as outras funções de casa fazem e devolve `getEffectivePrices`.
- **Regras de cálculo:**
  - **Custo da jornada:** `sms × prices.sms + email × prices.email + voice × prices.voice_30s`. Até a PG3, a voz é estimada como 1 bloco por chamada; deixe um comentário dizendo isso.
  - **Relatório de campanha e ROI do dashboard SMS:** usam a soma de `coalesce(billed_units,1)` das mensagens aceitas no lugar da contagem de linhas.
  - **Editor de SMS:** troca `smsCount` por `countSmsSegments(textoDeExemplo)` e `custoUnit` pelo preço vindo de `getBillingPrices`. Mostra a linha `"{N} segmento(s) × R$ 0,08 = R$ X por jogador"`.

- [ ] **Step 1: Write the failing tests.**
  - `pricing.server.test.ts`, com o RPC simulado: `getReportUnitPrices` devolve `{sms:0.08, voice_30s:0.09, email:0.002}` e lança erro se um RPC devolver `null`.
  - `no-hardcoded-prices.test.ts`: lê os arquivos modificados e verifica que não aparecem `0.12`, `0.18`, `0.35`, `* 0.01` nem `FALLBACK_SMS_UNIT_PRICE`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the helpers and switch every call site.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** — `refactor(billing): every cost reads the price book`

---

### Task 8: Telas atuais mostram o saldo em R$

**Files:**
- Modify:
  - `src/lib/sms-credits.functions.ts`: `getSmsCreditPortal` (L152), `createSmsCreditCheckout` (L207), `adminSmsCreditConsole` (L276), `adminAdjustSmsCredits` (L371), `adminMarkSmsCreditOrderPaid` (L401), `adminSetSmsCreditSettings`, `adminSetTenantSmsPricing`, `adminClearTenantSmsPricing`
  - `src/lib/admin.functions.ts:195-227` (`getPricing` e `setPricing`)
  - `src/lib/tenants.functions.ts:255-300` (resumo da casa) e `:527-585` (`updateTenantSettings`)
  - `src/routes/creditos-sms.tsx`, `src/routes/admin.tsx` (abas "Preços" ~L1363 e "Créditos SMS" ~L796, diálogo de preço por casa ~L1175-1246), `src/routes/tenants.tsx` (aba "Saldo SMS" ~L766-900, margem ~L431)
- Test: os `*.test.ts` existentes dessas funções, se houver, e um teste novo de permissão em `src/lib/billing/billing.functions.test.ts`

**Interfaces:**
- Consumes: `wallet_summary`, `admin_adjust_wallet`, `admin_set_price`, `admin_set_tenant_price` e `admin_clear_tenant_price` (Tasks 2 e 3), além de `wallet_ledger` via RLS.
- **Funções de servidor:**
  - `getSmsCreditPortal` devolve `{ summary: wallet_summary, ledger: últimas 50 linhas de wallet_ledger }`.
  - `createSmsCreditCheckout` e `adminMarkSmsCreditOrderPaid` passam a lançar `"Compra por Pix disponível em breve. Fale com o suporte para adicionar saldo."`. A compra real chega na PG2.
  - `adminAdjustSmsCredits` recebe `amount` em R$ (zod: número entre -100000 e 100000, diferente de 0, com motivo obrigatório) e chama `admin_adjust_wallet`, mantendo `auditTenantChange`.
  - `getPricing` e `setPricing` leem e gravam `billing_price_book` (item, preço de venda, custo, franquia).
  - O diálogo de preço por casa usa `admin_set_tenant_price` e `admin_clear_tenant_price`, por item.
  - `updateTenantSettings` ganha o campo `planReason`. Quando `plano` entra ou sai de `'interno'`, ele passa a ser obrigatório, com no mínimo 5 caracteres; sem ele, a função lança `"Informe o motivo da troca de plano"`. O motivo vai no `metadata.plan_reason` da auditoria. A tela de edição da casa mostra o campo nesse caso.
- **Telas:**
  - `/creditos-sms` passa a se chamar "Saldo e consumo". Mostra:
    - o saldo em R$;
    - o selo "Isenta" quando `exempt`;
    - o consumo do mês por canal, com a barra da franquia de e-mail no formato "42.310 de 100.000 grátis";
    - a tabela de preços vigentes;
    - o extrato (data, tipo, canal, unidades, valor, saldo depois).

    O botão "Gerar pedido manual" sai.
  - A aba "Saldo SMS" de `/tenants` mostra o mesmo resumo, e a margem passa a usar `prices.sms.unitPrice − provider_unit_cost`.
  - A aba "Créditos SMS" do `/admin` vira "Saldo": ajuste em R$ e lista de casas com saldo (de `wallet_summary`). Os pedidos antigos ficam só para leitura.

- [ ] **Step 1: Write the failing test.**
  - `adminAdjustSmsCredits` sem superadmin é recusado.
  - Com `amount: 0`, falha na validação.
  - `createSmsCreditCheckout` lança a mensagem acima.
  - `updateTenantSettings` trocando de `starter` para `interno` sem `planReason` é recusado. Com motivo, grava `metadata.plan_reason` na auditoria.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement the server changes, then the three screens.**
- [ ] **Step 4: Run `npm test`, `npm run typecheck` and `npm run lint`.** Expected: PASS.
- [ ] **Step 5: Run `/run` and look at `/creditos-sms`, `/tenants` (aba Saldo) and `/admin` (abas Preços e Saldo) com uma casa normal e a casa demo.** Expected: saldo em R$, preços 0,08/0,09/0,002, demo com o selo "Isenta". Anexe um print de cada tela ao PR.
- [ ] **Step 6: Commit** — `feat(billing): balance, usage and prices in BRL on existing screens`

---

### Task 9: Virada em produção (exige autorização do usuário a cada escrita)

**Files:**
- Create: `docs/operacoes/RUNBOOK_VIRADA_SALDO_UNICO.md` (passos abaixo, com os resultados preenchidos na execução)

- [ ] **Step 1: Read-only.** Liste as casas com `plano = 'interno'` e as casas com saldo legado maior que 0, com o resultado da simulação `billing_convert_legacy_sms_credits(false)` calculado à mão por SQL somente leitura. **Mostre ao usuário e peça aprovação.**
- [ ] **Step 2: Apply, com autorização, as migrations `20261022100000` a `20261022100300` (pooler, ver a memória db-access-pooler).** Expected: os notices da Task 2 não listam outras casas `interno`, ou a lista foi aprovada no Step 1.
- [ ] **Step 3: Run `select * from billing_convert_legacy_sms_credits(true)` (com autorização).** Expected: o saldo de cada casa = créditos × R$ 0,08 (preço novo de SMS da casa).
- [ ] **Step 4: Deploy the code** (`docker compose up -d --force-recreate`, conforme `docs/docker-deployment.md`).
- [ ] **Step 5: Rerun `billing_convert_legacy_sms_credits(true)`.** Expected: só lançamentos de diferença, os envios que o código antigo fez entre os Steps 3 e 4.
- [ ] **Step 6: Refresh the last 30 days of the Central de Resultados** with the existing refresh routine. Expected: `crm_results_health` sem `cost` com `ok = false` nos dias depois da virada.
- [ ] **Step 7: Run `select * from billing_wallet_integrity()`.** Expected: nenhuma linha. Faça um envio de teste de 1 SMS em uma casa normal (saldo cai R$ 0,08) e de 1 SMS em uma casa `interno` (saldo não muda, razão com `amount 0`).
- [ ] **Step 8: Commit the runbook com os resultados** — `docs(billing): single-wallet cutover runbook and evidence`

---

## Fora deste plano

Itens do escopo que ficam para as próximas fases:

| Item | Fase |
|---|---|
| `wallet_reserve_batch` | PG3, se o volume de e-mail exigir |
| `wallet_settle` (acerto de voz) | PG3 |
| Cobrança de voz e de e-mail nos envios | PG3-03 e PG3-04 |
| Compra por Pix | PG2 |
| Fatura | PG4 |
| Página final "Plano e créditos" | PG5 |

Nesta fase, voz e e-mail ainda não debitam do saldo. As funções já suportam esses itens.
