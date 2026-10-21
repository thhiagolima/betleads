# Escopo: gateway de pagamento Upper (Pix) para o plano do CRM e os créditos de serviços

**Origem:** documentação "Upper · API Pix do afiliado" v1 (outubro de 2026) e o levantamento do código de 21/10/2026 (seção 3).
**Status:** proposto. Decisões respondidas em 21/10/2026, exceto a D12 (nota fiscal), que segue com a recomendação. Também falta a confirmação de custo com a Infobip (PG0-05).
**Objetivo:**
- A casa paga a mensalidade do CRM e compra créditos por Pix dentro do sistema.
- O pagamento é confirmado sozinho em segundos, sem ação do superadmin.
- Cada SMS, ligação e e-mail desconta do saldo pelo preço vigente.
- A casa com fatura vencida passa a ter os envios bloqueados de forma automática e previsível.

**Princípio:** dinheiro nunca é confirmado pelo navegador nem só pelo webhook. Todo crédito em saldo nasce de uma cobrança conferida na API da Upper (`GET /v1/pix/charges/{externalId}`) e de um lançamento idempotente no razão. O saldo é sempre igual à soma do razão.

Esforço (uma pessoa, testes incluídos): **P** até 1 dia, **M** 2 a 4 dias, **G** 1 semana ou mais.

---

## 1. Tabela de preços (entrada do produto)

| Item | Preço de venda | Unidade de cobrança | Observação |
|---|---|---|---|
| **Plano CRM (único)** | **R$ 4.000,00** | por mês, pré-pago | Libera o uso do CRM e a franquia de e-mail |
| **SMS** | **R$ 0,08** | por SMS aceito pelo provedor | Hoje o padrão é R$ 0,12 e o custo real é R$ 0,059 |
| **Voz** | **R$ 0,09** | por bloco de 30 s iniciado | Uma chamada de 45 s usa 2 blocos e custa R$ 0,18 |
| **E-mail** | **grátis até 100.000/mês**, depois **R$ 0,002** | por e-mail aceito pelo provedor | A franquia é por casa e por mês civil (America/Sao_Paulo) |

Os preços ficam em uma tabela única no banco (item PG1-01), com exceção por casa. Nenhum preço fica fixo no código.

Exemplos de conta:
- Disparo de 50.000 SMS: R$ 4.000,00.
- 1.000.000 de e-mails em um mês: 100.000 grátis + 900.000 × R$ 0,002 = R$ 1.800,00.
- 10.000 ligações de 40 s: 20.000 blocos × R$ 0,09 = R$ 1.800,00.

---

## 2. Decisões do responsável pelo produto (bloqueiam itens)

| # | Pergunta | Recomendação | Bloqueia |
|---|---|---|---|
| D1 | **Créditos:** saldo único ou por canal? | ✅ **Decidido: saldo único em R$** para os três canais. Os créditos SMS de hoje são convertidos (PG1-05) | PG1 inteira |
| D2 | **Ciclo do plano** | ✅ **Decidido: o vencimento é o dia da ativação de cada casa, sem pró-rata.** A primeira fatura vence na ativação e a seguinte um mês depois. Quando o dia não existe no mês (29, 30 ou 31), vence no último dia do mês | PG4-01, PG4-02 |
| D3 | **Inadimplência** | ✅ **Decidido:** fatura gerada 5 dias antes do vencimento e **carência de 3 dias** depois dele. Em seguida, status `suspended`: os envios (SMS, voz, e-mail, jornadas) param, mas o acesso continua para ver dados e pagar. O pagamento reativa na hora | PG4-04, PG4-05 |
| D4 | **Créditos sem plano ativo:** a casa suspensa pode usar o saldo? | ✅ **Decidido:** não usa enquanto estiver suspensa, mas **o saldo nunca é perdido**. Ele fica intacto durante a suspensão e volta a valer assim que a fatura for paga. Suspensão, inadimplência ou cancelamento não zeram nem expiram créditos | PG3-01, PG4-04 |
| D5 | **As 3 casas com preço próprio (`pixpgf`, `pixreals`, `forrandobet`) e o tenant demo** | ✅ **Decidido: isentas de tudo** (plano e consumo). A marcação é o plano **`interno`**, que já existe em `tenants.plano`. Casa no plano `interno` não recebe fatura, não é suspensa e não tem débito de saldo em nenhum canal. O consumo continua registrado com venda de R$ 0,00 e o custo do provedor, para o relatório de margem. O demo também entra como `interno` e nunca chama a Upper (PG1-07) | PG1-05, PG1-07, PG4-01 |
| D6 | **SMS longo:** um SMS com mais de 160 caracteres conta como 1 ou como N segmentos? | ✅ **Decidido: conta como vários, calculado.** Preço = R$ 0,08 × número de segmentos. A contagem segue a regra GSM-7 (até 160 caracteres em 1 segmento, 153 por segmento quando concatenado) e usa UCS-2 (70 e 67) quando há acento ou emoji fora do GSM-7. O editor mostra a contagem e o valor | PG3-02 |
| D7 | **Voz:** chamada não atendida, ocupada ou caixa postal é cobrada? | ✅ **Decidido, a princípio: não é cobrada.** Só a chamada atendida (duração > 0) paga, com mínimo de 1 bloco. **Pendente:** confirmar com a Infobip se a tentativa não atendida tem custo para nós (PG0-05). Se tiver, a regra fica configurável no preço de voz, para mudar sem código | PG3-03, PG0-05 |
| D8 | **Os créditos expiram?** | ✅ **Decidido: não expiram**, nem com o plano suspenso (ver D4). O razão novo não tem o tipo `expiration` | PG1-02 |
| D9 | **Compra de créditos:** valor livre ou pacotes? Qual o mínimo? Há bônus? | ✅ **Mínimo decidido: R$ 100,00 por cobrança** (mínimo da Upper). Pacotes de R$ 500, R$ 1.000, R$ 2.500 e R$ 5.000 **mais** valor livre a partir de R$ 100, sem bônus na primeira versão | PG2-04 |
| D10 | **Quem paga** | ✅ **Decidido: só o admin da casa** gera cobrança e paga. Gestor e operador veem o saldo e a fatura | PG2-04, PG4-03 |
| D11 | **Dados comerciais da Upper** | ✅ **Decidido:**<br>• o `payer` vem no retorno<br>• o mínimo por cobrança é R$ 100,00<br>• a **taxa do Pix fica em aberto, configurável pelo superadmin** (percentual e/ou valor fixo por Pix recebido, com vigência) e é usada só no relatório de receita líquida e margem<br>**A confirmar:** teto diário de recebimento e estorno | PG2-02, PG5-02, PG5-03 |
| D12 | **Nota fiscal de serviço** (R$ 4.000 por mês para empresas) | Fora desta entrega: emissão manual pelo financeiro, a partir de um relatório mensal (PG5-03). A emissão automática de NFS-e entra no backlog | PG5-03 |
| D13 | **Cancelamento e saldo restante** | ✅ **Decidido: sem reembolso.** O saldo continua na conta (D4/D8) | — |
| D14 | **Data de corte** | ✅ **Decidido:** cobrança ligada em produção com o bloqueio **desligado** durante o primeiro ciclo. O bloqueio é ligado a partir da segunda fatura, com aviso por escrito às casas | PG6 |

