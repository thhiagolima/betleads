# Runbook — Incidentes de cobrança (Pix Upper, mensalidade e créditos) (PG6-05)

**Escopo:** `docs/ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md` (PG6-05 e §8)
**Specs:** `docs/superpowers/specs/2026-10-22-pagamento-plano-creditos-design.md`,
`docs/superpowers/specs/2026-10-23-pg3-consumo-design.md`
**Roteiros relacionados:** `RUNBOOK_ATIVAR_PIX_UPPER.md`, `RUNBOOK_ATIVAR_MENSALIDADE.md`,
`RUNBOOK_DEPLOY_PG3_CONSUMO.md`, `docs/RUNBOOK_OBSERVABILIDADE.md` (heartbeats e
códigos de alerta da saúde da cobrança)

Este documento é um roteiro para quando algo dá errado com dinheiro já em
produção. Cada incidente tem: como se percebe, como diagnosticar (só leitura),
como corrigir, o que **não** fazer e um campo **Resultado:** em branco para o
operador preencher na hora.

**Regras que valem para todo o documento**

- Toda escrita (SQL que muda dado, ação no console, troca de `.env`, restart)
  está marcada **(escrita — requer autorização)**. Peça autorização explícita do
  usuário a cada uma, mesmo no meio de um incidente.
- **Nunca cole chave, segredo, token ou `.env` em ticket, chat, e-mail,
  print ou neste documento.** Isso vale para `UPPER_API_KEY`,
  `UPPER_WEBHOOK_SECRET`, `CRON_SECRET` e a chave `service_role` do Supabase.
  Confirme presença com `!!process.env.X`, nunca com o valor.
- **Nunca apague linhas de dinheiro:** `payment_charges`, `credit_topup_orders`,
  `payment_webhook_events`, `billing_invoices`, `tenant_billing`,
  `tenant_wallets`, `wallet_ledger`, `billing_email_log`, `tenant_audit_logs`.
  Correção é sempre um lançamento novo ou uma ação auditada, nunca `delete`.
- **Nunca edite `tenant_wallets.balance` nem `wallet_ledger` à mão.** Saldo só
  muda por `wallet_mutation` (Pix creditado, "Ajustar saldo", consumo).
- Comprovante e nota da baixa manual ficam gravados em `billing_invoices` e no
  `metadata` de `tenant_audit_logs`: use o identificador do Pix (endToEndId) ou
  a referência bancária, **nunca CPF/CNPJ completo** (LGPD).

**Acesso ao banco:** pooler de sessão (`aws-0-ca-central-1.pooler.supabase.com:5432`,
usuário `postgres.<VITE_SUPABASE_PROJECT_ID>`), via `pg` (npm) a partir de um
diretório de scratch (ver memória `db-access-pooler`). Para diagnóstico, execute
`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` logo depois de
conectar. Escritas, numa conexão separada, sempre dentro de `begin; … commit;`
(se der erro, mande `rollback;` antes de tentar de novo).

**O que dá e o que não dá para fazer pelo pooler**

- As ações `billing_admin_*` (baixa manual, cancelar fatura, estender prazo,
  dias grátis, bloquear…) e `admin_adjust_wallet` ("Ajustar saldo") checam
  `is_super_admin()`, que lê `auth.uid()`. Pelo pooler isso é nulo e a chamada
  falha com `forbidden`. **Faça essas ações pelo console** (`/admin` → aba
  "Faturamento" ou aba "Saldo"), logado como superadmin. O console também grava
  a auditoria em `tenant_audit_logs`, o que o SQL direto não faz.
- `billing_credit_paid_charge` e `billing_refresh_access_state` são do
  `service_role`. Pelo pooler, rode antes, na mesma transação,
  `select set_config('request.jwt.claims', '{"role":"service_role"}', true);`.
  O mesmo vale se `billing_wallet_integrity()` ou `billing_health_snapshot()`
  responderem `forbidden` numa leitura.

**Consultas de apoio usadas em várias seções (só leitura)**

Achar a casa:
```sql
select id, slug, nome, plano, status, is_demo
from public.tenants
where slug = '<slug>';
```

Últimas cobranças Pix da casa:
```sql
select id, kind, ref_id, external_id, status, needs_review,
       amount_cents, paid_amount_cents, paid_at, credited_at,
       expires_at, last_error, created_at, updated_at
from public.payment_charges
where tenant_id = '<tenant_id>'
order by created_at desc
limit 10;
```

Ações de cobrança já feitas na casa (quem, quando, por quê):
```sql
select created_at, action, actor_user_id, metadata
from public.tenant_audit_logs
where tenant_id = '<tenant_id>'
  and (action like 'billing.%' or action = 'tenant_wallet.adjusted')
order by created_at desc
limit 20;
```

---

## 1. Chave da Upper vazada

### Como se percebe

- Alguém viu a chave onde não devia: colada em chat, ticket, print, commit,
  log, máquina perdida, ex-colaborador com acesso ao `.env`.
- A Upper avisa de uso estranho, ou o painel da Upper mostra cobranças ou
  cancelamentos que não fizemos.
- Alerta `upper_unauthorized` sem ninguém ter mexido na chave (alguém revogou
  ou trocou a chave pelo painel).

**O que uma chave `pix_in` vazada permite:** criar cobranças na nossa conta (o
dinheiro cairia para nós), **ler cobranças e dados do pagador** (nome e
documento; questão de LGPD), **cancelar cobranças abertas** das casas e gastar
o limite de 120 chamadas/min da conta, o que derruba a geração de Pix das casas.
Ela **não** tira dinheiro da conta, porque não tem `pix_out`. Se a chave vazada
tiver `pix_out`, trate como incidente financeiro grave e acione a Upper na hora.

### Diagnóstico (só leitura)

1. Na Upper, confirme o escopo da chave vazada (`pix_in` só, ou mais) e a
   janela de exposição (desde quando ela pode ter sido vista).
2. Cobranças abertas e pagas ainda não creditadas agora. São as que vão ficar
   esperando enquanto a chave é trocada:
   ```sql
   select id, tenant_id, kind, external_id, status, amount_cents, paid_at, expires_at
   from public.payment_charges
   where credited_at is null
     and status in ('PENDING', 'ACTIVE', 'PAID')
   order by created_at;
   ```
