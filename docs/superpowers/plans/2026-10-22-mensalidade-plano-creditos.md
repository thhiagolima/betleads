# Mensalidade, "Plano e créditos" e console de cobrança — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A casa pagante recebe a fatura mensal com Pix, vê faixas amarela e vermelha antes do vencimento e é bloqueada depois da carência. Ela paga na página "Plano e créditos" e volta a operar na hora. Os e-mails de cobrança saem sozinhos, e o superadmin tem 14 ações de cobrança à mão.

**Architecture:**
- **No banco (fonte única):**
  - O estado de cobrança vive no Postgres: `tenant_billing` (um por casa) e `billing_invoices`.
  - Funções SQL fazem as transições de forma atômica: estado, geração de fatura, baixa.
  - Um job a cada hora (pg_cron chamando uma rota) gera faturas, recalcula estados e manda e-mails.
- **Pagamento:** reaproveita a PG2 inteira. Isso inclui `payment_charges` com `kind 'invoice'`, o cliente da Upper, o webhook, a conciliação e o RPC `billing_credit_paid_charge`, que ganha o ramo de fatura.
- **Bloqueio:** é aplicado em três lugares:
  - no portão da interface;
  - nos resolvedores de casa do servidor;
  - nas travas de envio.

  O superadmin nunca é bloqueado.

**Tech Stack:** TanStack Start (`createServerFn` + `requireSupabaseAuth` + zod, rotas com `server.handlers`), Supabase/Postgres (pg_cron, pg_net, Vault), Vitest + PGlite, React + shadcn/ui (tema escuro), e-mail pela Infobip (`sendInfobipEmail`).

**Spec:** `docs/superpowers/specs/2026-10-22-pagamento-plano-creditos-design.md` (inclui a seção 7.1). Contexto: `docs/ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md`.

## Global Constraints

**Datas e valores**
- **Dia de referência:** sempre o dia de Brasília, `(now() at time zone 'America/Sao_Paulo')::date`.
- **Soma de meses:** 1 mês somado a uma data. Se o dia não existir no mês de destino, usa o último dia do mês. Exemplo: 31/01 + 1 mês = 28/02 (ou 29/02 em ano bissexto).
- **Valor da mensalidade:**
  - Preço do plano: `billing_plans.price_cents` do plano `crm_unico` (400000). Se `tenant_billing.custom_price_cents` não for nulo, ele substitui.
  - Desconto contínuo: `percent` (0 a 100) ou `fixed` (centavos), ativo quando o vencimento do ciclo cai entre o início e o fim (fim opcional).
  - O desconto pontual soma ao contínuo.
  - Centavos inteiros, com arredondamento meio para cima.
- **Mínimo do Pix:**
  - Fatura com valor final `0` recebe baixa automática como `paid_via = 'full_discount'`.
  - Valor final entre `1` e `9999` centavos é recusado com `"O valor da fatura não pode ficar abaixo de R$ 100,00 (mínimo do Pix)"`. Isso vale para o desconto pontual, o contínuo e o preço próprio. O preço próprio também precisa ser `>= 10000`.

**Calendário da fatura**
- **Emissão:** a fatura do ciclo com vencimento V é gerada quando hoje é `>= V - 5`.
- **Uma fatura aberta por casa:** índice único parcial.
- **Bloqueio sem fatura nova:** casa bloqueada por falta de pagamento não ganha fatura nova.
- **Faixa pela data efetiva:** a faixa usa `due_date`, que é o vencimento efetivo e pode ter sido estendido. O ciclo usa `cycle_due_date`.

**Estados (`tenant_billing.access_state`)**
- **Valores:** `exempt`, `frozen`, `locked_manual`, `awaiting_first_payment`, `ok`, `due_soon`, `overdue`, `locked_unpaid`.
- **Precedência:** `exempt` (plano isento) > `frozen` > `locked_manual` > `awaiting_first_payment` (fatura aberta e nenhuma fatura paga antes) > conforme a fatura aberta F:
  - `due_soon`: hoje está em `[F.due_date − 5, F.due_date − 1]`;
  - `overdue`: hoje está em `[F.due_date, F.due_date + 3]`;
  - `locked_unpaid`: hoje é `> F.due_date + 3`;
  - `ok`: qualquer outro caso, inclusive sem fatura aberta.

**Bloqueio**
- **Bloqueio efetivo:**
  - `frozen` e `locked_manual` sempre bloqueiam.
  - `locked_unpaid` e `awaiting_first_payment` só bloqueiam com `BILLING_ENFORCEMENT_ENABLED === "true"`.
  - O superadmin nunca é bloqueado.
- **Sem bloqueio (enforcement desligado):**
  - A faixa vermelha diz `"Sua mensalidade venceu em DD/MM. Pague para regularizar."`.
  - Não há cartão de bloqueio e o e-mail de bloqueio não sai.

**Pagamento e baixa**
- **Pagar a fatura:**
  - `external_id = 'bl-inv-' || invoice.id || '-' || n`, com n começando em 1.
  - Reaproveita uma cobrança `ACTIVE` com o mesmo valor cuja validade passe de 5 minutos.
  - Validade do Pix (`expiresIn`, em segundos): até o fim do dia `due_date + 3`, com mínimo de 3600 e máximo de 604800.
- **Baixa e ciclo:**
  - Se a casa estava em `locked_unpaid` ou `awaiting_first_payment`, o novo `next_due_date` é o dia do pagamento + 1 mês.
  - Nos outros casos, é `cycle_due_date + 1 mês`.
  - Depois, recalcula o estado.

