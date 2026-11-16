# Escopo — Gateway PaganoPay direto (mensalidade + adição de saldo)

Data: 2026-11-16 · Fonte: https://www.paganopay.com/docs (versão "atualizada em 23/10/2026", lida do
bundle da página, que é SPA) · Base conferida: `https://www.paganopay.com/api/payments/fees` responde
`401 {"success":false,"message":"API Keys são obrigatórias"}` sem chave.

Objetivo: receber **mensalidades** (`billing_invoices`) e **compras de saldo** (`credit_topup_orders`)
por Pix **direto na PaganoPay**, como terceiro provedor da camada `PixGateway`, ao lado da Upper e da
SpacePay. Hoje a SpacePay é um proxy, e o PSP por trás do nosso token já é a PaganoPay
(`docs/spacepay-gateway-scope.md`). A integração direta tira esse intermediário e traz o que o
proxy não tinha:

- webhook assinado com HMAC;
- validade do QR escolhida por nós;
- cancelamento;
- listagem para conciliação;
- taxa real por cobrança.

Cada cobrança continua presa ao gateway em que nasceu (`payment_charges.provider`).

**Decisões (2026-11-16):**

- **Mesma conta PaganoPay** que hoje recebe via SpacePay. O saldo é um só, e o webhook do painel
  recebe tudo o que acontece na conta (ver 2.3-4 e 2.11).
- **A SpacePay fica desligada** depois da virada. Não serve de plano B. O código dela continua só
  enquanto as cobranças abertas por ela se esgotam (2.11).

---

## Parte 1 — Documentação da API PaganoPay (o que usamos)

### 1.1 Visão geral

| Item | Valor |
|---|---|
| URL base | `https://www.paganopay.com/api` |
| Prefixo | `/payments/...` (plural). O singular `/payment/...` é legado e **sem idempotência**: não usar |
| Formato | JSON UTF-8, `Content-Type: application/json` |
| Autenticação | Cabeçalhos `X-API-Public-Key: pk_<32 hex>` e `X-API-Secret-Key: sk_<64 hex>` em toda chamada. Não há token para renovar |
| Ambiente | **Só produção. Não há sandbox**: toda chamada movimenta dinheiro de verdade |
| Limite | 600 req/min por chave. Acima disso: `429 RATE_LIMITED` com `Retry-After` (s) |
| Valores | Entrada **sempre em centavos inteiros** (`10000` = R$ 100,00). Mín. `100`, máx. `50000000` |
| Datas | Sem fuso (`2026-10-21 14:00:00.123456`) = **Brasília**. Com `Z` = UTC |
| IP Allowlist | Opcional, no painel (Segurança → IP Allowlist da API). Lista vazia = qualquer IP |

**Atenção: a chave secreta também faz saque.** Com o par de chaves dá para fazer `POST /payments/cash-out`
sem 2FA. O par fica só no servidor, criptografado em `payment_gateway_accounts` como os outros
gateways, e o nosso código **nunca** chama rotas de saque.

Nas respostas, `amount` vem em centavos. Já `amount_brl`, `fee_amount`, `net_amount`, `gross_amount`
e os campos de saldo vêm em **reais**, às vezes como texto (`"100.00"`). Converter com `Number()`.

### 1.2 Erros de autenticação

| Resposta | Significado |
|---|---|
| `401 {"message":"API Keys são obrigatórias"}` | Faltou cabeçalho |
| `401 {"message":"API Keys inválidas"}` | Par errado, desativado ou apagado |
| `401 {"message":"API Key expirada"}` | Gerar chave nova no painel |
| `403 {"message":"IP não autorizado"}` | IP fora da allowlist |
| `{"code":"ACCOUNT_DISABLED"}` | Conta desativada: suporte |

Formato geral de erro: `{"success": false, "message": "...", "code": "..."}`. O `code` só aparece em
erros com tratamento específico.

| HTTP | Quando | Nosso tratamento |
|---|---|---|
| 400 | Campo inválido, operação não permitida no status | Não repetir. `PixGatewayError` com `retryable:false` |
| 401/403 | Credenciais, IP, conta | Sinal `paganopay_auth_error` |
| 404 | Transação não existe ou é de outra conta | `isPixNotFound` |
| 422 | Recusado por regra | Não repetir |
| 429 | Rate limit | `retryable:true`, respeitar `Retry-After` |
| 500 | Erro interno | Repetir com a **mesma** `Idempotency-Key` |
| 503 | Arranjo indisponível | Repetir em instantes |