---

## 3. O que já existe no código (ponto de partida)

**Já existe e será reaproveitado ou substituído**
- **Créditos SMS completos, mas só para SMS.** Migration `supabase/migrations/20260922193000_create_sms_credit_billing.sql` com as tabelas:
  - `sms_credit_settings`, `tenant_sms_pricing`, `sms_credit_packages`
  - `tenant_sms_credit_balances` e `sms_credit_ledger`, um razão append-only com `idempotency_key`
  - `sms_credit_orders`
  - RPCs `apply_sms_credit_mutation` (com `FOR UPDATE` e idempotência), `reserve_sms_credits` e `refund_sms_credits`
- **Checkout de mentira.** `create_sms_credit_checkout` sempre grava `checkout_provider='manual'`. O pedido só vira pago por `admin_mark_sms_credit_order_paid`, que exige superadmin, então um webhook não tem como confirmar. O CHECK de `checkout_provider` aceita apenas `manual`, `stripe`, `mercadopago` e `asaas`.
- **Débito por SMS.** `reserveSmsCredit` e `refundSmsCredit` ficam em `src/lib/sms.functions.ts` (L609–690), com chamadas no envio individual (L837) e no envio em massa (`src/lib/sms-bulk.server.ts` L758). Hoje o débito é sempre de 1 crédito por envio.
- **Telas.**
  - `/creditos-sms` (`src/routes/creditos-sms.tsx`): mostra o saldo, os pacotes e o botão "Gerar pedido manual".
  - Abas "Preços" e "Créditos SMS" em `/admin`, e aba "Saldo SMS" em `/tenants`.
- **Bloqueio por status.** `src/lib/tenant-access.server.ts` tem `assertTenantCanSendExternally` e `assertTenantCanOpenBilling`, e `src/components/tenant-status-gate.tsx` mostra a tela de casa suspensa.
- **Infraestrutura pronta para copiar.**
  - Webhooks públicos em `src/routes/api/public/...`, com corpo bruto guardado (padrão `sms_callback_raw`).
  - Crons via pg_cron e pg_net com segredo no Vault, chamando `/api/public/hooks/...`.
  - Registro de execuções em `dispatcher_runs` e heartbeat no Better Stack.

**Não existe**
- **Assinatura:** não há fatura, ciclo nem status de cobrança. `tenants.plano` e `tenants.status` são rótulos editados à mão, e `tenants.limits` não é lido em lugar nenhum.
- **Cobrança de voz e e-mail:** não há saldo, reserva nem custo registrado.
  - A voz usa Infobip, e `call_history.duration_seconds` é preenchido pelo callback.
  - O e-mail usa Infobip e fica em `email_send_logs`.
- **Integração com gateway:** nenhuma, e não há variável de ambiente de pagamento.

**Preços divergentes no código** (o item PG1-04 elimina todos)

| Local | Valor fixo |
|---|---|
| `src/routes/sms.tsx` L2070 | 0,18 |
| `src/lib/journeys.functions.ts` L484 | 0,12 (SMS), 0,01 (e-mail), 0,35 (voz) |
| `src/lib/dashboard.functions.ts` L76 | 0,12 |
| `platform_pricing` | voz R$ 0,20 por minuto, e-mail 0,001 |