**Quem paga**
- Mensalidade e créditos: usuários com papel `admin`, `owner` ou `gestor` na casa, e o superadmin.
- `member` e `user` veem os avisos sem botão, com o texto `"Peça ao administrador da casa para pagar a mensalidade."`.

**E-mails**
- **Remetente:** `PLATFORM_EMAIL_FROM` (padrão `no-reply@betleads.io`), nome `BetLeads`.
- **Destinatários:** os e-mails de todos os usuários `admin`, `owner` e `gestor` da casa.
- **Quatro tipos**, cada um uma vez por fatura (`billing_email_log`):
  - `issued`: fatura gerada;
  - `due_today`: no dia do vencimento;
  - `locked`: só com enforcement ligado;
  - `paid`.
- **Janela de envio:** só entre 08:00 e 20:00 de Brasília.

**Interruptores (env)**
- `BILLING_INVOICES_ENABLED` (`"true"` liga a geração de faturas e os e-mails).
- `BILLING_ENFORCEMENT_ENABLED` (`"true"` liga o bloqueio por falta de pagamento).
- `PLATFORM_EMAIL_FROM`.
- Documentar em `.env.example` e `docs/docker-deployment.md`.

**Textos (pt-BR, exatos)**
- **Faixa amarela:** `"Sua mensalidade de R$ X vence em DD/MM (daqui a N dias). Pague por Pix para manter tudo funcionando."`.
- **Faixa vermelha (enforcement ligado):** `"Sua mensalidade venceu em DD/MM. Se não for paga até DD/MM, o acesso ao CRM será bloqueado."`.
- **Bloqueio por falta de pagamento:** título `"Acesso suspenso por falta de pagamento"`, texto `"A mensalidade de R$ X venceu em DD/MM. Pague por Pix e o acesso volta na hora."`, botão `"Ir para o pagamento"`.
- **Bloqueio manual:** `"Acesso suspenso. Fale com o suporte."`.
- **Plano congelado:** `"Plano pausado. Fale com o suporte."`.
- **Aguardando o primeiro pagamento:** título `"Ative sua conta"`, texto `"Pague a primeira mensalidade de R$ X por Pix para começar a usar o CRM."`.
- **Botão das faixas:** `"Pagar agora"`.
- **Compra de créditos com a casa bloqueada:** `"Disponível depois de pagar a mensalidade"`.

**Banco e segurança**
- **Migrations:**
  - Prefixo `20261023…`.
  - Terminam com `notify pgrst, 'reload schema';`.
  - SECURITY DEFINER com `set search_path = public`, `revoke execute ... from public, anon`, grants explícitos.
  - RLS de leitura: `is_super_admin() OR tenant_id = ANY(accessible_tenant_ids())`.
  - Escrita só por service_role ou RPC.
  - Atualizar `types.ts` à mão.
- **Auditoria:** toda ação do superadmin grava em `tenant_audit_logs` com `action` `billing.<ação>`, motivo obrigatório (5 caracteres ou mais) e autor.
- **Isolamento:** o custo do fornecedor e os dados internos da Upper continuam fora do alcance das casas (regras da PG1 e da PG2).
- **Produção:** escrever em produção, chamar a Upper de verdade ou enviar e-mail de verdade só com autorização explícita do usuário.

## Review Focus