### 1.3 Idempotência

- Cabeçalho `Idempotency-Key` (até 255 caracteres) em toda criação. Se a mesma chave voltar em até
  **24 h**, a API devolve **200** com os dados originais e a mensagem `Pagamento já processado
  anteriormente`. A criação nova devolve **201**. Tratar os dois como sucesso.
- Uma tentativa que **falhou** pode ser repetida com a mesma chave e é processada de novo.
- Sem o cabeçalho, a API deriva a chave de `sellerExternalRef` (≥ 6 caracteres) + valor + rota.

### 1.4 Criar cobrança — `POST /payments/pix`

Corpo:

| Campo | Obrig. | Observação |
|---|---|---|
| `amount` | sim | Centavos, de 100 a 50.000.000 |
| `sellerExternalRef` | sim | Nossa referência. Volta como `externalRef` / `external_ref` |
| `customer.name` | sim | |
| `customer.email` | sim | |
| `customer.phone` | sim | **Texto**, com DDD, ≥ 10 dígitos e não só zeros |
| `customer.documentType` | sim | `CPF` ou `CNPJ` |
| `customer.document` | sim | Dígitos verificadores conferidos |
| `items[]` | sim, ≥ 1 | `{title, quantity, amount}` (preço unitário em centavos). A soma tem que bater com `amount` |
| `expiresIn` | não | Segundos, de 60 a 2.592.000 (30 dias) |
| `postbackUrl` | não | URL extra só desta cobrança (além do webhook do painel) |
| `metadata` | não | Objeto livre. Volta na consulta e no webhook |
| `split` | não | Não usamos |

Resposta `201`:

```json
{
  "success": true,
  "message": "Pagamento PIX criado com sucesso",
  "data": {
    "id": 26150,
    "status": "PENDING",
    "amount_brl": "100.00",
    "external_id": "01a020de-96d2-71ac-a532-aaab8ed32b11",
    "created_at": "2026-10-21 14:00:00.123456",
    "pix": { "qrcode": "000201…", "copyPaste": "000201…", "expiresAt": "2026-10-21T18:00:00Z" },
    "feeInfo": { "grossAmount": 100, "estimatedFee": 1.99, "estimatedNetAmount": 98.01, "currency": "BRL" }
  }
}
```

- `data.id` (numérico) é o id usado em consulta, cancelamento e estorno → `payment_charges.provider_charge_id`.
- `pix.copyPaste` é o EMV. **O QR tem que ser gerado por nós a partir dele**: `qrcodeUrl` e
  `qrcodeBase64` nem sempre vêm.
- Nem todo arranjo respeita o `expiresIn`. Usar `pix.expiresAt` (ou `expirationDate`) quando vier.
- Erros comuns: `Campos obrigatórios: amount, sellerExternalRef, customer, items`, `Telefone
  inválido…`, `CPF inválido…`, `Valor mínimo para PIX é R$1,00`, `…Status: FAILED` (arranjo recusou).

### 1.5 Consultar cobrança — `GET /payments/transactions/{id}`

É a **fonte da verdade** antes de creditar. Campos usados:

- `status`;
- `amount` (centavos) e `amount_brl`;
- `externalRef` e `externalId`;
- `endToEndId`;
- `paidAt` (UTC);
- `payer {name, document}` (pagador real, pode ser `null`);
- `payerMatchesCustomer`;
- `metadata`;
- `pix {qrcode, copyPaste}`.

Não encontrada: `404 {"message":"Transação não encontrada"}`.

### 1.6 Listar cobranças — `GET /payments/transactions`

Query:

- `page` e `limit` (máx. 100);
- `startDate` e `endDate` (`AAAA-MM-DD`; o `endDate` é comparado à **meia-noite**, então para incluir o dia 21 envie `22`);
- `status`;
- `sellerExternalRef` (busca exata pela nossa referência);
- `externalId`.

Uma cobrança paga pode estar gravada como `PAID`, `COMPLETED` ou `CONFIRMED`. A listagem é um
resumo: pagador e `endToEndId` só vêm na consulta por id.

### 1.7 Cancelar — `POST /payments/transactions/{id}/cancel`