3. Cobranças canceladas na janela de exposição. Cancelamento legítimo nosso
   sai de uma ação do superadmin (desconto, cancelar fatura, baixa manual,
   congelar) e aparece na auditoria com `pixCancel`:
   ```sql
   select id, tenant_id, kind, external_id, status, updated_at
   from public.payment_charges
   where status = 'CANCELLED'
     and updated_at >= '<início da janela de exposição>'
   order by updated_at;
   ```
   Uma cobrança `CANCELLED` sem ação correspondente em `tenant_audit_logs` no
   mesmo horário foi cancelada por fora.
4. No painel da Upper, procure cobranças com `externalId` que não começa com
   `bl-inv-` ou `bl-top-`, ou que não existe em `payment_charges`. Foram criadas
   com a chave vazada.

### Correção

1. **Revogar a chave no painel da Upper** (escrita — requer autorização). A
   partir daqui, toda chamada nossa à Upper responde `401` até o passo 4. Se
   der para criar a chave nova e trocar o `.env` em poucos minutos, pode-se
   criar a nova antes e revogar a velha logo em seguida, para encurtar a janela
   sem Pix. Na dúvida, revogue primeiro: nenhum dinheiro se perde, só atrasa.
2. **Criar uma chave nova só com `pix_in`** no painel da Upper (escrita —
   requer autorização). Nunca marque outros escopos.
3. **Trocar `UPPER_API_KEY` no `.env` da VPS** (escrita — requer autorização).
   Edite o arquivo direto na VPS (mesmo `.env` de `docs/docker-deployment.md`).
   Não copie a chave por chat nem por ticket, e não a cole no terminal com
   `echo`, porque fica no histórico do shell.
4. **Recriar o container** (escrita — requer autorização). As variáveis só são
   lidas na inicialização, então `restart` não basta:
   ```bash
   docker compose up -d --force-recreate crm
   docker compose ps
   docker compose exec crm node -e "console.log(!!process.env.UPPER_API_KEY, !!process.env.UPPER_WEBHOOK_SECRET, process.env.BILLING_GATEWAY_ENABLED)"
   ```
   **Esperado:** container `healthy` e `true true true`.
5. **Conferir a volta.** Em até 10 min (duas execuções da conciliação):
   ```sql
   select id, status, started_at, finished_at, claimed, sent, errors
   from public.dispatcher_runs
   where job = 'billing-reconcile'
   order by started_at desc
   limit 3;
   ```
   **Esperado:** `status = 'succeeded'` e `errors = 0`. Em Admin → Faturamento →
   "Saúde da cobrança", o `upper_unauthorized` deixa de receber eventos novos.
   Ele some do painel quando sair da janela de 24 h.

**O que acontece com as cobranças abertas.** O QR de uma cobrança já emitida
pertence à conta Upper, não à chave. A casa continua conseguindo pagar durante
a troca. Confirme isso com a Upper no primeiro incidente real e anote no
Resultado. Enquanto a chave nova não está no ar:

- **Pix pago nesse meio-tempo:** a Upper manda o webhook. A confirmação por GET
  falha com `401`, a rota responde `503` e a Upper reentrega (até 15 vezes). A
  conciliação também falha. Nada é creditado ainda, mas nada se perde.
- **Depois da chave nova:** a conciliação reconsulta toda cobrança
  `PENDING`/`ACTIVE`, de qualquer idade, e as `EXPIRED`/`FAILED`/`CANCELLED`
  não creditadas criadas nas últimas 48 h. O que foi pago entra sozinho em até
  5 a 10 min. Confira com a consulta do passo 2 do diagnóstico.
- **Pix que a casa tentou gerar durante a janela:** falhou na hora com "Não foi
  possível gerar o Pix agora. Tente de novo em instantes." e ficou `FAILED` com
  `last_error` terminando em `(401)`. A casa só precisa gerar de novo.
- **Cobrança cancelada por fora (passo 3 do diagnóstico):** a casa precisa
  gerar outro Pix. Se ela já tiver pago antes do cancelamento, a conciliação
  credita: dinheiro recebido sempre vence o cancelamento.

**O segredo do webhook também precisa ser trocado?** A chave de API e
`UPPER_WEBHOOK_SECRET` são independentes. O segredo é um valor que nós geramos
e cadastramos no painel da Upper (API → Webhook). Trocar a chave não troca o
segredo. **Troque também o segredo** se a origem do vazamento pode tê-lo
exposto (`.env`, acesso à VPS, repositório, logs, print do painel da Upper) ou
se a origem é desconhecida. Se só a chave apareceu num lugar isolado, como uma
mensagem com a chave e mais nada, não é preciso. Um segredo vazado sozinho não
gera crédito falso, porque todo webhook é confirmado por GET na Upper antes de
creditar. Mas ele permite inundar a rota de webhook.

Como trocar o segredo (escrita — requer autorização em cada passo):

1. Gere um valor novo, forte e aleatório, **direto na VPS** (por exemplo
   `openssl rand -hex 32`, escrevendo no `.env` sem imprimir na tela).
2. Atualize `UPPER_WEBHOOK_SECRET` no `.env` e recrie o container (comando do
   passo 4).
3. No painel da Upper (API → Webhook), troque o segredo pelo mesmo valor e use
   o botão **"Testar"**.
4. Confira o `ping`:
   ```sql
   select event_id, event, outcome, received_at, processed_at
   from public.payment_webhook_events
   order by received_at desc
   limit 3;
   ```
   **Esperado:** linha nova com `outcome = 'ping'` e `processed_at` preenchido.

Entre os passos 2 e 3, os webhooks são recusados com `400`. Isso dispara
`webhook_invalid_signature`, o que é esperado nessa janela. A conciliação de 5
em 5 min cobre os pagamentos, e a Upper reentrega. Faça os dois passos em
seguida.

**Se o `.env` inteiro vazou**, o incidente é maior que este roteiro. Troque
também `CRON_SECRET` (no `.env` e no Vault, `betleads_cron_secret`, nos dois
lados juntos), a chave `service_role` do Supabase e as demais credenciais do
arquivo.