1. **Pix pago depois do bloqueio.** A casa sai do bloqueio na hora e o ciclo recomeça no dia do pagamento, não no vencimento antigo. Testes na Task 2 (settle) e na Task 3.
2. **Fatura com vencimento estendido.** A faixa e o bloqueio seguem `due_date`. O ciclo seguinte segue `cycle_due_date` e não anda junto. Teste na Task 2.
3. **Superadmin olhando uma casa bloqueada.** Navega normalmente e vê a faixa sem o cartão de bloqueio. Testes na Task 4 e na Task 6.
4. **Casa isenta.** Nunca tem fatura, faixa, e-mail ou bloqueio, inclusive depois de voltar a ser isenta com fatura aberta, que é cancelada. Testes na Task 2 e na Task 5.
5. **Mesmo e-mail duas vezes.** Duas execuções do job na mesma hora nunca mandam o mesmo e-mail duas vezes. Teste na Task 5.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20261023100000_billing_invoices.sql` | Tabelas, gatilho de plano, estado, geração, baixa, ramo `invoice` do RPC da PG2, ações do superadmin em SQL |
| `supabase/migrations/20261023100100_billing_cycle_cron.sql` | Job `betleads-billing-cycle` a cada hora |
| `src/lib/billing/billing-view.ts` | Puro: modelo da faixa e do cartão de bloqueio (estado, papel, enforcement → texto e botão) |
| `src/lib/billing/billing-state.server.ts` | `getTenantBillingSnapshot`, `isBillingLockedFor`, `requireTenantPayer` |
| `src/lib/billing/invoices.server.ts` | Ciclo da hora (gerar, recalcular, e-mails) e Pix da fatura |
| `src/lib/billing/billing-emails.server.ts` | Os 4 e-mails e o reenvio |
| `src/lib/billing/billing.functions.ts` | Funções da casa: snapshot, pagar fatura, comprovante |
| `src/lib/billing/billing-admin.functions.ts` | As 14 ações e as leituras do superadmin |
| `src/routes/api/public/hooks/billing-cycle.ts` | Rota do job |
| `src/components/billing/billing-banner.tsx`, `src/components/billing/billing-lock.tsx`, `src/components/billing/pix-payment-dialog.tsx` | Faixa, cartão de bloqueio e modal de Pix genérico |
| `src/routes/plano-e-creditos.tsx` | Página "Plano e créditos" (a rota `/creditos-sms` redireciona para ela) |
| `src/routes/admin.tsx` (aba "Faturamento") e `src/components/billing/admin/*` | Console do superadmin |
| `docs/operacoes/RUNBOOK_ATIVAR_MENSALIDADE.md` | Roteiro de ativação |

---

### Task 1: Modelo puro da faixa e do bloqueio

**Files:**
- Create: `src/lib/billing/billing-view.ts`
- Test: `src/lib/billing/billing-view.test.ts`

**Interfaces:**
- Produces:
  - `type BillingAccessState = "exempt"|"frozen"|"locked_manual"|"awaiting_first_payment"|"ok"|"due_soon"|"overdue"|"locked_unpaid"`.
  - `type BillingRole = "payer"|"member"|"super_admin"`.
  - `billingView(input: { state: BillingAccessState; role: BillingRole; enforcement: boolean; invoice: { amountCents: number; dueDate: string /* YYYY-MM-DD */ } | null; today: string }): { banner: { tone: "yellow"|"red"; text: string; showPay: boolean; memberHint: string | null } | null; lock: { title: string; text: string; showPay: boolean; memberHint: string | null } | null; canBuyCredits: boolean }`.
  - `isEffectiveLock(state, enforcement): boolean`.

- [ ] **Step 1: Write the failing tests** (textos exatos de Global Constraints; valores formatados como `R$ 4.000,00`):
  - `due_soon` (vence 05/11, hoje 02/11, pagador) → faixa amarela com o texto exato `"Sua mensalidade de R$ 4.000,00 vence em 05/11 (daqui a 3 dias). Pague por Pix para manter tudo funcionando."` e `showPay` true.
  - `overdue` com enforcement → faixa vermelha `"… venceu em 05/11. Se não for paga até 08/11, o acesso ao CRM será bloqueado."`. Sem enforcement → `"Sua mensalidade venceu em 05/11. Pague para regularizar."`.
  - `locked_unpaid` com enforcement → `lock` preenchido, `banner` null e `canBuyCredits` false. Sem enforcement → `lock` null e faixa vermelha "regularizar".
  - `locked_manual` → lock `"Acesso suspenso. Fale com o suporte."` com `showPay` false. Se também houver fatura vencida (hoje `>= dueDate`), `showPay` é true para o pagador.
  - `frozen` → `"Plano pausado. Fale com o suporte."`.
  - `awaiting_first_payment` com enforcement → lock `"Ative sua conta"`.
  - Membro em qualquer estado com aviso → `showPay` false e `memberHint` `"Peça ao administrador da casa para pagar a mensalidade."`.
  - Superadmin com `locked_unpaid` → `lock` null e faixa vermelha presente.
  - `exempt` e `ok` → `banner` null e `lock` null.
  - "daqui a 1 dia" no singular.
- [ ] **Step 2: Run `npx vitest run src/lib/billing/billing-view.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): pure banner and lock view model for the monthly plan`

---

### Task 2: Banco — faturas, estado, baixa e ações em SQL

**Files:**
- Create: `supabase/migrations/20261023100000_billing_invoices.sql`
- Test: `src/lib/billing/billing-invoices.db.test.ts` (reusar `billing-db-test-support.ts`; aplicar as migrations `20261022100000`, `100100`, `110000` antes)

**Interfaces:**
- Consumes: `billing_plans`, `billing_tenant_exempt(uuid)` (PG1); `payment_charges`, `billing_credit_paid_charge(uuid)` (PG2, ramo `invoice` hoje lança `invoice_not_supported`).
- Produces (tabelas):
  - `tenant_billing`:
    - chave: `tenant_id pk`, `plan_code default 'crm_unico'`;
    - preço e desconto: `custom_price_cents bigint null`, `discount_kind text null check in ('percent','fixed')`, `discount_value numeric(12,2) null`, `discount_starts_on date null`, `discount_ends_on date null`;
    - ciclo: `next_due_date date null`;
    - bloqueio e congelamento: `manual_block boolean default false`, `manual_block_reason text`, `frozen boolean default false`;
    - estado: `access_state text check (os 8 estados)`, `access_state_at timestamptz`, `updated_at`.
  - `billing_invoices`:
    - chave e período: `id uuid pk`, `tenant_id`, `period_start date`, `period_end date`, `cycle_due_date date`, `due_date date`;
    - valores: `base_amount_cents`, `discount_cents bigint default 0`, `one_off_discount_cents bigint default 0`, `amount_cents`;
    - situação: `status check in ('open','paid','canceled')`;
    - pagamento: `paid_at`, `paid_via check in ('pix','manual','full_discount') null`, `paid_amount_cents`, `payment_charge_id uuid null`;
    - baixa manual: `manual_note text`, `manual_receipt text`;
    - cancelamento: `canceled_reason text`;
    - datas: `created_at`, `updated_at`.
    - Índice único parcial `(tenant_id) where status = 'open'`.
  - `billing_email_log(invoice_id, kind check in ('issued','due_today','locked','paid'), sent_at, recipients int)`, com pk `(invoice_id, kind)`.
- Produces (funções; todas service_role, salvo indicação):
  - `billing_today() returns date`: `billing_now()` em Brasília (honra o relógio de teste da PG1).
  - `billing_add_months(_d date, _n int) returns date`: soma meses com fim de mês ajustado.
  - `billing_monthly_amount(_tenant uuid, _cycle_due date) returns jsonb {base_cents, discount_cents, amount_cents}`: aplica preço próprio e desconto contínuo.
  - `billing_refresh_access_state(_tenant uuid) returns text`: aplica a precedência de Global Constraints e grava `access_state`.
  - `billing_generate_due_invoices() returns setof uuid`: casas pagantes, sem fatura aberta, não congeladas, com `next_due_date - 5 <= billing_today()`.
    - Cria a fatura com período `[cycle_due, add_months(cycle_due,1) - 1]`.
    - Valor 0 recebe baixa com `full_discount`.
    - Devolve os ids criados.
  - `billing_settle_invoice(_invoice uuid, _via text, _paid_amount_cents bigint, _note text, _receipt text, _charge uuid) returns jsonb`:
    - exige fatura `open`;
    - aplica a regra de ciclo de Global Constraints;
    - recalcula o estado;
    - devolve `{ok, tenant_id, next_due_date}`.
  - **Gatilho** `after insert or update of plano on tenants`:
    - Casa vira não isenta e não tem `tenant_billing`: cria a linha com `next_due_date = billing_today()` e gera a primeira fatura, que vence hoje. O estado vira `awaiting_first_payment`.
    - Casa vira isenta: cancela a fatura aberta com motivo `'Casa isenta'` e o estado vira `exempt`.
  - **Carga inicial:** cria `tenant_billing` para toda casa. As isentas ficam `exempt`. As pagantes recebem `next_due_date = billing_today()` e a primeira fatura (hoje só existe a casa de teste).
  - **`billing_credit_paid_charge`**, ramo `invoice`:
    - exige `PAID`, valor igual a `amount_cents` da fatura e fatura `open`;
    - chama `billing_settle_invoice(ref_id,'pix',paid_amount_cents,null,null,charge_id)`;
    - grava `credited_at`;
    - **não** credita saldo.
  - **Ações do superadmin** (SECURITY DEFINER, `is_super_admin()`; o motivo é validado na TS):
    - `billing_admin_set_block(_tenant, _blocked bool, _reason)`;
    - `billing_admin_extend_due(_invoice, _days int)`: `due_date += days`, `cycle_due_date` não muda;
    - `billing_admin_free_days(_tenant, _days int)`: `next_due_date += days`; se há fatura aberta, `due_date`, `cycle_due_date` e `period_end` também andam;
    - `billing_admin_one_off_discount(_invoice, _kind, _value)`: recalcula `amount_cents` com a regra do mínimo; com valor 0 dá baixa `full_discount`;
    - `billing_admin_set_continuous_discount(_tenant, _kind, _value, _starts, _ends)`: com kind null remove o desconto; recusa se o valor resultante do plano ficar entre 1 e 9999 centavos;
    - `billing_admin_manual_settle(_invoice, _paid_amount_cents, _note, _receipt)`;
    - `billing_admin_cancel_invoice(_invoice, _reason)`;
    - `billing_admin_set_cycle_day(_tenant, _next_due date)`: só muda `next_due_date`; a fatura aberta mantém a data;
    - `billing_admin_set_frozen(_tenant, _frozen bool)`: ao descongelar, `next_due_date = billing_today()` e gera a fatura na hora;
    - `billing_admin_set_custom_price(_tenant, _price_cents bigint null)`.
  - Todas recalculam o estado no final.
- RLS:
  - Casa lê o próprio `tenant_billing`, `billing_invoices` e `billing_email_log` (só leitura).
  - `manual_note` e `manual_receipt` aparecem só para o superadmin (grant por coluna, como na PG2).

- [ ] **Step 1: Write the failing tests** (relógio fixo via `test.now` + `app.allow_test_clock`):
  - **Soma de meses:** `billing_add_months('2026-01-31',1) = '2026-02-28'`.
  - **Gatilho de plano:**
    - casa troca `interno` → `enterprise`: fatura aberta vencendo hoje, estado `awaiting_first_payment`;
    - volta a `interno`: fatura cancelada (`'Casa isenta'`), estado `exempt`.
  - **Estados**, com fatura de vencimento em 05/11:
    - dia 30/10 → `ok`;
    - 31/10 → `due_soon`;
    - 05/11 → `overdue`;
    - 08/11 → `overdue`;
    - 09/11 → `locked_unpaid`.
  - **Baixa de casa em dia:** em 03/11 (`due_soon`), `next_due_date` = 05/12.
  - **Baixa de casa bloqueada:** fatura vencida em 05/11, baixa em 20/12 (`locked_unpaid`) → `next_due_date` = 20/01, estado `ok`.
  - **Geração:** com `next_due_date` = 05/12, em 29/11 não gera nada; em 30/11 gera a fatura `[05/12, 04/01]`. Rodar duas vezes cria uma só.
  - **Casa bloqueada não ganha fatura nova:** com a fatura aberta vencida, rodar a geração mês depois não cria outra.
  - **Extensão:** `extend_due +5` → `due_date` 10/11, `cycle_due_date` 05/11. A baixa depois disso faz `next_due` = 05/12.
  - **Dias grátis:** `free_days 15` com fatura aberta → `due_date` e `cycle_due_date` +15.
  - **Descontos e preço:**
    - pontual de 100% → `paid_via full_discount`;
    - pontual que deixa R$ 50 → erro com a mensagem exata;
    - contínuo de 10% → fatura de 360000;
    - preço próprio de 300000 + 10% → 270000.
  - **Congelar:** congelar → `frozen`; descongelar → fatura vencendo hoje.
  - **Ramo de fatura do RPC:** `billing_credit_paid_charge` com cobrança `kind='invoice'` PAID → fatura `paid` (`paid_via 'pix'`), saldo da carteira inalterado, estado recalculado. Chamado de novo → idempotente.
  - **Isolamento:** casa A não lê as faturas da casa B. Casa não lê `manual_note`.
- [ ] **Step 2: Run `npx vitest run src/lib/billing/billing-invoices.db.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Write the migration.** O ramo de fatura edita `billing_credit_paid_charge` com `create or replace` copiado da versão atual (`20261022110000`), mudando só o ramo `invoice`.
- [ ] **Step 4: Run** `npx vitest run src/lib/billing/` and `npm run typecheck` (after `types.ts`). Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): invoices, billing state, settle rules and admin actions in SQL`

---

### Task 3: Ciclo da hora e Pix da fatura (servidor)

**Files:**
- Create: `src/lib/billing/invoices.server.ts`, `src/routes/api/public/hooks/billing-cycle.ts`, `supabase/migrations/20261023100100_billing_cycle_cron.sql`
- Modify: `src/lib/billing/payment-charges.server.ts` (o `confirmChargeFromUpper` de fatura passa a devolver `credited` ao dar baixa; já funciona via RPC)
- Test: `src/lib/billing/invoices.server.test.ts`

**Interfaces:**
- Consumes:
  - as funções SQL da Task 2;
  - `createUpperCharge` e `cancelUpperCharge` (`upper-pix.server.ts`);
  - `recordChargeSnapshot` (`payment-charges.server.ts`);
  - `withJobRun` e `requireSharedSecret(request, "CRON_SECRET")`;
  - os e-mails da Task 5, por injeção: aceite `sendEmails?: (events) => Promise<void>` com padrão no-op até a Task 5 ligar.
- Produces:
  - `runBillingCycle(opts?: { now?: Date }): Promise<{ generated: number; refreshed: number; emails: number }>`:
    - não faz nada se `BILLING_INVOICES_ENABLED !== "true"`, mas recalcula os estados mesmo assim;
    - sequência: `billing_generate_due_invoices` → recalcular o estado de todas as casas pagantes → e-mails pendentes.
  - `createInvoicePayment(invoiceId: string, actorUserId: string): Promise<{ chargeId, emv, qrCodeImage, paymentUrl, expiresAt, amountCents }>`:
    - reaproveita a cobrança `ACTIVE` válida;
    - senão cria `bl-inv-<id>-<n>` com a validade de Global Constraints;
    - descrição: `"<Nome da casa> - Mensalidade BetLeads MM/AAAA"`, cortada em 140 caracteres pela mesma função de corte da PG2.
  - `cancelOpenInvoiceCharges(invoiceId: string): Promise<void>`: cancela na Upper e grava `CANCELLED`. Usada por desconto e cancelamento.
  - Rota `POST /api/public/hooks/billing-cycle` (CRON_SECRET) com job `billing-cycle`.
  - Migration do cron `betleads-billing-cycle` às `7 * * * *` (padrão de `20261022110100`).

- [ ] **Step 1: Write the failing tests:**
  - **Flag de faturas desligada:** não gera, mas recalcula.
  - **Flag ligada:** gera e devolve a contagem.
  - **Pagamento da fatura:**
    - `createInvoicePayment` reaproveita a cobrança ACTIVE com mais de 5 min de validade;
    - com a anterior vencida, cria `-2`;
    - a validade fica entre 3600 e 604800;
    - a descrição tem 140 caracteres ou menos e o formato da mensalidade.
  - **Fatura já paga:** `createInvoicePayment` lança `"Esta fatura já está paga."`.
  - **Cancelamento:** `cancelOpenInvoiceCharges` chama a Upper e grava CANCELLED.
  - **Rota:** recusa sem segredo.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Atualize `routeTree.gen.ts` como nas tarefas da PG2 (gerador e mais o bloco `declare module` restaurado).
- [ ] **Step 4: Run** `npx vitest run src/lib/billing/` + `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): hourly billing cycle and Pix payment of invoices`

---

### Task 4: Bloqueio no servidor e quem paga

**Files:**
- Create: `src/lib/billing/billing-state.server.ts`
- Modify:
  - `src/lib/tenant-access.server.ts` (`getCachedTenantStatus`/`getTenantStatus` passam a trazer o estado de cobrança; `assertTenantCanOperate`, `assertTenantCanSendExternally`, `resolveOperationalTenantId`, `resolveOperationalTenantForRequest` e `resolveCurrentTenantId` recusam a casa com bloqueio efetivo para quem não é superadmin);
  - `src/lib/billing/topup.functions.ts` (quem paga = `requireTenantPayer`; casa com bloqueio efetivo recebe `"Disponível depois de pagar a mensalidade"`);
  - `src/lib/sms-credits.functions.ts` (`canBuy` usa `requireTenantPayer` sem lançar, e é false com bloqueio);
  - `src/lib/tenants.functions.ts` (`getCurrentTenantAccessStatus` devolve `billing: { state, effectiveLock, role, invoice }`).
- Test: `src/lib/billing/billing-state.server.test.ts` e testes existentes de `tenant-access` / `topup` / `sms-credits` (atualizar).

**Interfaces:**
- Produces:
  - `getTenantBillingSnapshot(tenantId: string): Promise<{ state: BillingAccessState; invoice: { id; amountCents; dueDate; status } | null; nextDueDate: string | null; manualBlockReason: string | null }>`, lido com supabaseAdmin.
  - `isBillingLockedFor(tenantId: string, userId: string): Promise<boolean>`: falso para superadmin; usa `isEffectiveLock` e `BILLING_ENFORCEMENT_ENABLED`.
  - `requireTenantPayer(supabase, tenantId, message): Promise<void>`: aceita papel `admin`, `owner` ou `gestor` na casa (via `user_roles`) e o superadmin; senão lança a mensagem.
  - `resolveTenantForBilling(supabase, userId, requestedTenantId)`: igual a `resolveOperationalTenantForRequest`, mas **sem** recusar casa bloqueada. É o único resolvedor que as funções de cobrança usam.
  - O erro de casa bloqueada é `class TenantBillingLockedError extends Error` com `code = "BILLING_LOCKED"` e mensagem `"Acesso suspenso. Regularize a mensalidade em Plano e créditos."`.
  - Travas de envio:
    - `assertTenantCanSendExternally` lança `TenantBillingLockedError`;
    - os dispatchers devem tratá-lo como **final, sem nova tentativa**, igual ao `DemoTenantBlockedError`. Localize onde os dispatchers tratam `DemoTenantBlockedError` e inclua a nova classe.
  - O webhook de entrada da casa (`src/routes/api/public/webhook.$token.$evento.ts`) **continua aceitando dados** de casa bloqueada, para não perder cadastros e depósitos.

- [ ] **Step 1: Write the failing tests:**
  - **Quem paga:** `requireTenantPayer` aceita admin, owner, gestor e superadmin, e recusa member e user.
  - **Bloqueio efetivo:**
    - `isBillingLockedFor`: `locked_unpaid` com enforcement → true para admin e false para superadmin; sem enforcement → false; `locked_manual` → true mesmo sem enforcement.
    - `resolveOperationalTenantForRequest` de um admin numa casa bloqueada lança `BILLING_LOCKED`.
    - `resolveTenantForBilling` na mesma casa passa.
  - **Travas de envio e compra:**
    - `assertTenantCanSendExternally` numa casa bloqueada lança `TenantBillingLockedError`;
    - um dispatcher existente com teste (ex.: `sms-bulk.server.test.ts`) marca o item como falha final, sem nova tentativa;
    - `createCreditTopup` com o gestor passa (antes era recusado);
    - casa bloqueada recusa a compra com `"Disponível depois de pagar a mensalidade"`.
  - **Webhook de entrada:** o webhook da casa aceita um evento de cadastro com a casa em `locked_unpaid` e enforcement ligado (teste de rota).
  - **Status para a interface:** `getCurrentTenantAccessStatus` traz o bloco `billing`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Cache curto de 5 s, igual ao status atual.
- [ ] **Step 4: Run `npm test` + `npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): lock unpaid houses on the server; admin, owner and gestor can pay`

---

### Task 5: E-mails de cobrança

**Files:**
- Create: `src/lib/billing/billing-emails.server.ts`
- Modify: `src/lib/billing/invoices.server.ts` (liga os e-mails no ciclo da hora); `src/lib/billing/payment-charges.server.ts` ou o ramo de baixa (dispara `paid` depois da baixa por Pix, manual ou desconto integral); `.env.example`, `docs/docker-deployment.md`
- Test: `src/lib/billing/billing-emails.server.test.ts`

**Interfaces:**
- Consumes: `sendInfobipEmail({ to, from, fromName, subject, html, idempotencyKey, tenantId })` (`src/lib/email-send.server.ts`). Leia a função para entender a trava de demo e as regras de remetente. O remetente da plataforma **não** passa pelo `resolveSender` das casas.
- Produces:
  - `sendPendingBillingEmails(opts?: { now?: Date }): Promise<number>`:
    - só roda com `BILLING_INVOICES_ENABLED` e dentro da janela 08:00–20:00 de Brasília;
    - `issued`: faturas abertas sem log `issued`;
    - `due_today`: `due_date` = hoje, sem log;
    - `locked`: casas em `locked_unpaid` com enforcement ligado, sem log para a fatura;
    - `paid`: faturas pagas nas últimas 48 h, sem log.
  - `sendBillingEmail(invoiceId: string, kind: "issued"|"due_today"|"locked"|"paid", opts?: { force?: boolean }): Promise<{ sent: boolean; recipients: number }>`:
    - grava `billing_email_log` com `insert ... on conflict do nothing` **antes** de enviar;
    - se a linha já existia e não há `force`, não envia;
    - `force` é usado pelo reenvio do superadmin;
    - `idempotencyKey` é `billing:<invoiceId>:<kind>`.
  - Assuntos:
    - `"Sua mensalidade BetLeads vence em DD/MM"`;
    - `"Sua mensalidade BetLeads vence hoje"`;
    - `"Acesso ao CRM suspenso por falta de pagamento"`;
    - `"Pagamento confirmado — obrigado!"`.
  - O corpo é HTML simples, em tema claro, com o botão `"Abrir Plano e créditos"` → `https://betleads.io/plano-e-creditos`.