Só funciona em `PENDING` (outro status dá 400; já cancelada dá 200). **O cancelamento vale só no
lado deles**: `invalidatedAtAcquirer: false`, o QR **continua pagável**, e se o cliente pagar a
cobrança volta para `PAID` com `pix.confirmed`. O cancelamento não gera webhook.

### 1.8 Estorno — `POST /payments/transactions/{id}/refund`

Pode ser parcial ou total e sai do saldo na hora. **Fora do escopo** (a regra é "sem reembolso"). Se
for preciso, o superadmin faz no painel. Só documentado aqui para saber que o status `REFUNDED`
pode aparecer.

### 1.9 Status da cobrança e mapeamento para o nosso `PixChargeStatus`

| PaganoPay | Significado | Nosso status |
|---|---|---|
| `PENDING`, `WAITING_PAYMENT`, `PROCESSING` | Aguardando / em processamento | `ACTIVE` |
| `PAID`, `COMPLETED`, `CONFIRMED` | Paga | `PAID` |
| `EXPIRED` | Venceu (quando o arranjo informa) | `EXPIRED` |
| `CANCELLED` | Cancelada | `CANCELLED` |
| `FAILED`, `REJECTED` | Recusada | `FAILED` |
| `REFUNDED` | Estornada por inteiro | `FAILED`. Se já creditada → `needs_review` (`flagRefundedPaidCharge`, igual SpacePay) |
| `MED`, `IN_PROTEST`, `DISPUTE`, `CHARGEBACK`, `CHARGEDBACK`, `PRECHARGEBACK` | Contestação aberta pelo pagador, valor retido | Mantém `PAID` + `needs_review` + sinal `paganopay_dispute` |
| Qualquer outro | — | `ACTIVE` (**não pago e não final**, como manda a doc) |

### 1.10 Saldo e taxas

- `GET /payments/balance`: `available`, `blocked` (`blockedByMed`), `reserve`, `pending`, em reais.
- `GET /payments/fees`: `fixedFee` (R$) e `percentageFee` (%), com `isCustom` quando a tarifa é negociada.

As duas são leitura pura e servem para o botão **Testar conexão** do admin.

### 1.11 Webhook

**Cadastro:** no painel, em **Integrações → Webhook**, informar uma URL pública HTTPS com
**Atualização de transações** marcada (todos os eventos) e guardar o **segredo**. O `postbackUrl` por
cobrança só é assinado se houver um webhook do painel com **a mesma URL**. Por isso usamos só o
webhook do painel e não mandamos `postbackUrl`.

**Corpo** plano, sem envelope `data`. É o mesmo nos dois canais:

```json
{"event":"pix.confirmed","id":26150,"transactionId":26150,"status":"PAID","amount":10000,
 "amount_brl":100,"gross_amount":100,"fee_amount":1.99,"net_amount":98.01,
 "external_ref":"<nossa sellerExternalRef>","external_id":"01a020de-…",
 "pix":{"endToEndId":"E0000…"},"payer":{"name":"JOAO DA SILVA","document":"12345678909"},
 "payerMatchesCustomer":true,"metadata":{…},"paid_at":"2026-10-21T17:05:12.000Z",
 "created_at":"2026-10-21 14:00:00.123456","provider":"…"}
```

**Eventos de cobrança:**

| Evento | Significado |
|---|---|
| `pix.received` | Cobrança **gerada** (`PENDING`). **Não é pagamento.** Não é garantido |
| `pix.confirmed` | **Paga** (`PAID`) |
| `pix.failed` | Recusada ou cancelada pelo arranjo |

Também podem chegar `cashout.*`, `transaction.*` e `withdrawal.*`. Ignorar e responder **200**.

**Cabeçalhos:**

| Cabeçalho | Conteúdo |
|---|---|
| `X-Webhook-Signature` | `v1=<hex>` |
| `X-Webhook-Timestamp` | Segundos Unix |
| `X-Webhook-Event` | Nome do evento |
| `X-Webhook-ID` | Id da entrega. Repete nas novas tentativas |

**Validação da assinatura:**

1. Ler o corpo **cru**, antes de qualquer parse.
2. Montar a mensagem `"<timestamp>.<corpo>"`.
3. Calcular o HMAC-SHA256 dela com o segredo do painel como chave.
4. Comparar com o valor depois de `v1=` em tempo constante.
5. Recusar se a diferença de horário passar de **300 s**.