**LGPD:** com `pix_in`, a chave permite ler nome e documento de quem pagou.
Registre a janela de exposição e leve ao responsável para avaliar a
comunicação.

### O que NÃO fazer

- Não cole a chave nova nem a velha em ticket, chat, e-mail ou print. Não a
  imprima com `echo` nem com `console.log(process.env.UPPER_API_KEY)`.
- Não crie a chave nova com `pix_out` nem com "todos os escopos".
- Não desligue o cron de conciliação nem remova o webhook "por segurança": é
  isso que credita os pagamentos feitos durante a troca.
- Não ligue `BILLING_GATEWAY_ENABLED=false` achando que isso protege a chave.
  Só esconde a compra de créditos. A chave continua válida até ser revogada.
- Não marque como pagas, à mão, cobranças que a casa diz ter pago durante a
  troca. Espere a conciliação com a chave nova.

**Resultado (janela de exposição, escopo da chave vazada, hora da revogação,
hora da chave nova no ar, segredo do webhook trocado sim/não, QR antigo
continuou pagável sim/não):** _______________________________________________

---

## 2. Upper fora do ar

### Como se percebe

- Alerta **`upper_unavailable`** (crítico, de evento): 3 ou mais falhas da
  Upper (tempo esgotado, erro de rede ou resposta 5xx) na última hora, contadas
  pelo cliente da Upper em `billing_monitor_signals`. Vai para o Sentry ou para
  o log `[billing-alert]`, mas não segura o heartbeat `billing-health`. Uma ou
  duas falhas isoladas não alertam.

  **Atenção:** uma única cobrança cujo GET na Upper responde 500 sempre (um
  registro quebrado do lado deles) também mantém `upper_unavailable` ligado,
  porque a conciliação a consulta a cada 5 min. Para separar os casos, veja se
  as falhas vêm de **muitas cobranças ou chamadas diferentes** (queda real) ou
  sempre do **mesmo `externalId`** (problema de uma cobrança só): nos logs,
  `[billing-reconcile] error reconciling charge` traz o `externalId` de cada
  falha; e o passo 2 do diagnóstico abaixo mostra se cobranças novas também
  estão falhando. Uma cobrança só: abra chamado na Upper com o `externalId`;
  não é queda e não precisa avisar as casas.

Outros sinais:

- Casas relatam "Não foi possível gerar o Pix agora. Tente de novo em
  instantes." ao pagar a mensalidade ou comprar créditos.
- `dispatcher_runs` do `billing-reconcile` com `status = 'partial'` e
  `errors > 0` em execuções seguidas. Nos logs do container:
  `[billing-reconcile] error reconciling charge`, com `code` `TIMEOUT`,
  `NETWORK_ERROR` ou status 5xx.
- Cobranças novas nascendo `FAILED`, com `last_error` como `TIMEOUT (0)`,
  `NETWORK_ERROR (0)` ou `… (5xx)`.
- `upper_feature_disabled` indica outra coisa: a Upper desligou o Pix da conta
  (KYC/conta), não uma queda. Nesse caso a compra de créditos mostra "Compra
  por Pix indisponível no momento." O tratamento para a casa é o mesmo; a
  conversa com a Upper é outra.

### Diagnóstico (só leitura)

1. Confirme com a Upper (status, suporte) que a queda é deles e peça uma
   previsão. Anote no Resultado.
2. Falhas recentes:
   ```sql
   select id, tenant_id, kind, external_id, status, last_error, created_at
   from public.payment_charges
   where status = 'FAILED'
     and created_at > now() - interval '6 hours'
   order by created_at desc;

   select status, started_at, claimed, sent, errors
   from public.dispatcher_runs
   where job = 'billing-reconcile'
   order by started_at desc
   limit 6;
   ```
3. Casas que podem ser bloqueadas durante a queda (fatura aberta perto ou
   depois do vencimento):
   ```sql
   select t.slug, tb.access_state, i.id as invoice_id, i.due_date, i.amount_cents,
          i.upfront, i.due_date + 3 as ultimo_dia_carencia
   from public.tenant_billing tb
   join public.tenants t on t.id = tb.tenant_id
   join public.billing_invoices i on i.tenant_id = tb.tenant_id and i.status = 'open'
   where tb.access_state in ('due_soon', 'overdue', 'locked_unpaid', 'awaiting_first_payment')
   order by i.due_date;
   ```
   Lembrete da regra (`billing_invoice_phase`): faixa amarela de `due_date − 5`
   até a véspera; vermelha de `due_date` até `due_date + 3`; `locked_unpaid` a
   partir de `due_date + 4`. O estado é recalculado pelo job da hora (minuto
   7). Só bloqueia de fato com `BILLING_ENFORCEMENT_ENABLED=true`.
4. Pix ainda aberto da fatura de cada casa afetada (vai importar na baixa
   manual):
   ```sql
   select id, external_id, status, amount_cents, expires_at
   from public.payment_charges
   where kind = 'invoice' and ref_id = '<invoice_id>'
     and status in ('PENDING', 'ACTIVE');
   ```

### Correção

**a) Evitar bloquear casa por causa da queda.** Escolha pela duração prevista:

- **Queda curta, poucas casas perto do bloqueio:** console → `/admin` → aba
  "Faturamento" → casa → **"Estender prazo"** (escrita — requer autorização).
  Isso soma 1 a 31 dias ao `due_date` **só desta fatura**. A faixa e o
  bloqueio seguem a data nova, e o ciclo seguinte não muda. Use o tempo da
  queda mais 1 ou 2 dias de folga. Motivo, por exemplo: "Upper fora do ar em
  DD/MM, prazo estendido". Uma casa já em `locked_unpaid` é liberada na hora se
  a nova data a tirar da carência vencida.
- **Queda longa ou muitas casas:** desligar o bloqueio globalmente,
  `BILLING_ENFORCEMENT_ENABLED=false` no `.env` da VPS e
  `docker compose up -d --force-recreate crm` (escrita — requer autorização).
  Faturas e e-mails continuam; ninguém é bloqueado por falta de pagamento
  (`frozen` e `locked_manual` continuam bloqueando). Religue quando a Upper
  voltar e as casas tiverem tido tempo de pagar.