- [ ] **Step 1: Write the failing tests:**
  - **Destinatários:** admin, owner e gestor; member fica de fora.
  - **Janela:** às 21:00 não envia nada.
  - **Concorrência e reenvio:**
    - duas chamadas concorrentes de `sendBillingEmail(id,'issued')` → um envio (a segunda vê o conflito);
    - `force` reenvia.
  - **Bloqueio:** sem enforcement, `locked` não sai.
  - **Casa isenta:** nenhum e-mail (ela não tem fatura).
  - **Remetente:** o `from` vem de `PLATFORM_EMAIL_FROM` e cai em `no-reply@betleads.io` quando a env não existe.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npx vitest run src/lib/billing/` + `npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): billing e-mails from the platform sender`

---

### Task 6: Faixa e bloqueio na interface

**Files:**
- Create: `src/components/billing/billing-banner.tsx`, `src/components/billing/billing-lock.tsx`
- Modify:
  - `src/components/tenant-status-gate.tsx`: mostra o cartão de bloqueio da Task 1 quando `billing.effectiveLock`, exceto na rota `/plano-e-creditos`;
  - o shell que envolve as páginas da casa (localize onde `TenantStatusGate` e o topo são montados): renderiza `BillingBanner` logo abaixo do topo, em todas as telas e no celular.
- Test: teste de componente ao lado de cada arquivo, seguindo o padrão de testes de componente do repo (ex.: `src/components/billing/wallet-balance-notice.test.tsx`).

**Interfaces:**
- Consumes: `billingView` (Task 1) e `getCurrentTenantAccessStatus().billing` (Task 4).
- Produces:
  - `BillingBanner()`: lê o status e usa `billingView`. O botão leva a `/plano-e-creditos`. A faixa não pode ser fechada.
  - `BillingLock({ view })`: o cartão de bloqueio.

- [ ] **Step 1: Write the failing tests:**
  - faixa amarela com o botão para o pagador;
  - faixa sem botão e com a dica para o membro;
  - bloqueio renderizado fora de `/plano-e-creditos`;
  - em `/plano-e-creditos` o bloqueio não aparece;
  - superadmin vê a faixa e não o bloqueio.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` + `npm run typecheck` + `npm run lint`.** Expected: PASS, 0 erros.