É o mesmo algoritmo da Upper (`upper-webhook.ts`). Só muda o formato do cabeçalho: lá é
`t=…,v1=…` num cabeçalho só; aqui o timestamp vem separado.

**Entrega e novas tentativas:**

- Qualquer 2xx conta como entregue.
- Sem 2xx, nova tentativa **a cada 60 s, até 5 no total**, com reenvio manual pelo painel.
- **Depois de 10 falhas seguidas o webhook é pausado.** A pausa dura 30 min e cresce para 2 h, 6 h e 24 h.
- **Eventos da pausa não são reenviados**: só a conciliação pela API os recupera.

**Duplicatas e ordem:**

- Duplicatas acontecem. Deduplicar por `event` + `id` + `status`.
- A ordem não é garantida (`pix.received` pode chegar depois do `pix.confirmed`). Nunca voltar de pago para pendente.

**Troca do segredo:** vale **na hora**, sem período em que os dois funcionam.

---

## Parte 2 — Escopo da integração

### 2.1 O que já existe e é reaproveitado

A camada já é multi-gateway desde a SpacePay. O fluxo é este:

- **Contrato:** `PixGateway` (`create` / `get` / `cancel` / `isConfigured`), em `src/lib/billing/pix-gateway.server.ts`.
- **Uma máquina de estados para os dois fluxos:** `payment_charges` com `kind` = `credit_topup` | `invoice`.
- **Crédito:**
  1. `confirmCharge` (`payment-charges.server.ts`) **sempre re-lê a cobrança no gateway**.
  2. Confere o valor exato.
  3. Credita via a RPC idempotente `billing_credit_paid_charge`.
- **Conciliação:** o cron `betleads-billing-reconcile` (5 min) consulta cada cobrança pelo `provider` da própria linha.
- **Credenciais:** criptografadas em `payment_gateway_accounts` e editáveis no admin (`payment-gateways-card.tsx`). O gateway ativo fica em `payment_gateway_settings`, com o env `BILLING_PIX_PROVIDER` como reserva.
- **Telas:**
  - `plano-e-creditos.tsx` (pagar fatura e comprar saldo);
  - `pix-payment-dialog.tsx` (QR, copia-e-cola, polling de 3 s);
  - fila `needs_review`;
  - card de saúde por provider.
- **Pagador fixo nosso:** os campos `SPACEPAY_PAYER_*` já existem (decisão de 2026-11-12) e podem ser reaproveitados.

Ou seja: **não há mudança nos fluxos de mensalidade e saldo**. O trabalho é um cliente novo, um
webhook novo e a liberação de `'paganopay'` nas constraints e no admin.

### 2.2 Cliente `src/lib/billing/paganopay-pix.server.ts`

Exporta `paganoPayGateway: PixGateway` com `provider: "paganopay"`.

- **`create(input)`** faz `POST /payments/pix`:
  - `amount = input.amountCents`;
  - `sellerExternalRef = input.externalId` (nosso `payment_charges.external_id`, ≥ 6 caracteres);
  - cabeçalho `Idempotency-Key: betleads-<externalId>`;
  - `customer` = pagador fixo da config (2.6);
  - `items = [{ title: input.description, quantity: 1, amount: input.amountCents }]`;
  - `expiresIn = input.expiresIn` (top-up 3600; fatura 1 h a 7 d, dentro de 60 s a 30 d);
  - `metadata = input.metadata` (só ids nossos; nada de nome de casa nem dado pessoal);
  - sem `postbackUrl` e sem `split`.
- **Normalização** para `PixCharge`:

  | `PixCharge` | Origem na PaganoPay |
  |---|---|
  | `id` | `String(data.id)` |
  | `externalId` | `externalRef` |
  | `status` | Mapeamento 1.9 |
  | `amountCents` | Na criação: `amount_brl × 100` arredondado (a criação não devolve `amount` em centavos). Na consulta: `amount` |
  | `emv` | `pix.copyPaste` |
  | `qrCodeImage` | `qrcodeUrl` só se for https; senão `null` (ver 2.7) |
  | `expiresAt` | `pix.expiresAt ?? expirationDate` |
  | `paidAt` | `paidAt` |
  | `paidAmountCents` | `amount` quando pago |
  | `payer` | `payer` |
  | `raw` | **Allow-list**: id, status, amount, externalRef, externalId, endToEndId, paidAt, fee_amount, net_amount, payerMatchesCustomer. Nunca `customer` |