- **"Dar dias grátis" não é ferramenta de queda.** Ele empurra o ciclo inteiro
  e dá dias sem cobrar, o que é uma concessão comercial. Só use se o
  responsável decidir compensar as casas.
- **Casa em `awaiting_first_payment`** (fatura de ativação, `upfront`):
  estender o prazo **não libera**, porque a fatura de ativação bloqueia
  enquanto estiver aberta, qualquer que seja a data. Ou ela espera a Upper
  voltar, ou paga por fora (item b).

**b) A casa precisa pagar agora: recebimento manual fora do sistema.**

1. A casa paga pelo canal financeiro oficial da BetLeads, fora do sistema (não
   pelo QR do CRM). Confirme o crédito na conta antes de qualquer baixa.
2. Console → `/admin` → aba "Faturamento" → casa → **"Dar baixa manual"**
   (escrita — requer autorização):
   - **Valor recebido:** o valor que de fato entrou. Vazio usa o valor da
     fatura.
   - **Data do pagamento:** o dia em que o dinheiro entrou, não o dia da baixa.
     Não pode ser anterior à emissão da fatura (`invalid_paid_at`) nem futura.
     Ela importa: se a casa pagou enquanto estava bloqueada, o próximo
     vencimento é contado a partir dessa data.
   - **Nota:** por exemplo "Upper fora do ar, Pix recebido por fora".
   - **Comprovante:** endToEndId do Pix ou referência bancária. Nunca CPF/CNPJ
     completo.
   - **Motivo:** obrigatório, com 5 ou mais caracteres.
3. **Efeito:** a fatura fica `paid` com `paid_via = 'manual'`, o ciclo anda, o
   `access_state` é recalculado e o e-mail "Pagamento confirmado" sai. A casa
   desbloqueia em segundos. Para quem já está com a tela aberta, pode levar até
   1 min; recarregar a página resolve.

**c) O Pix que ficou aberto.** Antes de dar a baixa, o console tenta cancelar
na Upper o Pix aberto da fatura. **Com a Upper fora do ar, esse cancelamento
falha:** a falha fica em `metadata.pixCancel` da auditoria
(`billing.manual_settle`, `ok = false`) e a baixa segue assim mesmo. A
cobrança continua `ACTIVE` no nosso banco e **o QR antigo pode continuar
pagável** até `expires_at` (Pix de fatura vale até 23:59 de `due_date + 3`,
com mínimo de 1 h e máximo de 7 dias).

- **Avise a casa por escrito para não pagar o QR antigo.**
- Quando a Upper voltar, confira a cobrança (consulta 4 do diagnóstico). Se
  ainda estiver `ACTIVE`, deixe vencer: a conciliação a marca `EXPIRED` cerca
  de 10 min depois de `expires_at`. Não há botão para cancelar só uma cobrança
  de fatura já paga.
- Se a casa pagar o QR antigo mesmo assim, o pagamento vai para revisão
  (`needs_review`, motivo `invoice_not_open`). Trate pela seção 3, caso B2
  (devolver ou virar créditos).

**d) Créditos durante a queda.** A casa também não consegue comprar créditos.
Se ela ficar sem saldo e precisar enviar, receba por fora e credite em
`/admin` → aba "Saldo" → **"Ajustar saldo"** (escrita — requer autorização),
com motivo citando a referência do pagamento. Antes, confira que não houve
ajuste igual (consulta de auditoria no topo, `tenant_wallet.adjusted`).

**e) Quando a Upper voltar.** Confira `dispatcher_runs` (`errors = 0`), peça
às casas que falharam para gerar o Pix de novo e, se desligou, religue
`BILLING_ENFORCEMENT_ENABLED` (escrita — requer autorização).

### O que NÃO fazer

- Não desligue `BILLING_INVOICES_ENABLED` por causa da queda: isso para a
  emissão de faturas novas e os e-mails de cobrança. Se o objetivo é não
  bloquear, desligue só o enforcement.
- Não dê baixa manual sem o dinheiro confirmado na conta, nem "para liberar
  enquanto paga". Para liberar sem pagamento, use "Estender prazo".
- Não dê baixa manual numa fatura cujo Pix pode já ter sido pago na Upper.
  Veja a seção 4, passo 1.
- Não use "Dar dias grátis" como remédio de queda sem decisão do responsável.
- Não marque cobranças `FAILED` como pagas nem mude o `status` delas à mão.

**Resultado (início e fim da queda, previsão da Upper, casas com prazo
estendido, enforcement desligado sim/não e quando religou, baixas manuais
feitas com o comprovante de cada uma, Pix antigos que ficaram abertos):**
_______________________________________________

---

## 3. Pagamento com valor diferente da fatura (ou do pedido de créditos)

### Como se percebe

- Alerta **`charge_needs_review`** (aviso, não crítico): aparece em Admin →
  Faturamento → "Saúde da cobrança" e no painel ("pagamentos em revisão"). Não
  vai para o Sentry e não segura o heartbeat.
- `payment_webhook_events.outcome = 'needs_review'`.
- A casa diz que pagou e a fatura continua em aberto, ou o saldo não subiu.
- **Caso travado (C, só sem a migration `20261024100500`):** alerta
  **`charge_paid_not_credited`** (crítico) que não some sozinho e segura o
  heartbeat `billing-health`. Com a migration aplicada, o caso C cai em
  `charge_needs_review` como os outros.

### Os casos

| Caso | Tipo | O que aconteceu | Quem marca a revisão |
|---|---|---|---|
| A | fatura ou créditos | `paid_amount_cents` diferente de `amount_cents` (ou nulo) na cobrança: a casa pagou outro valor | o código, ao gravar o retorno da Upper (`recordChargeSnapshot`) |
| B1 | fatura | a fatura foi repreçada depois do Pix gerado (desconto, preço próprio) e o cancelamento do Pix antigo falhou: `billing_invoices.amount_cents` diferente de `payment_charges.amount_cents` (motivo `amount_mismatch`) | `billing_credit_paid_charge` |
| B2 | fatura | Pix pago para fatura que já não está aberta, ou seja, já paga (pagamento em dobro) ou cancelada (motivo `invoice_not_open`), ou que não existe (`invoice_not_found`) | `billing_credit_paid_charge` |
| C | créditos | o valor do pedido (`credit_topup_orders.amount_cents`) é diferente do valor da cobrança (motivo `amount_mismatch`) | `billing_credit_paid_charge`, desde a migration `20261024100500`. Antes dela ninguém marcava e a cobrança ficava travada (ver "Caso C" abaixo) |