- [ ] **Step 5: Commit** — `feat(billing): plan banner and lock screen across the CRM`

---

### Task 7: Página "Plano e créditos"

**Files:**
- Create:
  - `src/routes/plano-e-creditos.tsx` (o conteúdo de `src/routes/creditos-sms.tsx` vira esta página);
  - `src/components/billing/pix-payment-dialog.tsx` (modal de Pix genérico, extraído de `buy-credits-dialog.tsx`);
  - `src/lib/billing/billing.functions.ts` (`getPlanOverview`, `payInvoice`, `getInvoiceReceipt`).
- Modify:
  - `src/routes/creditos-sms.tsx`: redireciona para `/plano-e-creditos`;
  - `src/lib/navigation.ts`: o item vira "Plano e créditos" → `/plano-e-creditos`; teste do menu;
  - `src/components/billing/buy-credits-dialog.tsx`: usa o modal genérico;
  - `src/components/billing/wallet-balance-notice.tsx`: o link aponta para `/plano-e-creditos`.
- Test: `src/lib/billing/billing.functions.test.ts` e o teste do menu.

**Interfaces:**
- Consumes: `resolveTenantForBilling`, `requireTenantPayer`, `getTenantBillingSnapshot` (Task 4); `createInvoicePayment` (Task 3); `getTopupStatus` (PG2), que serve para acompanhar qualquer cobrança.
- Produces:
  - `getPlanOverview({ tenantId })` → `{ state, plan: { name, priceCents, discountedCents, discountLabel } | null, exempt: boolean, currentPeriod: { start, end } | null, nextDueDate, openInvoice: {...} | null, invoices: Array<{ id, periodStart, periodEnd, dueDate, amountCents, discountCents, status, paidAt, paidVia }>, canPay: boolean, canBuyCredits: boolean }`.
  - `payInvoice({ tenantId, invoiceId })` → o retorno de `createInvoicePayment`. Exige `requireTenantPayer`; a fatura tem de ser da casa e estar aberta.
  - `getInvoiceReceipt({ tenantId, invoiceId })` → `{ paidAt, amountCents, description, endToEndOrExternalId, paidVia }`, só para fatura paga.