- **`get(ref)`** faz `GET /payments/transactions/{providerChargeId}`. Se a linha não tiver
  `providerChargeId` (falha entre o POST e a gravação), cai para
  `GET /payments/transactions?sellerExternalRef=<externalId>`.
  - 404 vira `PixGatewayError(status 404)`, e a reconciliação já trata.
- **`cancel(ref)`** faz `POST /payments/transactions/{id}/cancel` e devolve a cobrança relida.
  O QR continua pagável, e um `PAID` tardio cai no caminho que já existe: crédito ou `needs_review`
  (o mesmo da SpacePay, tarefa B5 do escopo dela).
- **Robustez** (igual a `upperRequest`):
  - timeout de 15 s;
  - nova tentativa só em erro de rede, 5xx e 429, com a **mesma** `Idempotency-Key`;
  - 200 e 201 são sucesso;
  - a mensagem de erro é higienizada (até 160 caracteres, sem chave nem corpo inteiro).
- **`isConfigured`**: `publicKey`, `secretKey` e `webhookSecret` preenchidos, e pagador completo.

### 2.3 Webhook `POST /api/public/paganopay/webhook`

É uma rota nova (`src/routes/api/public/paganopay/webhook.ts`), no mesmo molde da rota da Upper. A
URL é única e vai cadastrada no painel da PaganoPay.

1. Lê o corpo cru e valida `X-Webhook-Signature` / `X-Webhook-Timestamp` contra **cada segredo**
   de `paganoPayWebhookSecrets()` (o atual, o anterior por 24 h e o do env, como em
   `upperWebhookSecrets`).
   - Assinatura inválida: **401** e sinal `paganopay_webhook_invalid_signature`.
   - Nenhum segredo configurado: 500.
2. Faz o parse e ignora (com **200**) eventos que não começam com `pix.`.
3. Grava em `payment_webhook_events` com `provider='paganopay'` e
   `event_id = "paganopay:<event>:<id>:<status>"`. O `raw_body` passa por `maskDocumentsDeep`.
   Evento já processado: 200.
4. Procura `payment_charges` por `provider='paganopay' and provider_charge_id = id`, ou por
   `external_id = external_ref`.
   - **Cobrança não encontrada: 200 e só registra.** A conta é a mesma da SpacePay, então o webhook
     do painel recebe **tudo** dela, inclusive as cobranças criadas pela SpacePay. Essas nunca são
     creditadas por este caminho: a cobrança SpacePay tem `provider='spacepay'` e só é conferida
     pelo próprio gateway.
5. `pix.confirmed` ou `pix.failed` chamam `confirmCharge(externalId)`, que relê pela API. **O corpo
   do webhook nunca credita sozinho.**
6. **Política de resposta.** É diferente da Upper por causa da pausa automática depois de 10 falhas
   seguidas:
   - Falha ao gravar o evento (banco fora): **503**, para haver nova tentativa.
   - Evento gravado e erro no processamento: **200**, com o erro gravado na linha do evento. O cron
     de 5 min reconcilia.
   - Assim um bug nosso não pausa o webhook e não perde os eventos da pausa.
7. O processamento corre contra um timer de ~3 s. Se passar, responde 200 e continua em segundo
   plano (padrão da SpacePay).

### 2.4 Conciliação

- `reconcilePendingCharges` já agrupa por provider: basta registrar `paganopay` no mapa `GATEWAYS`.
- **Sem varredura nova (revisto na implementação).** A conciliação que já existe cobre a pausa
  do webhook, consultando cobrança por cobrança:
  - as abertas (`PENDING`/`ACTIVE` há mais de 2 min) são conferidas a cada 5 min;
  - as encerradas sem crédito (`EXPIRED`/`FAILED`/`CANCELLED`) continuam sendo conferidas
    por **48 h**, então um QR "cancelado" que ainda assim foi pago é creditado;
  - a listagem da PaganoPay só é usada quando a linha não tem o id deles (busca por
    `sellerExternalRef`).

### 2.5 Expiração e reaproveitamento

- Respeita `expiresIn`: o top-up continua com 1 h e a fatura com 1 h a 7 d. O diálogo mostra
  `expiresAt` quando vier (a SpacePay já trouxe contagem regressiva e "Gerar novo Pix").
- `createInvoicePayment` só reaproveita um Pix aberto se for do provider ativo e não estiver perto
  de vencer (regra que já existe).