### Diagnóstico (só leitura)

Cobranças em revisão, com o motivo provável:
```sql
select c.id, t.slug, c.kind, c.external_id, c.status,
       c.amount_cents, c.paid_amount_cents, c.paid_at,
       i.id as invoice_id, i.status as invoice_status, i.amount_cents as invoice_amount,
       o.id as order_id, o.status as order_status, o.amount_cents as order_amount,
       case
         when c.paid_amount_cents is distinct from c.amount_cents then 'A: valor pago diferente do cobrado'
         when c.kind = 'invoice' and i.id is null then 'B2: fatura não encontrada'
         when c.kind = 'invoice' and i.status <> 'open' then 'B2: fatura ' || i.status
         when c.kind = 'invoice' and i.amount_cents <> c.amount_cents then 'B1: fatura repreçada'
         when c.kind = 'credit_topup' and o.amount_cents <> c.amount_cents then 'C: pedido diferente da cobrança'
         else 'outro: ver last_error e eventos'
       end as motivo
from public.payment_charges c
join public.tenants t on t.id = c.tenant_id
left join public.billing_invoices i on c.kind = 'invoice' and i.id = c.ref_id
left join public.credit_topup_orders o on c.kind = 'credit_topup' and o.id = c.ref_id
where c.needs_review = true and c.credited_at is null
  and c.review_resolved_at is null
order by c.paid_at;
```

O caso travado (C), que **não** aparece na consulta acima (só acontece sem a
migration `20261024100500`):
```sql
select c.id, t.slug, c.external_id, c.amount_cents, c.paid_amount_cents, c.paid_at,
       o.id as order_id, o.status as order_status, o.amount_cents as order_amount
from public.payment_charges c
join public.tenants t on t.id = c.tenant_id
left join public.credit_topup_orders o on o.id = c.ref_id and o.tenant_id = c.tenant_id
where c.kind = 'credit_topup'
  and c.status = 'PAID' and c.credited_at is null and c.needs_review = false
order by c.paid_at;
```
Se `order_id` vier nulo, o pedido não existe e a RPC lança
`topup_order_not_found`. Os logs mostram `[billing-reconcile] error crediting
locally-paid charge`, e a correção é a mesma do caso C. Se `order_amount` for
igual a `amount_cents`, não é o caso C: vá para a seção 4.

Confira também que o valor pago bate com o painel da Upper (procure pelo
`external_id`) e que não houve crédito ou baixa anterior para o mesmo
pagamento:
```sql
select created_at, entry_type, amount, reason, idempotency_key
from public.wallet_ledger
where tenant_id = '<tenant_id>'
  and (idempotency_key = 'charge:' || '<charge_id>'
       or (entry_type = 'manual_adjustment' and reason ilike '%' || '<external_id>' || '%'))
order by created_at;
```

### Correção

Primeiro **fale com a casa** e decida com ela, e com o responsável quando
envolver devolução, o destino do dinheiro. Depois aplique uma das opções.

**Fatura (casos A, B1 e B2):**

| Situação | Opção |
|---|---|
| Pagou **a mais**, ou o valor certo de uma fatura repreçada (B1), e a fatura segue aberta | **"Dar baixa manual"** na fatura (escrita — requer autorização) com o valor recebido = `paid_amount_cents`, a data do pagamento = `paid_at` da cobrança, o comprovante = `external_id` e o endToEndId, e uma nota explicando. O excedente, se houver: devolver por fora ou creditar como saldo (linha abaixo), conforme combinado |
| Pagou **a menos** e a fatura segue aberta | (1) a casa completa por fora e você dá a baixa manual com o **total recebido**, citando os dois comprovantes; ou (2) devolve por fora e a casa paga um Pix novo (o botão "Pagar" gera outro). Não dê baixa manual com valor menor sem decisão do responsável: ela libera a casa como paga |
| Fatura já paga ou cancelada (B2): pagamento em dobro | Devolver por fora, ou, com o acordo da casa, **creditar como saldo**: `/admin` → aba "Saldo" → **"Ajustar saldo"** (escrita — requer autorização) com o valor pago e o motivo "Pix `<external_id>` pago em dobro, convertido em créditos" |

**Créditos (casos A e C):**

| Situação | Opção |
|---|---|
| A casa quer o saldo | **"Ajustar saldo"** (escrita — requer autorização) com o valor **efetivamente pago** (`paid_amount_cents / 100`), motivo "Pix `<external_id>` revisado". Confira antes, com a consulta do `wallet_ledger`, que não existe crédito para essa cobrança |
| A casa quer o dinheiro de volta | Devolver por fora, pelo canal financeiro. Nada muda no saldo |

**Caso C (créditos):** com a migration `20261024100500` aplicada, a própria
RPC marca `needs_review` e o caso segue o fluxo normal da tabela acima
(creditar o que a casa pagou via "Ajustar saldo", com o valor da cobrança,
`paid_amount_cents`, ou devolver) e depois "Resolver revisão". **Abra um bug**
mesmo assim: pedido e cobrança com valores diferentes não deveriam existir
(`createCreditTopupFor` grava os dois com o mesmo valor). Guarde os ids no
ticket.

Sem a migration (cobrança `PAID`, sem `credited_at`, `needs_review = false`
e o pedido com outro valor): aplique a migration
`20261024100500_billing_review_and_retention.sql` (escrita — requer
autorização). Na próxima conciliação a RPC marca a revisão e o alerta passa
de `charge_paid_not_credited` (crítico) para `charge_needs_review` (aviso).
Não faça mais o `update ... set needs_review = true` à mão.