- Página (ordem e textos do desenho, seção 4):
  - **Mensalidade:** selo de situação ("Em dia até DD/MM", "Vence em DD/MM · daqui a N dias", "Vencida em DD/MM", "Bloqueada") e o botão "Pagar mensalidade (Pix)". Casa isenta mostra "Plano interno — isento".
  - **Saldo de uso:** "Comprar créditos (Pix)". Desabilitado com `"Disponível depois de pagar a mensalidade"` quando `canBuyCredits` é false por bloqueio.
  - **Faturas:** "Pagar" na fatura aberta e "Comprovante" na paga.
  - **Consumo e extrato:** os blocos atuais.
  - **Modal de mensalidade pago:** `"Mensalidade paga — acesso liberado até DD/MM"`. Invalida o status de acesso e as consultas de cobrança.

- [ ] **Step 1: Write the failing tests:**
  - **Visão do plano (`getPlanOverview`):**
    - isenta → `exempt`, sem faturas;
    - pagante com desconto → `discountLabel`;
    - `canPay` false para member.
  - **Pagar a fatura (`payInvoice`):**
    - fatura de outra casa → recusada;
    - fatura paga → `"Esta fatura já está paga."`.
  - **Comprovante:** `getInvoiceReceipt` de fatura aberta → recusado.
  - **Menu:** `/plano-e-creditos` aparece em "Configurações" com o título "Plano e créditos".
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` + `npm run typecheck` + `npm run lint`.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): Plano e créditos page with invoices and Pix payment`