- Expirada do nosso lado: chama `cancel` (melhor esforço) e fecha a linha.

### 2.6 Pagador

A PaganoPay exige `customer` completo (nome, e-mail, telefone, CPF/CNPJ válido).

- **Decidido (2026-11-16):** usar **os mesmos dados de pagador já cadastrados para a SpacePay**
  (conta `spacepay` em `payment_gateway_accounts`, ou `SPACEPAY_PAYER_*` no env). Não há
  formulário para as casas nem dado pessoal novo.
- **Os dados são copiados, não referenciados.** A SpacePay vai ser apagada (2.11-5), então a conta
  `paganopay` guarda a própria cópia (`payerName`, `payerDocument`, `payerEmail`, `payerPhone`):
  - Ao abrir o formulário da PaganoPay no admin sem pagador salvo, os 4 campos vêm
    **pré-preenchidos com os da SpacePay**. O superadmin confere e salva.
  - O env `PAGANOPAY_PAYER_*` é só reserva. Se estiver vazio, a config lê `SPACEPAY_PAYER_*`
    enquanto ele existir.
  - Apagar a SpacePay não afeta a PaganoPay.
- O documento é validado (dígitos) ao salvar no admin, para não descobrir o erro só no primeiro Pix.
- **Pagador real:** vem em `payer` depois do pagamento e é gravado mascarado (`payer.ts`), como hoje.
  `payerMatchesCustomer` vai dar `false` quase sempre (pagador ≠ nosso CNPJ), e isso é esperado:
  não vira alerta.

### 2.7 QR code

`qrcodeUrl`/`qrcodeBase64` nem sempre vêm. Hoje o diálogo só mostra imagem se o gateway mandar URL
(`safePixImageSrc`). Por isso:

- Adicionar geração local do QR a partir do `emv` no cliente (lib `qrcode`, ~30 kB, só no
  componente do diálogo).
- Vale para todos os gateways quando `qrCodeImage` for nulo.
- Não precisa mexer na CSP: a imagem gerada é `data:`.

### 2.8 Taxa e financeiro

- Nova linha em `payment_fee_settings` com `provider='paganopay'`. O valor é cadastrado pelo
  superadmin depois de ler `GET /payments/fees` (Q4).
- O `fee_amount` real de cada cobrança fica na allow-list do snapshot. Usá-lo no financeiro no
  lugar da taxa cadastrada é **fase 2**, opcional.

### 2.9 Admin

- `payment-gateways-card.tsx` ganha a conta **PaganoPay** com estes campos:
  - chave pública;
  - chave secreta;
  - segredo do webhook;
  - os 4 dados do pagador;
  - a URL do webhook para copiar (`<PUBLIC_APP_URL>/api/public/paganopay/webhook`).
- **Testar conexão:** `GET /payments/fees` + `GET /payments/balance`. Mostra a tarifa e o saldo
  disponível, sem criar cobrança.
- Seletor de gateway ativo com `paganopay`.
- `pix-fee-form.tsx` e `billing-health-card.tsx` com o novo provider.
- Sinais em `billing-signals.server.ts`:
  - `paganopay_auth_error`;
  - `paganopay_unavailable`;
  - `paganopay_webhook_invalid_signature`;
  - `paganopay_dispute`;
  - `paganopay_not_found`.

### 2.10 Segurança

- **A chave secreta faz saque sem 2FA.** O que fazer:
  - guardar a chave só criptografada no banco, nunca em log, sinal ou snapshot;
  - nenhum código nosso referencia `/cash-out`, e um teste garante isso (grep no cliente);
  - pedir à PaganoPay uma chave **só de cash-in**, se existir (Q5);
  - configurar a IP Allowlist se o servidor tiver IP de saída fixo (Q6);
  - ligar 2FA no painel;
  - fazer saques manuais frequentes, para manter pouco saldo parado lá.
- O webhook não credita sem consultar a API (2.3-5) e confere o valor exato (regra que já existe).
- Responder 401 a assinatura inválida não deixa vazar se a cobrança existe.

### 2.11 Desligar a SpacePay (mesma conta PaganoPay)

A SpacePay acessa a mesma conta PaganoPay com um par de chaves dela, e provavelmente tem a própria
URL cadastrada como webhook no painel. A sequência:

1. **Chaves próprias.** Gerar um par de chaves **novo** na PaganoPay só para a Betleads. Não
   reaproveitar o par que a SpacePay usa, para poder revogar o dela depois.
2. **Webhook.** Ver no painel se a conta aceita mais de um webhook (Q8).
   - **Se aceitar:** cadastrar o nosso ao lado do da SpacePay.
   - **Se só houver um:** a troca da URL acontece **no passo 4**, porque antes disso os
     pagamentos da SpacePay ainda dependem do callback dela.
3. **Virada.** Mudar o gateway ativo para `paganopay` no admin. Daí em diante as cobranças novas
   saem pela PaganoPay direto.
4. **Esgotar a SpacePay.** Deixar a SpacePay configurada por **48 h**. A conciliação de 5 min
   continua lendo as cobranças `spacepay` abertas pelo próprio gateway, e os QRs dela vivem
   ~5 min. Depois disso:
   - conferir que não sobrou cobrança `spacepay` em `ACTIVE`/`PENDING`, nem com `PAID` não creditado;
   - se o webhook for único, trocar a URL para a nossa agora.
5. **Desligar.**
   - Antes de apagar, conferir que a conta PaganoPay já tem o pagador salvo (2.6).
   - Apagar as credenciais SpacePay no admin. Uma linha antiga que ainda apareça é fechada só do
     nosso lado, o que já existe.
   - Tirar `spacepay` do seletor de gateway ativo.
   - Pedir à SpacePay que pare de usar a conta, e **revogar o par de chaves dela no painel da
     PaganoPay**. Isso também reduz o risco de saque (2.10).
6. **Código.** O cliente e a rota da SpacePay ficam no repositório, inertes, porque as linhas
   históricas com `provider='spacepay'` ainda são lidas por recibo e financeiro. A remoção do código
   fica como tarefa futura opcional.

---

## 3. Migração SQL (uma, aditiva)

`supabase/migrations/<próximo número do main>_billing_paganopay_gateway.sql`:

- Recriar os CHECK de provider com `('upper','spacepay','paganopay')` em:
  - `payment_charges.provider`;
  - `payment_webhook_events.provider`;
  - `payment_gateway_accounts.provider`;
  - `payment_gateway_settings.active_provider`.
- `insert into payment_fee_settings (provider, …) select 'paganopay', … on conflict do nothing`,
  copiando a taxa vigente como ponto de partida, como fez a migração da SpacePay.
- Não altera nenhum dado existente. Aplicar **antes** do deploy do código: o código novo grava
  `provider='paganopay'`.

Teste PGlite: `billing-paganopay-gateway.db.test.ts`, que insere uma cobrança e um evento `paganopay`
e confere que a RPC de crédito usa a taxa do provider certo.

---

## 4. Variáveis de ambiente (reserva; o normal é configurar pelo admin)

```
BILLING_PIX_PROVIDER=upper              # upper | spacepay | paganopay — NOVAS cobranças
PAGANOPAY_API_BASE=https://www.paganopay.com/api
PAGANOPAY_PUBLIC_KEY=                   # pk_…
PAGANOPAY_SECRET_KEY=                   # sk_… (faz saque! só servidor)
PAGANOPAY_WEBHOOK_SECRET=               # segredo exibido em Integrações → Webhook
PAGANOPAY_PAYER_NAME=
PAGANOPAY_PAYER_DOCUMENT=               # CPF/CNPJ só dígitos
PAGANOPAY_PAYER_EMAIL=
PAGANOPAY_PAYER_PHONE=                  # DDD + número, só dígitos
```

Atualizar `.env.example`.

---

## 5. Tarefas