---

## 4. Como a Upper funciona e o que isso impõe ao desenho

| Fato da API | Consequência aqui |
|---|---|
| A API recebe **só Pix**, e cada cobrança é única (QR dinâmico) com validade de 60 s a 7 dias | **Não há débito automático.** A mensalidade é uma fatura mensal com um QR. Se o QR vencer, gera-se outro para a mesma fatura (uma fatura pode ter várias cobranças) |
| **Não há ambiente de testes**: toda chamada mexe na conta real | Testes automatizados usam um cliente simulado. O teste real é feito com cobranças de R$ 1,00 em uma casa interna. Há chaves de liga/desliga separadas para gerar cobranças e para bloquear envios |
| `externalId` com até 64 caracteres (`A-Z a-z 0-9 . _ : -`), único por conta e idempotente | O identificador é gerado por nós: `bl-inv-<uuid>-<n>` para fatura e `bl-top-<uuid>` para créditos. Em caso de timeout, repete-se a chamada com o **mesmo** `externalId` |
| A `description` é obrigatória (até 140 caracteres) e **aparece para quem paga** | Padrão `"<Nome da casa> - Plano BetLeads 11/2026"` ou `"<Nome da casa> - Créditos BetLeads R$ 1.000"`, sem CNPJ, e-mail ou dado sensível |
| O `metadata` volta igual nas consultas e no webhook | Envia-se `{ tenantId, kind, refId }`, mas a baixa se apoia no `externalId` gravado no nosso banco, não no metadata |
| Webhook assinado: `HMAC-SHA256(segredo, t + "." + corpoBruto)`; `t` com mais de 5 min deve ser recusado; pode haver entrega repetida; até 15 tentativas | Rota própria que lê o **corpo bruto**, compara em tempo constante, descarta duplicadas pelo `id` do evento e **confirma por GET** antes de creditar |
| "O webhook é um aviso" | Um cron de conciliação consulta as cobranças pendentes, cobrindo webhook perdido e a falta de ambiente de testes |
| Limite de 120 chamadas por minuto por chave | A conciliação roda em lotes de até 30 consultas a cada 5 min. A tela do cliente consulta o **nosso** banco, nunca a Upper |
| As funções nascem desligadas e precisam de KYC aprovado; o erro é `403 FEATURE_DISABLED` | Pré-requisito da PG0. O erro vira um alerta para o superadmin e, para a casa, a mensagem "pagamento indisponível, tente mais tarde" |
| Escopos `pix_in` e `pix_out` | A chave de produção recebe **apenas `pix_in`**. Não enviamos Pix; uma chave vazada não consegue tirar dinheiro |
| Valores em centavos inteiros ou texto `"150.00"` | Sempre `amountCents` como inteiro calculado no servidor; nunca um valor vindo do cliente |
| A resposta da cobrança paga traz `paidAmountCents` e `payer` | O valor pago é comparado com o valor cobrado. Se divergir, a cobrança vai para revisão manual e não credita. O `payer.document` é guardado mascarado (LGPD) |

---

## 5. Modelo de dados (proposta)

Todas as tabelas seguem o mesmo padrão de acesso:
- A casa só lê, via RLS `is_super_admin() OR tenant_id = ANY(accessible_tenant_ids())`.
- Toda escrita passa por RPC SECURITY DEFINER restrita a `service_role` ou superadmin.
- Os valores em R$ usam `numeric(14,4)`, porque o e-mail custa R$ 0,002. Os valores de cobrança Pix usam `bigint` em centavos.

**Preços e plano**
- **`billing_plans`**: `code` (PK), `name`, `price_cents`, `interval` (`month`), `included` jsonb, `exempt_all` (boolean), `is_active`. Duas linhas:
  - `crm_unico`: R$ 4.000,00 por mês, `included = {"email_free_monthly":100000}`, `exempt_all = false`.
  - `interno`: R$ 0,00, `exempt_all = true`. Sem fatura, sem suspensão e sem débito de saldo (D5).
- **`payment_fee_settings`**: taxa do Pix recebido, editada pelo superadmin.
  - Colunas: `provider` (`upper`), `fee_percent`, `fee_fixed_cents`, `valid_from`, `updated_by`.
  - Começa vazia, porque a taxa está em aberto (D11).
  - Cada cobrança paga grava a taxa calculada em `payment_charges.fee_cents` no momento do pagamento.
- **`billing_price_book`**: uma linha por item cobrável (`sms`, `voice_30s`, `email`), com:
  - `unit_price` (preço de venda)
  - `provider_unit_cost` (custo, para cálculo de margem)
  - `free_monthly_units` (100000 para e-mail)
  - `valid_from`
- **`tenant_price_overrides`**: exceção por casa e item, com `valid_from`.
- O RPC `billing_effective_price(tenant, item, at)` substitui `sms_effective_pricing`.