**Fechar a revisão: botão "Resolver"** (escrita pelo painel — requer
autorização). Em Admin → Faturamento → "Saúde da cobrança", a lista
"Cobranças aguardando revisão" tem um botão **"Resolver"** por cobrança. O
diálogo pede o resultado e um motivo (obrigatório, mínimo 5 caracteres):

- **"Creditado manualmente"** (`creditado_manual`): o dinheiro já entrou por
  "Ajustar saldo" (créditos) ou pela baixa manual (fatura). Faça o crédito ou
  a baixa **antes** de resolver.
- **"Devolvido fora do sistema"** (`devolvido`): o dinheiro foi devolvido à
  casa pelo canal financeiro.

O botão chama `billing_resolve_charge_review`, que grava
`review_resolved_at`, `review_resolved_by`, `review_outcome` e `review_note`
na cobrança e uma linha `billing.resolve_charge_review` em
`tenant_audit_logs`. **Não** preenche `credited_at`, não credita, não dá baixa
e não apaga nada; `needs_review` continua `true` como marca histórica. A
cobrança some de `charge_needs_review` e da lista. Use sempre o botão: o
`update ... set credited_at` manual das versões anteriores deste runbook não
deve mais ser usado (com créditos devolvidos ele contava como receita um
dinheiro que saiu).

Conferir depois (só leitura):
```sql
select review_resolved_at, review_resolved_by, review_outcome, review_note
from public.payment_charges where id = '<charge_id>';
select created_at, actor_user_id, metadata
from public.tenant_audit_logs
where entity_id = '<charge_id>' and action = 'billing.resolve_charge_review';
```

### O que NÃO fazer

- Não apague a cobrança, o pedido, a fatura nem o evento de webhook.
- Não mude `amount_cents` nem `paid_amount_cents` da cobrança, do pedido ou da
  fatura "para bater": isso apaga o registro do que foi cobrado e pago.
- Não ponha `needs_review = false` para "deixar a conciliação creditar". O
  valor divergente creditaria o valor errado, ou cairia de novo no caso C.
- Não chame `billing_credit_paid_charge` numa cobrança em revisão. Ela recusa
  (`needs_review`) e não resolve nada.
- Não credite por "Ajustar saldo" sem antes conferir no `wallet_ledger` que o
  mesmo pagamento não foi creditado. O ajuste não tem trava de duplicidade.
- Não feche a revisão com `update` à mão: use o botão "Resolver" (ver acima).
- Não resolva como "Creditado manualmente" antes de o crédito ou a baixa
  existirem de fato.

**Resultado (cobrança, caso A/B1/B2/C, decisão combinada com a casa, ação
feita e o comprovante da devolução, se houve):**
_______________________________________________

---

## 4. A casa pagou e não foi liberada

### Como se percebe

- A casa diz que pagou a mensalidade e continua vendo "Acesso suspenso por
  falta de pagamento", "Ative sua conta" ou a faixa vermelha.
- Às vezes junto com `charge_paid_not_credited` ou `charge_needs_review`.

### Diagnóstico, nesta ordem (só leitura)

Pegue o `tenant_id` (consulta de apoio no topo). Peça à casa o horário do
pagamento e, se possível, o endToEndId do comprovante. Não peça CPF.

**Passo 1. A cobrança.**
```sql
select c.id, c.external_id, c.status, c.needs_review, c.amount_cents,
       c.paid_amount_cents, c.paid_at, c.credited_at, c.last_error,
       c.created_at, c.updated_at, c.ref_id as invoice_id
from public.payment_charges c
where c.tenant_id = '<tenant_id>' and c.kind = 'invoice'
order by c.created_at desc
limit 5;
```
- **Nenhuma cobrança com o horário do pagamento:** a casa pagou outra coisa,
  como um QR antigo ou de outra fatura, ou um Pix de créditos (`kind =
  'credit_topup'`). Rode a consulta de cobranças de apoio, sem filtro de
  `kind`.
- **`PENDING`/`ACTIVE`:** ainda não sabemos que foi pago. Procure no painel da
  Upper pelo `external_id`. Se lá estiver pago, siga para os passos 2 e 3.
- **`PAID` e `credited_at` preenchido:** a baixa aconteceu. Vá para o passo 5.
- **`PAID`, `credited_at` nulo e `needs_review = true`:** é a seção 3.
- **`PAID`, `credited_at` nulo e `needs_review = false`:** a conciliação deveria
  creditar em até 5 min. Siga para os passos 3 e 4.
- **`EXPIRED`/`CANCELLED`/`FAILED`, mas pago na Upper:** a conciliação
  reconsulta esses estados por 48 h desde a criação e credita o pagamento
  atrasado. Siga para o passo 3.

**Passo 2. Os eventos de webhook dessa cobrança.**
```sql
select event_id, event, outcome, error, received_at, processed_at
from public.payment_webhook_events
where raw_body like '%' || '<external_id>' || '%'
order by received_at;
```
Eventos com mais de 90 dias não têm mais `raw_body` nem `headers` (retenção,
ver seção 5): para eles, busque pelo horário (`received_at`) e pelo
`outcome`.
- Nenhum evento: o webhook não chegou (Upper, URL, assinatura). Veja se há
  `webhook_invalid_signature` no painel. A conciliação cobre.
- `error` preenchido e `processed_at` nulo: o processamento falhou; a Upper
  reentrega e a conciliação cobre.
- `outcome = 'needs_review'`: seção 3. `outcome = 'credited'` ou
  `'already_credited'`: a baixa aconteceu; vá para o passo 5.

**Passo 3. A conciliação está rodando?**
```sql
select status, started_at, finished_at, claimed, sent, errors, stop_reason
from public.dispatcher_runs
where job = 'billing-reconcile'
order by started_at desc
limit 6;
```
Esperado: uma execução a cada 5 min, `succeeded`. Sem linhas recentes, veja o
alerta `reconcile_cron_stale` na seção 5. `errors > 0` seguidos indicam a Upper
fora (seção 2) ou chave recusada (`upper_unauthorized`, seção 1).