---

### Task 8: Console do superadmin — servidor

**Files:**
- Create: `src/lib/billing/billing-admin.functions.ts`
- Test: `src/lib/billing/billing-admin.functions.test.ts`

**Interfaces:**
- Consumes: as ações SQL da Task 2 (chamadas com o **cliente do usuário**, porque `is_super_admin()` precisa de `auth.uid()`; ver a lição da PG1); `cancelOpenInvoiceCharges` (Task 3); `sendBillingEmail(..., { force: true })` (Task 5); a auditoria em `tenant_audit_logs`.
- Produces: todas exigem superadmin, motivo com 5 ou mais caracteres e auditoria `billing.<ação>`.
  - **Bloqueio, prazo e dias grátis:** `adminSetTenantBlock`, `adminExtendInvoiceDue`, `adminGrantFreeDays`.
  - **Descontos:** `adminApplyInvoiceDiscount`, que antes cancela os Pix abertos da fatura, e `adminSetContinuousDiscount`.
  - **Faturas:** `adminManualSettle` (com comprovante em texto) e `adminCancelInvoice`, que cancela os Pix abertos.
  - **Ciclo e plano:** `adminSetCycleDay`, `adminSetFrozen` e `adminSetCustomPrice`.
  - **E-mail:** `adminResendBillingEmail`.
  - **Leituras:**
    - `adminBillingDashboard()` → `{ mrrCents, receivedThisMonthCents, dueNext5DaysCents, overdueInvoices, lockedUnpaid, lockedManual, frozen, needsReview }`.
    - `adminTenantBillingHistory({ tenantId })`: linha do tempo com faturas, pagamentos e auditoria `billing.%`, ordenada por data.
    - `adminBillingMonthlyCsv({ month: "YYYY-MM" })`: texto CSV por casa, com as colunas do desenho (seção 6, item 12). As isentas vêm à parte.
  - **Taxa do Pix:** `adminSetPixFee({ feePercent, feeFixedCents })`, que insere uma linha nova em `payment_fee_settings`.