**Assinatura**
- **`tenant_billing`** (uma linha por casa):
  - `plan_code`
  - `billing_status`: `trialing`, `active`, `past_due`, `suspended`, `canceled` ou `exempt` (sempre `exempt` quando o plano é `interno`)
  - `exempt_reason`
  - `tenants.plano` passa a ser espelho de `tenant_billing.plan_code`, gravado pelo mesmo RPC, para não haver duas fontes
  - `cycle_anchor_day`, `current_period_start`, `current_period_end`
  - `grace_days`
  - dados de quem paga: `billing_contact_email`, `billing_legal_name`, `billing_document` (CNPJ)
  - `activated_at`, `suspended_at`
- **`billing_invoices`** (faturas): `tenant_id`, `plan_code`, `period_start`, `period_end`, `amount_cents`, `due_date`, `status` (`open`, `paid`, `void`), `paid_at`, `paid_charge_id`. Há UNIQUE em (`tenant_id`, `period_start`), então gerar a fatura duas vezes não duplica.

**Cobranças Pix (genéricas, independentes do provedor)**
- **`payment_charges`**:
  - identificação: `tenant_id`, `kind` (`invoice` ou `credit_topup`), `ref_id`, `provider` (`upper`)
  - chaves: `external_id` (UNIQUE), `provider_charge_id`
  - estado: `status` (espelho dos status da Upper: `PENDING`, `ACTIVE`, `PAID`, `EXPIRED`, `CANCELLED`, `FAILED`), mais a flag `needs_review`
  - valores: `amount_cents`, `paid_amount_cents`
  - QR: `emv`, `qr_code_image`, `payment_url`
  - datas e pagador: `expires_at`, `paid_at`, `payer_name`, `payer_document_masked`
  - taxa: `fee_cents`, calculada pela `payment_fee_settings` vigente no pagamento (nula enquanto a taxa não for cadastrada)
  - controle: `last_provider_payload`, `created_by`, `credited_at`
- **`payment_webhook_events`**: `event_id` (PK, `id` do evento da Upper), `event`, `delivery_id`, `signature_valid`, `raw_body`, `headers`, `received_at`, `processed_at`, `error`. Retenção de 90 dias, porque é dinheiro e precisa de auditoria.

**Saldo e consumo**
- **`credit_topup_orders`**: pedidos de compra de créditos, com `amount_cents`, `package_id` (opcional), `status` e `charge_id`. Substitui `sms_credit_orders`, que fica só como histórico.
- **`tenant_wallets`**: `balance` (CHECK >= 0), `reserved`, `lifetime_purchased`, `lifetime_used`.
- **`wallet_ledger`** (append-only):
  - `entry_type`: `purchase`, `manual_adjustment`, `usage_reservation`, `usage_settlement`, `usage_refund` ou `migration`
  - `channel`, `units`, `unit_price`, `amount`, `balance_after`
  - `reference_type`, `reference_id`, `idempotency_key` (UNIQUE com `tenant_id`)
- **`tenant_monthly_usage`**: (`tenant_id`, `month`, `item`) → `units`, `free_units_used` e `billed_amount`. É o contador da franquia de e-mail e a base do extrato mensal.

**RPCs centrais**
- `wallet_reserve(tenant, item, units, idem_key, ref)`:
  - se o plano da casa for `exempt_all`, não debita: grava o consumo com valor de R$ 0,00 e o custo do provedor, e responde `ok`
  - aplica a franquia (no e-mail, consome primeiro `free_units_used`)
  - calcula o valor pelo preço vigente
  - debita com `FOR UPDATE`
  - responde `insufficient_balance`, `plan_inactive` ou `ok`
- `wallet_reserve_batch(tenant, item, n, idem_key)`: reserva em lote para o envio em massa, evitando um `FOR UPDATE` por mensagem no mesmo registro de saldo.
- `wallet_settle(reservation_id, actual_units)` e `wallet_refund(reservation_id)`: ajustam a reserva ao consumo real, para voz e para falha no provedor.
- `billing_credit_paid_charge(charge_id)`: credita uma cobrança paga. Só pode ser chamada por `service_role`, é idempotente pela chave `charge:<id>` e decide pelo `kind` se marca a fatura paga e reativa a casa ou se credita o saldo.

---

## 6. Fluxos

**Compra de créditos**
1. O admin escolhe um pacote ou um valor e clica em "Gerar Pix".
2. O servidor cria o `credit_topup_orders` e o `payment_charges` (com `external_id`) e chama `POST /v1/pix/charges` com `expiresIn: 3600`.
3. A tela mostra o QR, o Copia e Cola com botão "Copiar" e o tempo restante, e consulta o **nosso** banco a cada 3 s.
4. Chega o webhook `charge.paid`. A rota confere a assinatura, grava o evento, faz `GET /v1/pix/charges/{externalId}` e confirma `status = PAID` e `paidAmountCents == amountCents`. Então chama `billing_credit_paid_charge`.
5. O saldo sobe, a tela vira "Pago" e o pedido aparece no extrato.

**Mensalidade**
1. Um cron diário gera a fatura 5 dias antes do vencimento (D3) e avisa o contato de cobrança e os admins.
2. Quando o admin clica em "Pagar", o sistema cria uma cobrança Pix válida até o fim da carência, com no máximo 7 dias. Se ela vencer, o próximo clique gera outra.
3. Ao ser paga, a fatura vira `paid`, o ciclo avança e o status volta a `active` se estava `past_due` ou `suspended`.
4. No vencimento sem pagamento, o status vira `past_due` e aparece um banner em todas as telas. Ao fim da carência, vira `suspended` e os envios param (D3).