**Passo 4. Por que `billing_credit_paid_charge` não deu baixa.** Não chame a
função para diagnosticar; ela é uma escrita. Leia o que ela leria:
```sql
select c.status, c.needs_review, c.credited_at,
       c.amount_cents, c.paid_amount_cents,
       i.status as invoice_status, i.amount_cents as invoice_amount
from public.payment_charges c
left join public.billing_invoices i on i.id = c.ref_id and i.tenant_id = c.tenant_id
where c.id = '<charge_id>';
```
A função dá baixa só com: `status = 'PAID'`, `needs_review = false`,
`paid_amount_cents = amount_cents`, fatura existente, `open` e com
`amount_cents` igual ao da cobrança. Fatura ausente, fechada ou com outro
valor faz a função marcar `needs_review` (seção 3).

**Passo 5. A fatura.**
```sql
select id, status, upfront, amount_cents, due_date, cycle_due_date,
       paid_at, paid_via, paid_amount_cents, payment_charge_id, created_at
from public.billing_invoices
where tenant_id = '<tenant_id>'
order by created_at desc
limit 5;
```
Esperado após o pagamento: a fatura `paid`, `paid_via = 'pix'` (ou
`'manual'`), e **nenhuma outra `open`**. Se existe outra fatura `open`, por
exemplo uma de ativação reemitida ou a do ciclo seguinte já vencida, é ela que
mantém o bloqueio. A casa pagou uma fatura, mas não a que está bloqueando.

**Passo 6. O estado da casa.**
```sql
select tb.access_state, tb.access_state_at, tb.next_due_date,
       tb.manual_block, tb.manual_block_reason, tb.frozen,
       public.billing_invoice_phase(tb.tenant_id) as fase_calculada_agora,
       public.billing_tenant_exempt(tb.tenant_id) as isenta,
       t.status as tenant_status
from public.tenant_billing tb
join public.tenants t on t.id = tb.tenant_id
where tb.tenant_id = '<tenant_id>';
```
- `manual_block = true` (`locked_manual`) ou `frozen = true`: **o Pix não tira
  esses bloqueios**. Só o superadmin, em "Desbloquear casa" ou "Descongelar
  plano". Confirme antes se o bloqueio manual ainda tem razão de existir (veja
  `manual_block_reason` e a auditoria).
- `tenant_status` `suspended` ou `canceled`: a tela é outra ("Conta suspensa"),
  independente da cobrança. Resolva o status da casa à parte.
- `access_state` diferente de `fase_calculada_agora` (e a casa não é isenta,
  congelada nem bloqueada à mão): o estado gravado está velho. A baixa sempre
  recalcula, então isso é raro. Veja a correção abaixo.

**Passo 7. Cache.** O servidor guarda o estado de cada casa por **5 s** em
memória (por processo) antes de reler. A baixa por Pix limpa esse cache na
hora; a baixa manual não, e expira em 5 s. No navegador, a tela reconsulta o
estado a cada **60 s**. O modal de Pix força a reconsulta quando confirma o
pagamento, mas outra aba ou outro usuário da casa pode levar até 1 min. Se o
banco já diz `ok` (passo 6), peça para **recarregar a página**. Não há nada a
corrigir no servidor.

### Correção

| Achado | Correção |
|---|---|
| Pago na Upper, nosso banco ainda `PENDING`/`ACTIVE` ou terminal, conciliação rodando | Esperar até 10 min. A conciliação confirma por GET e dá a baixa |
| `PAID`, `credited_at` nulo, `needs_review = false`, e a conciliação parada ou com erro há mais de 10 min | Consertar a conciliação (seção 5). Se a casa não puder esperar, dar a baixa pela própria RPC (escrita — requer autorização), uma vez só: ver o bloco abaixo |
| `needs_review = true` | Seção 3 |
| Fatura `paid`, mas `access_state` velho | Recalcular o estado (escrita — requer autorização): ver o bloco abaixo |
| Outra fatura `open` | Explicar à casa qual fatura falta. Se essa fatura estiver errada, "Cancelar fatura" no console (escrita — requer autorização) |
| `locked_manual`/`frozen` | Superadmin decide desbloquear ou descongelar (escrita — requer autorização) |
| Banco `ok`, tela bloqueada | Recarregar a página |

Dar baixa pela RPC, a mesma que o webhook e a conciliação usam (escrita —
requer autorização):
```sql
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.billing_credit_paid_charge('<charge_id>');
commit;
```
**Esperado:** `{"ok": true, "tenant_id": …, "invoice_id": …, "next_due_date": …}`.
`{"ok": true, "idempotent": true}` quer dizer que já tinha sido feito. Repetir
é seguro: a função trava a cobrança e não credita duas vezes. `{"ok": false,
"reason": …}` quer dizer que não fez nada: volte ao passo 4. Pelo pooler, o
cache de 5 s do servidor e o e-mail "Pagamento confirmado" não são acionados
por esta chamada. O cache expira sozinho, e o e-mail sai na varredura do job
da hora, que pega faturas pagas nas últimas 48 h sem esse e-mail.

Recalcular o estado (escrita — requer autorização):
```sql
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.billing_refresh_access_state('<tenant_id>');
commit;
```

**Baixa manual quando o Pix foi de fato pago: não faça.** Se a cobrança está
`PAID` (ou paga no painel da Upper), a baixa tem que sair pela RPC acima ou
pela conciliação. "Dar baixa manual" nesse caso:
- registra a fatura como `paid_via = 'manual'`, sem o `payment_charge_id` e sem
  o endToEndId do Pix;
- faz o Pix, quando a conciliação chegar nele, cair em `needs_review` com
  `invoice_not_open`, como se fosse um pagamento em dobro.

A fatura não é baixada duas vezes (a segunda tentativa recusa), mas o registro
fica errado e gera um falso alerta de revisão. **Baixa manual só para dinheiro
que entrou fora do Pix do sistema** (seção 2). Se já foi feita por engano: não
desfaça a fatura; resolva a revisão da cobrança pelo botão "Resolver" (seção
3, "Fechar a revisão") com o resultado "Creditado manualmente" e anote no
motivo e no ticket que o pagamento real foi o Pix `<external_id>`.

### O que NÃO fazer

- Não mude `tenant_billing.access_state` com `update`. Ele é recalculado e
  seria sobrescrito; use `billing_refresh_access_state`.