- Mensagens: os erros do SQL viram textos em pt-BR (ex.: `invoice_not_open` → `"Só faturas em aberto podem ser alteradas."`).

- [ ] **Step 1: Write the failing tests:**
  - **Permissão e motivo:** cada ação recusa quem não é superadmin e recusa motivo curto.
  - **Cliente usado:** chama o RPC pelo cliente do usuário, não pelo `supabaseAdmin`.
  - **Auditoria:** grava a ação.
  - **Pix abertos:** o desconto e o cancelamento chamam `cancelOpenInvoiceCharges`.
  - **Painel:** `adminBillingDashboard` com dados simulados confere a MRR (soma do valor com desconto contínuo das casas pagantes não congeladas).
  - **CSV:** cabeçalho exato e isentas à parte.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(billing): super admin billing actions, dashboard, history and CSV`

---

### Task 9: Console do superadmin — telas

**Files:**
- Create: `src/components/billing/admin/*` (painel, lista de casas com situação, ações em diálogos, histórico, CSV, taxa do Pix)
- Modify: `src/routes/admin.tsx` (aba "Faturamento"); `src/routes/tenants.tsx` (seção "Cobrança" na ficha da casa, com as mesmas ações e o histórico)
- Test: testes de componente para os diálogos com motivo obrigatório e para o painel

**Interfaces:**
- Consumes: as funções da Task 8.
- Comportamento:
  - Cada ação abre um diálogo com os campos dela e o motivo obrigatório.
  - Botões com rótulo claro: "Bloquear casa", "Estender prazo", "Dar dias grátis", "Desconto nesta fatura", "Desconto contínuo", "Dar baixa manual", "Cancelar fatura", "Trocar dia de vencimento", "Congelar plano", "Preço próprio", "Reenviar e-mail".
  - O painel mostra os 8 números da Task 8.
  - O CSV baixa um arquivo `cobranca-YYYY-MM.csv`.

- [ ] **Step 1: Write the failing tests:**
  - o diálogo não envia com motivo vazio;
  - o painel mostra os valores formatados em R$;
  - a lista indica a situação de cada casa.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` + `npm run typecheck` + `npm run lint`.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): super admin billing console screens`

---

### Task 10: Roteiro de ativação (só documento)

**Files:**
- Create: `docs/operacoes/RUNBOOK_ATIVAR_MENSALIDADE.md` + linha em `docs/INDEX.md`

Cada passo tem comando ou SQL, resultado esperado, o que fazer se der diferente e o campo **Resultado:**. Toda escrita em produção exige autorização.

1. **Leitura:** listar casas pagantes (`billing_tenant_exempt = false`). Hoje só existe a QA Jornadas P0.
2. **Env:** `BILLING_INVOICES_ENABLED=false`, `BILLING_ENFORCEMENT_ENABLED=false` e `PLATFORM_EMAIL_FROM`.
3. **Migration `20261023100000`.** Conferir `tenant_billing` (isentas em `exempt`; a QA com a fatura de hoje e o estado `awaiting_first_payment`).
4. **Deploy.** Registrar o SHA anterior, puxar o main e recriar o container.
5. **Migration `20261023100100`** (cron), depois do deploy. Conferir a execução `billing-cycle`.
6. **Ligar `BILLING_INVOICES_ENABLED=true`.** Conferir os e-mails na janela de envio, com um e-mail de teste do admin da QA.
7. **Pagar a fatura da QA (R$ 4.000).**
   - Depende de a compra por Pix da PG2 estar ativa (roteiro `RUNBOOK_ATIVAR_PIX_UPPER.md`).
   - Para não gastar R$ 4.000, aplique antes um preço próprio de R$ 100 na QA pelo console, com o motivo "teste de ativação".
8. **Ligar `BILLING_ENFORCEMENT_ENABLED=true`** só depois do aviso por escrito às casas que forem passar a pagar.
9. **Monitoramento:**
   - casas `locked_unpaid`;
   - faturas abertas vencidas;
   - e-mails com falha.
10. **Rollback:**
    - desligar as flags;
    - as tabelas são aditivas;
    - nunca apagar faturas pagas.

- [ ] **Step 1: Write the runbook.**
- [ ] **Step 2: Commit** — `docs(billing): monthly plan activation runbook`

---

## Fora deste plano

- Cobrança de voz e e-mail no envio (PG3).
- Nota fiscal automática.
- Boleto e cartão.
- Estorno.