**Consumo**

| Canal | Quando reserva | Como ajusta |
|---|---|---|
| SMS | Antes do envio: R$ 0,08 × segmentos calculados (D6) | Devolve se o provedor recusar. A confirmação de entrega não entra na conta, porque a Short Brasil não manda status (ver memória do DLR) |
| Voz | Antes da ligação: o teto em blocos, `ceil(duração_máx / 30)` | Quando o callback final chega com `duration_seconds`, acerta para `ceil(duração / 30)` blocos e devolve a diferença. Chamada não atendida devolve tudo (D7). Reserva sem callback é acertada pela conciliação da Infobip que já existe |
| E-mail | Antes do envio | Usa a franquia primeiro; depois cobra R$ 0,002. Devolve se o provedor recusar |
| Jornadas e campanhas | Sem saldo, o envio não sai | É marcado como `skipped: saldo_insuficiente`, sem nova tentativa infinita, e o admin recebe um alerta |

---

## 7. Fases e itens

### Fase PG0: pré-requisitos com a Upper e o produto (1 a 3 dias, sem código)

| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| PG0-01 | Conta BetLeads na Upper com KYC aprovado e a função "receber Pix (QR Code dinâmico)" liberada pelo parceiro | `GET /v1/balance` responde 200 com a chave nova | P |
| PG0-02 | Criar a chave de produção **só com `pix_in`**, guardá-la no `.env` da VPS (`UPPER_API_KEY`) e registrar quem a criou e onde está | A chave não aparece no repositório nem no bundle (busca no `.output` retorna 0) | P |
| PG0-03 | Respostas que faltam da D11 (teto diário de recebimento, estorno) anotadas neste documento | Seção 2 atualizada | P |
| PG0-05 | Perguntar à Infobip:<br>• se a chamada não atendida, ocupada ou caixa postal tem custo<br>• o custo por minuto de voz e por e-mail no nosso contrato (preenche `provider_unit_cost`) | Resposta por escrito anexada; D7 confirmada ou revista | P |
| PG0-04 | Respostas das decisões D1 a D14 | Seção 2 marcada como decidida | P |

### Fase PG1: preços e saldo único, ainda sem dinheiro real (cerca de 1,5 semana)

| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| PG1-01 | Migration de `billing_plans`, `billing_price_book` e `tenant_price_overrides` com os preços da seção 1, mais o RPC `billing_effective_price` | Teste PGlite: preço padrão, exceção por casa e vigência por data | M |
| PG1-02 | Migration de `tenant_wallets`, `wallet_ledger`, `tenant_monthly_usage` e dos RPCs `wallet_reserve`, `wallet_reserve_batch`, `wallet_settle`, `wallet_refund` e `admin_adjust_wallet` | Testes PGlite cobrindo: idempotência; 20 reservas concorrentes nunca deixam o saldo negativo; franquia de e-mail com 100.000 grátis e o seguinte cobrado; virada do mês civil; voz com 45 s = 2 blocos e 30 s = 1 bloco | G |
| PG1-03 | Verificação de saúde: a soma do razão bate com o saldo, para toda casa (no mesmo estilo de `check_crm_results_day`) | Teste que adultera o saldo e vê o alerta | P |
| PG1-04 | Tirar os preços fixos do código (0,18, 0,12, 0,35, 0,01 e `platform_pricing`). Dashboard, relatório de campanha, `crm_results_daily.cost`, estimativa do editor e jornadas passam a ler `billing_effective_price` | Busca pelos literais nas rotas e funções retorna 0. O custo de uma campanha conhecida bate com o razão | M |
| PG1-05 | Conversão dos créditos SMS: saldo convertido em R$ = créditos × R$ 0,08 (preço novo de SMS, decidido em 21/10: 1 crédito antigo = 1 SMS), como lançamento `migration` no razão. As casas da D5 vão para o plano `interno` e **não** têm o saldo de 99.999.999 SMS convertido. Esse saldo é encerrado com um lançamento de zeragem auditado, já que o plano `interno` não debita. O `sms_credit_*` fica somente leitura | Script em modo simulação lista casa, créditos, preço e R$. O superadmin aprova antes de rodar. Ao final, a soma confere | M |
| PG1-06 | Trocar `reserveSmsCredit` e `refundSmsCredit` (individual e em massa) por `wallet_reserve` e `wallet_refund`, com segmentos conforme a D6. O envio em massa usa `wallet_reserve_batch` | Os testes atuais de envio em massa continuam verdes com o simulador novo. Mensagem de erro: "Saldo insuficiente" | M |
| PG1-07 | Plano `interno` como marcação de isenção total:<br>• migration com a linha em `billing_plans`<br>• troca de plano só por superadmin, com motivo em `tenant_audit_logs`<br>• selo "Isenta" nas telas de `/tenants` e `/admin`<br>• aplicação em `pixpgf`, `pixreals`, `forrandobet` e no demo | Teste: casa `interno` envia SMS, voz e e-mail sem saldo, sem fatura e sem débito; o consumo aparece no relatório com venda de R$ 0,00 | P |

**Saída da PG1:** tudo é cobrado do saldo único com os preços novos, ainda abastecido por ajuste manual do superadmin, como hoje.