- Não mude `billing_invoices.status` à mão para `paid`. O ciclo
  (`next_due_date`) não andaria e a auditoria ficaria sem registro.
- Não dê baixa manual para "liberar enquanto confirma". Para isso existe
  "Estender prazo".
- Não desligue o enforcement global para liberar uma casa só.

**Resultado (casa, cobrança, passo em que achou a causa, correção aplicada,
hora em que a casa confirmou o acesso):**
_______________________________________________

---

## 5. Códigos de alerta da saúde da cobrança

Origem: `src/lib/billing/billing-health.server.ts`, rodando junto da
conciliação a cada 5 min. Os críticos vão para o Sentry (fingerprint
`billing-alert/<código>`) ou, sem Sentry, para o log com o prefixo
`[billing-alert]` (no máximo 1 vez por hora por código). O painel fica em
Admin → Faturamento → "Saúde da cobrança" (últimas 24 h). O heartbeat
`billing-health` do Better Stack para de receber ping enquanto houver achado
crítico de estado (todos os críticos, exceto os 4 de evento:
`webhook_invalid_signature`, `upper_feature_disabled`, `upper_unauthorized` e
`upper_unavailable`). Os de evento só alertam quando há evento novo desde a
execução anterior.

### Retenção do corpo dos webhooks (escopo §8)

O ciclo da hora (`billing-cycle`), depois de fechar a execução, apaga (põe
`null`) `raw_body` e `headers` de `payment_webhook_events` com mais de 90 dias,
em lotes de 1000 (até 5 lotes por hora), pela função
`billing_purge_webhook_bodies` (migration `20261024100500`). A linha continua
(`event_id`, `event`, `delivery_id`, `signature_valid`, `received_at`,
`processed_at`, `outcome`, `error`); `payment_charges` nunca é tocada. O
número de linhas limpas vai em `webhook_bodies_purged` na resposta do job
(`null` = a etapa falhou; ver `[billing-retention]` nos logs). Uma falha aqui
não afeta o ciclo.

### Códigos

| Código | Severidade | O que quer dizer | Primeira ação |
|---|---|---|---|
| `webhook_invalid_signature` | crítico (evento) | A rota do webhook recusou (`400`) callbacks sem assinatura válida. O motivo vai em `last_detail`: `missing`, `malformed`, `stale` (mais de 5 min de diferença) ou `mismatch` | Logo após trocar o segredo é esperado (seção 1). `stale` em tudo: conferir o relógio da VPS (`date -u`). `mismatch` sem troca recente: conferir que o segredo do painel da Upper e o do `.env` são iguais, sem ler os valores em canal aberto. Muitos `missing`/`malformed` de origem estranha: alguém sondando a rota; nada é creditado sem GET na Upper |
| `charge_paid_not_credited` | crítico | Cobrança `PAID` há mais de 10 min sem `credited_at` e fora de revisão | Seção 4, passos 3 e 4. Se não sai depois da conciliação voltar: caso C da seção 3 |
| `charge_needs_review` | aviso | Cobrança paga com valor diferente (fatura ou créditos), ou para fatura fechada ou inexistente, ainda não resolvida | Seção 3: corrigir e depois "Resolver" |
| `wallet_ledger_mismatch` | crítico | Alguma carteira com `balance` diferente da soma do `wallet_ledger` | Ler `select * from public.billing_wallet_integrity();` e anotar casas e diferenças. **Não corrigir o saldo à mão** nem com "Ajustar saldo" antes de saber a causa; escalar para quem conhece o código (o saldo só muda por `wallet_mutation`) |
| `upper_feature_disabled` | crítico (evento) | A Upper respondeu `403 FEATURE_DISABLED`: o Pix está desligado na conta (KYC/conta) | Falar com a Upper. Para as casas, mesmo tratamento da seção 2 |
| `upper_unauthorized` | crítico (evento) | A Upper recusou a chave (`401`) | Confirmar se alguém revogou ou trocou a chave. Se não foi planejado: seção 1. Se a chave foi trocada: conferir `!!process.env.UPPER_API_KEY` e se o container foi recriado |
| `upper_unavailable` | crítico (evento) | 3 ou mais falhas da Upper (tempo esgotado, rede ou 5xx) na janela | Seção 2. Antes, separar queda real (falhas em muitas cobranças ou chamadas diferentes) de uma cobrança só que responde 5xx sempre (mesmo `externalId` nos logs `[billing-reconcile]`) |
| `reconcile_cron_stale` | crítico | A conciliação não conclui há mais de 15 min (ou nunca concluiu) | `select jobname, schedule, active from cron.job where jobname = 'betleads-billing-reconcile';` e `select status_code, left(content::text, 200), created from net._http_response order by created desc limit 5;`. `401` indica `CRON_SECRET` diferente entre o Vault e a VPS; erro de rede indica container ou DNS. Ver `RUNBOOK_ATIVAR_PIX_UPPER.md`, Passo 5 |
| `billing_cycle_cron_stale` | crítico | O job da hora (`billing-cycle`) não conclui há mais de 3 h. Sem ele não saem faturas, e-mails, alertas de saldo nem recálculo de estado (o bloqueio e a faixa amarela não aparecem) | Mesmas consultas, com `betleads-billing-cycle` e `dispatcher_runs.job = 'billing-cycle'`. Ver `RUNBOOK_ATIVAR_MENSALIDADE.md`, Passo 5 |
| `billing_health_check_failed` | crítico | A própria checagem não conseguiu ler `billing_health_snapshot` | Logs por `[billing-health] snapshot failed`. Conferir se as migrations `20261024100400_billing_health_monitor.sql` e `20261024100500_billing_review_and_retention.sql` estão aplicadas e se o banco responde |
| `billing_alert_test` | crítico (sintético) | Disparado pelo botão "Testar alerta" | Nada a corrigir. Só confirma que o alerta chega (aceite da PG6-03) |

Sinais crus, para ver quando e quantos (só leitura):
```sql
select code, bucket_start, count, last_at, last_detail
from public.billing_monitor_signals
order by last_at desc
limit 20;
```

**Resultado (código, hora, primeira ação, causa encontrada):**
_______________________________________________