| # | Tarefa | Arquivos |
|---|---|---|
| A1 | `PixProvider` + `isPixProvider` + mapa `GATEWAYS` com `paganopay` | `pix-gateway-error.ts`, `pix-gateway.server.ts` |
| A2 | Cliente PaganoPay + testes (fetch stub): criação 201/200-idempotente, mapa de status, 404, 429 com Retry-After, allow-list do `raw` | `paganopay-pix.server.ts(.test)` |
| A3 | Migração aditiva + teste PGlite | `supabase/migrations/…`, `billing-paganopay-gateway.db.test.ts` |
| A4 | Config: env + conta no banco + segredos do webhook (atual/anterior/env) + validação do pagador + pré-preenchimento do pagador a partir da SpacePay (2.6) | `payment-gateway-config.server.ts(.test)` |
| B1 | Webhook assinado + política de resposta 2.3 + testes (assinatura ok/errada/antiga, evento alheio, duplicado, ordem invertida) | `routes/api/public/paganopay/webhook.ts`, `paganopay-webhook.ts(.test)` |
| B2 | Status de contestação/estorno → `needs_review` + sinal | `payment-charges.server.ts` |
| ~~B3~~ | ~~Varredura diária pela listagem~~ — desnecessária (2.4) | — |
| C1 | QR local a partir do EMV (todos os gateways) | `pix-payment-dialog.tsx`, `package.json` |
| C2 | Admin: conta PaganoPay, Testar conexão (fees + balance), URL do webhook, seletor, taxa, saúde | `payment-gateways-card.tsx`, `payment-gateway-admin.functions.ts`, `payment-gateway-test.server.ts`, `pix-fee-form.tsx`, `billing-health*.ts`, `billing-signals.server.ts` |
| C3 | Referência do pagamento (`endToEndId`) no recibo | `payment-reference.server.ts` |
| D1 | `npm run build` + testes + typecheck; aplicar migração; deploy com o gateway ativo **sem mudar** | — |
| D2 | Homologação em produção: cadastrar chaves e webhook, Testar conexão, top-up **R$ 1,00** numa casa de teste (exigiria baixar o mínimo de R$ 100 só para ela, ou pagar R$ 100 e estornar no painel), conferir webhook → crédito → recibo; repetir com uma fatura | — |
| D3 | Virar o gateway ativo para `paganopay` no admin (2.11 passos 1–3) | — |
| D3b | Desligar a SpacePay: esgotar 48 h, trocar o webhook se for único, apagar as credenciais, tirar do seletor, revogar as chaves dela no painel (2.11 passos 4–5) | `payment-gateways-card.tsx` (sem `spacepay` no seletor) |
| D4 | Runbook `docs/operacoes/RUNBOOK_ATIVAR_PIX_PAGANOPAY.md` (chaves, webhook, troca de segredo, IP, rollback = voltar o seletor) | — |

Ordem: A1→A2/A3/A4 (em paralelo) → B1–B2 → C1–C3 → D1→D4.

**Estado (2026-11-16):** A1–A4, B1, B2, C1–C3 e o build (parte do D1) estão feitos na branch
`feat/paganopay`, ainda sem commit. Migração `20261231101300_billing_paganopay_gateway.sql` **não
aplicada**. Faltam: aplicar a migração, deploy, D2 (homologação), D3/D3b (virada e desligar a
SpacePay) e D4 (runbook).

**Rollback:** antes do D3b, voltar o seletor para `spacepay`. Depois do D3b, a SpacePay não
volta: o caminho é voltar para a Upper, se ela ainda estiver configurada, ou consertar a PaganoPay.
Nos dois casos, as cobranças PaganoPay abertas continuam sendo conferidas e creditadas pelo
próprio provider.

---

## 6. Perguntas em aberto

- ~~Q1. Pagador~~ → **decidido:** os mesmos dados já cadastrados para a SpacePay, copiados para a
  conta PaganoPay (2.6).
- ~~Q2. Conta PaganoPay~~ → **decidido:** é a mesma conta da SpacePay (2.3-4, 2.4, 2.11).
- ~~Q3. SpacePay~~ → **decidido:** fica desligada depois da virada (2.11).
- **Q4. Tarifa:** qual é a nossa (fixa + %)? Ela sai de `GET /payments/fees` depois de ter as
  chaves, e vai para `payment_fee_settings`.
- **Q5 (para a PaganoPay):** dá para emitir uma chave **só de cobrança** (sem saque)? Qual o prazo de
  expiração das chaves (`API Key expirada` existe)?
- **Q6. Infra:** o servidor do app tem IP de saída fixo para a IP Allowlist? Se não tiver, a
  allowlist fica vazia e valem as outras medidas de 2.10.
- **Q7 (para a PaganoPay):** qual o prazo real do QR no arranjo deles quando pedimos 7 dias
  (fatura)? E quais IPs saem os webhooks (para filtrar, opcional)?
- **Q8 (para a PaganoPay, ou ver no painel):** a conta aceita mais de um webhook no painel? Hoje a
  SpacePay deve ter o dela cadastrado. A resposta define quando o nosso entra (2.11-2).