### Fase PG2: integração com a Upper (cerca de 1,5 semana)

| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| PG2-01 | Cliente `src/lib/upper-pix.server.ts`:<br>• `createCharge`, `getCharge`, `cancelCharge` e `getBalance`<br>• timeout de 10 s<br>• repetição com o mesmo `externalId`<br>• conversão dos erros `INVALID_API_KEY`, `FEATURE_DISABLED`, `RATE_LIMITED`, `VALIDATION` e 409 em erros tipados com mensagem em português<br>• limitador interno de 100 chamadas por minuto<br>• Sentry com a chave mascarada | Testes com `fetch` simulado para 201, idempotente, 401, 403, 409, 422, 502 e timeout | M |
| PG2-02 | Migration de `payment_charges` e `payment_webhook_events`, e do RPC `billing_credit_paid_charge` (service_role, idempotente) | PGlite: chamar duas vezes credita uma vez; `kind=invoice` marca a fatura; `kind=credit_topup` credita o saldo | M |
| PG2-03 | Rota `POST /api/public/upper/webhook`:<br>• lê o corpo bruto<br>• confere a assinatura com HMAC em tempo constante e `t` com até 300 s (`UPPER_WEBHOOK_SECRET`)<br>• grava o evento e descarta duplicado pelo `id`<br>• responde 200 rápido e processa: GET de confirmação, comparação de valor, crédito<br>• trata `charge.expired`, `charge.cancelled` e `ping` | Testes da rota: assinatura válida, inválida, antiga, repetida, valor divergente (`needs_review`) e evento de outra conta (externalId desconhecido é ignorado e registrado) | M |
| PG2-04 | Compra de créditos do lado do servidor: `createCreditTopup` (somente admin, D10; bloqueado no demo; valor validado contra os pacotes e o mínimo de R$ 100,00 da D9; bloqueado para casa `interno`) e `getChargeStatus` (lê do nosso banco) | Testes de permissão: gestor e operador recebem 403, o demo é bloqueado e R$ 99,99 é recusado e R$ 100,00 é aceito | M |
| PG2-05 | Cron `betleads-billing-reconcile` a cada 5 min:<br>• consulta cobranças `PENDING` e `ACTIVE` com mais de 2 min, em lotes de 30<br>• marca como `EXPIRED` as vencidas<br>• credita as pagas que o webhook não avisou<br>• registra em `dispatcher_runs` e envia heartbeat ao Better Stack | Teste simulando webhook perdido: a cobrança é creditada pela conciliação em até 5 min | M |
| PG2-06 | Chaves de liga/desliga `BILLING_GATEWAY_ENABLED` (gera cobranças) e `BILLING_ENFORCEMENT_ENABLED` (bloqueia envios), mais as variáveis `UPPER_API_BASE`, `UPPER_API_KEY` e `UPPER_WEBHOOK_SECRET` em `.env.example` e em `docs/docker-deployment.md` | Com o gateway desligado, o botão "Gerar Pix" aparece desabilitado com aviso | P |
| PG2-07 | **Teste real em produção:** casa interna; cobrança de R$ 1,00 paga por Pix; webhook recebido; saldo creditado; cobrança expirada (`expiresIn: 60`) e cobrança cancelada | Evidência no PR com os ids das cobranças, os eventos gravados e o razão | P |

### Fase PG3: consumo dos três canais (cerca de 1 semana)

| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| PG3-01 | Uma única checagem antes de qualquer envio externo: `assertTenantCanSendExternally` passa a exigir `billing_status` em `active`, `trialing`, `exempt` ou `past_due` dentro da carência (só quando `BILLING_ENFORCEMENT_ENABLED`) | Teste para cada status | P |
| PG3-02 | SMS: função única `countSmsSegments(texto)` (GSM-7 160/153, UCS-2 70/67).<br>• Usada no editor, no envio individual, no envio em massa e nas jornadas.<br>• Conta o texto final, depois de trocar as variáveis e encurtar o link.<br>• O editor mostra "N segmentos × R$ 0,08 = R$ X por jogador" e o total da campanha. | Testes:<br>• 160 caracteres GSM = 1 segmento; 161 = 2<br>• 70 caracteres com acento = 1; 71 = 2<br>• emoji força UCS-2<br>• o valor reservado é igual ao exibido | M |
| PG3-03 | Voz: reserva do teto antes da chamada (`calls.server.ts`, `calls.functions.ts`, `call-flows.server.ts`) e acerto no callback final (`infobip/voice/events.ts`) e na conciliação. Grava `billed_blocks` e `billed_amount` em `call_history` | Teste: chamada de 61 s = 3 blocos = R$ 0,27; não atendida = R$ 0 (regra configurável, conforme a PG0-05); callback repetido não cobra duas vezes | M |
| PG3-04 | E-mail: reserva com franquia em `email-send.server.ts` e devolução na recusa do provedor. Grava `billed_amount` (0 quando entra na franquia) em `email_send_logs` | Teste nos limites de 99.999, 100.000 e 100.001 | M |
| PG3-05 | Jornadas e campanhas: tratar `insufficient_balance` e `plan_inactive` como pulo com motivo, sem nova tentativa, e com no máximo um alerta por casa por hora | Teste do dispatcher: casa sem saldo não fica tentando de novo | M |
| PG3-06 | Aviso de saldo baixo: limite configurável por casa (padrão R$ 200), banner no app e e-mail para os admins | Teste do limite | P |

### Fase PG4: plano mensal, faturas e inadimplência (cerca de 1,5 semana)

| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| PG4-01 | Migration de `tenant_billing` e `billing_invoices`. Carga inicial: toda casa recebe uma linha; o demo e as casas da D5 com o status decidido; as demais em `trialing` até a data de corte da D14 | Lista conferida pelo superadmin antes de aplicar | M |
| PG4-02 | Cron diário `betleads-billing-invoices`: gera a fatura de cada casa cujo vencimento é daqui a 5 dias (idempotente pelo período) | Rodar duas vezes no mesmo dia gera 1 fatura. Teste da virada de mês (dia 31 → 30 ou 28) | M |
| PG4-03 | Pagar fatura: `payInvoice` (admin) cria ou reaproveita uma cobrança `ACTIVE` ainda válida, senão cria outra (`bl-inv-<id>-<n>`). O pagamento avança o ciclo e reativa a casa | Teste: QR vencido → novo QR → pago → `active` | M |
| PG4-04 | Cron diário `betleads-billing-dunning`: `active` → `past_due` no vencimento e `past_due` → `suspended` ao fim da carência. Grava em `tenant_audit_logs`. Só bloqueia quando `BILLING_ENFORCEMENT_ENABLED`. Ignora as casas `interno`. A suspensão **não mexe no saldo** | Teste com relógio simulado do dia D-5 até D+4; o saldo antes da suspensão é igual ao saldo depois do pagamento | M |
| PG4-05 | Tela de suspensão: `tenant-status-gate` passa a deixar a página de pagamento aberta para casa suspensa e mostra "Fatura vencida em dd/mm" com botão "Pagar agora" | A casa suspensa consegue pagar e volta a enviar sem ação do superadmin | P |
| PG4-06 | Avisos ao contato de cobrança e aos admins: fatura gerada, 1 dia antes, vencida, suspensa e paga (e-mail de plataforma mais notificação no app) | Cada aviso sai uma vez por fatura | M |

### Fase PG5: telas (cerca de 1,5 semana; pode começar junto da PG2)

| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| PG5-01 | Página da casa **"Plano e créditos"** (`/financeiro`, substitui `/creditos-sms` com redirecionamento), dividida em cinco blocos:<br>**Plano** — status, próximo vencimento e botão "Pagar".<br>**Saldo** — saldo atual e botão "Comprar créditos" (pacotes e valor livre).<br>**Consumo do mês** — por canal, com barra da franquia de e-mail (ex.: 42.310 de 100.000).<br>**Extrato** — razão com filtro por canal e período, exportável em CSV.<br>**Faturas** — histórico e tabela de preços vigentes.<br>Modal de Pix: QR, Copia e Cola, tempo restante e confirmação ao vivo. Layout desktop e mobile, tema escuro (decisões do redesign). Entrada em `ACCOUNT_LINKS` e no rodapé da barra lateral | Teste de usabilidade com um admin real: comprar créditos sem ajuda em até 1 minuto | G |
| PG5-02 | Aba **"Faturamento"** no `/admin`:<br>• receita mensal recorrente, faturas em aberto, vencidas e pagas, e recebido no mês<br>• casas por status e cobranças com `needs_review`<br>• ações: isentar, conceder dias, ajuste de saldo com motivo, baixa manual de fatura com comprovante e motivo (plano B se a Upper cair), reprocessar evento do webhook<br>• edição da tabela de preços e das exceções<br>• cadastro da taxa do Pix da Upper (percentual e/ou fixo, com vigência), com o aviso "taxa não cadastrada" enquanto estiver vazia<br>As abas "Preços" e "Créditos SMS" deixam de existir | Toda ação grava em `tenant_audit_logs` com o motivo | G |
| PG5-03 | Relatório mensal para a nota fiscal e a contabilidade: por casa, mostra plano pago, créditos comprados, consumo por canal, taxa do Pix (quando cadastrada), receita líquida, custo do provedor e margem. As casas `interno` aparecem à parte, com venda de R$ 0,00. Exporta CSV | Os totais batem com `payment_charges` pagas e com o razão | M |
| PG5-04 | Aba "Saldo" em `/tenants` lendo o saldo único e o status do plano | — | P |

### Fase PG6: virada e acompanhamento (1 semana corrida)

| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| PG6-01 | Comunicado às casas com os preços novos, a data de corte, como pagar e o que acontece no atraso | Texto aprovado e enviado | P |
| PG6-02 | Ligar `BILLING_GATEWAY_ENABLED` em produção, com a primeira fatura e o bloqueio ainda desligado (D14) | 100% das faturas do primeiro ciclo geradas; pagamentos creditados sem intervenção | P |
| PG6-03 | Painel e alertas:<br>• webhook com assinatura inválida acima de 0<br>• cobrança paga e não creditada há mais de 10 min<br>• diferença entre razão e saldo<br>• `FEATURE_DISABLED` ou `401` da Upper<br>• cron de conciliação parado | Alertas no Better Stack ou Sentry testados uma vez | M |
| PG6-04 | Ligar `BILLING_ENFORCEMENT_ENABLED` na data da D14 | Casa de teste com fatura vencida é suspensa e reativada pelo pagamento | P |
| PG6-05 | Runbook em `docs/operacoes/`:<br>• chave da Upper vazada (revogar, criar outra, trocar o `.env`)<br>• Upper fora do ar (baixa manual)<br>• pagamento com valor divergente<br>• casa pagou e não liberou | Revisado por quem opera | P |

---

## 8. Segurança e conformidade

- **Chave e segredo**
  - A chave da Upper e o segredo do webhook ficam só no `.env` do servidor.
  - A chave só tem `pix_in`.
  - Nunca há `VITE_` nesses nomes, nem log com esses valores.
- **Valores calculados no servidor.** O valor cobrado sempre sai da tabela de preços ou do pacote. O cliente envia só `packageId` ou um valor livre, que é validado.
- **Confirmação dupla.** O webhook com assinatura válida dispara uma consulta GET. O crédito só acontece com `PAID` e valor igual.
- **Idempotência em três níveis.**
  - `externalId` na Upper.
  - `event_id` no webhook.
  - `idempotency_key` no razão.
- **RLS.** A casa só lê as tabelas de cobrança. Nenhuma tabela de dinheiro aceita INSERT ou UPDATE de `authenticated`. O teste da matriz de RLS em `supabase/tests/rls/` ganha as tabelas novas.
- **LGPD.**
  - O documento do pagador é guardado mascarado (`***.456.789-**`).
  - A `description` não leva CNPJ nem e-mail.
  - O corpo bruto do webhook fica guardado 90 dias.
- **Demo.** O tenant demo nunca chama a Upper, com bloqueio no servidor por `assertTenantNotDemo`.
- **Auditoria.** Isenção, ajuste, baixa manual, troca de preço e mudança de status gravam quem fez, quando e por quê.

---

## 9. Plano de testes

| Camada | O que cobre |
|---|---|
| Unidade | Assinatura HMAC (válida, inválida, `t` antigo, header malformado), conversão de valores, montagem de `externalId` e `description` (limites de 64 e 140 caracteres), cálculo de blocos de voz e de segmentos de SMS |
| Banco (PGlite, `*.db.test.ts`) | Reservas concorrentes, idempotência, franquia de e-mail, virada de mês, crédito de cobrança paga, geração de fatura idempotente, transições de status da assinatura |
| Rotas | Webhook (todos os eventos e casos de erro), permissões das funções de servidor (admin, gestor, operador, demo, superadmin) |
| Cliente Upper | `fetch` simulado para todas as respostas da seção 9 da documentação da Upper |
| Produção (PG2-07 e PG6-04) | Cobrança de R$ 1,00 paga, expirada e cancelada; casa de teste suspensa e reativada |

---

## 10. Sequência e esforço

```
PG0 ──► PG1 ──► PG2 ──► PG3 ──► PG4 ──► PG6
                  └──── PG5 (telas, a partir da PG2-04) ───┘
```

| Fase | Esforço | Entrega de valor |
|---|---|---|
| PG0 | 1 a 3 dias corridos | — |
| PG1 | ~1,5 semana | Preços novos e saldo único |
| PG2 | ~1,5 semana | **Dinheiro entra sozinho (créditos)** |
| PG3 | ~1 semana | Voz e e-mail cobrados |
| PG4 | ~1,5 semana | **Mensalidade automática** |
| PG5 | ~1,5 semana (em paralelo) | Telas finais |
| PG6 | 1 semana corrida | Virada |

Total: **cerca de 6 a 7 semanas** para uma pessoa, ou 4 a 5 semanas com as telas em paralelo.

**Corte mínimo viável (cerca de 3 semanas):** PG0, PG1, PG2 e a parte de créditos da PG5-01. Com isso a casa já compra créditos por Pix e o SMS cobra R$ 0,08. Voz, e-mail e mensalidade automática entram depois, e a mensalidade segue cobrada à mão até a PG4.

---

## 11. Definição de "pronto"

1. Uma casa paga a mensalidade e compra créditos por Pix sem falar com ninguém, e o sistema libera em menos de 30 s (webhook) ou em até 5 min (conciliação).
2. SMS, voz e e-mail descontam do saldo pela tabela de preços, e o extrato da casa explica cada centavo.
3. A franquia de 100.000 e-mails funciona e zera todo mês. O SMS cobra por segmento, e o valor mostrado no editor é o valor debitado.
4. Créditos nunca expiram nem somem com a suspensão. Casas no plano `interno` não pagam nada e aparecem no relatório.
5. Uma casa inadimplente é suspensa sozinha depois da carência e volta sozinha ao pagar.
6. O razão bate com o saldo e com as cobranças pagas na Upper, conferido todo dia por um alerta.
7. Nenhum preço fixo sobra no código.

## 12. Fora desta entrega (backlog)

- Emissão automática de NFS-e (D12).
- Boleto ou cartão (a API da Upper só faz Pix).
- Estorno automático.
- Vários planos ou cobrança por volume de jogadores.
- Cupons e bônus de recarga.
- Recarga automática quando o saldo baixar (precisaria de cartão ou de Pix Automático).
- Uso do `pix_out` para qualquer finalidade.
