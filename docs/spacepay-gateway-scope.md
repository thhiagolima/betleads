# Escopo — Gateway SpacePay (Space Payment Proxy) ao lado da Upper

Data: 2026-11-12 · Fonte: https://share.apidog.com/7e72ceb8-ca99-4c59-ae21-444112d0b03f (llms.txt)

**Decisões (2026-11-12):** gateway único para todas as casas via `BILLING_PIX_PROVIDER`; pagador
fixo nosso (env `SPACEPAY_PAYER_*`, sem colunas em `tenant_billing` nem formulário — a seção 3.7 e a
tarefa C1 ficam fora); PSP por trás do token = **PaganoPay**.

Objetivo: receber **mensalidades** (`billing_invoices`) e **compras de saldo** (`credit_topup_orders`)
via Pix pelo SpacePay, **sem remover a Upper**. Cada cobrança fica presa ao gateway em que nasceu
(`payment_charges.provider`), então as duas convivem.

---

## 1. O que é o SpacePay (resumo da doc)

É um **proxy** na frente de vários PSPs Pix (monetipag, magnum, seu7pay, flash, paganopay, simplify,
upper). Nós somos a "casa". O PSP real é decidido pelo **token** que o SpacePay gera para nós.

Base: `https://integration.prod.spacedev.pro` (só produção documentada; credenciais `sk_test_…` são
citadas mas sem ambiente de teste descrito).

| Uso para nós | Endpoint | Auth |
|---|---|---|
| Criar Pix | `POST /create_gateway_cash_in` | `Authorization: Bearer <GatewayBearer>` |
| Consultar (fonte da verdade) | `GET /transactions/{id}` | doc diz `security: []`; 404 "de outra casa" sugere CasinoToken |
| Reconciliação | `GET /transactions?type=cash_in&status=…&from=&to=&page=&perPage≤100` | CasinoToken (inferido) |
| Imagem do QR | `GET /qr/{transaction_id}.png` | pública, cache 1 dia |
| Gerar token | `POST /create_gateway_token` (header `x-admin-secret`) | **feito pelo SpacePay**, não por nós |

**Header obrigatório não documentado: `X-Platform-Id`.** Toda chamada (`POST /create_gateway_cash_in`,
`GET /transactions`, `GET /transactions/{id}`) exige o header `X-Platform-Id: <platformId>`. O valor
vem do `POST /create_gateway_token` da SpacePay (o mesmo que emite o nosso token do gateway); ainda
não sabemos se é o próprio token emitido ou um campo separado da resposta. Por isso o `platformId`
é **opcional**: quando configurado, ele é enviado; em branco, enviamos o próprio token do gateway.
Sem o header:
HTTP 400 `Header X-Platform-Id é obrigatório`; com um valor desconhecido: HTTP 404
`Cassino não encontrado para o platformId informado`. No nosso cliente esse 404 vira o código
`PLATFORM_NOT_FOUND` (sinal `spacepay_unauthorized`) e **nunca** é lido como "cobrança não
encontrada": a reconciliação não marca cobrança como FAILED por causa dele. Configuração:
`platformId` nas credenciais do admin (opcional, pode ser apagado), ou `SPACEPAY_PLATFORM_ID` no
ambiente (opcional).

**Corpo real dos erros** (a doc descreve `{statusCode, timestamp, path, message, detail}`, mas a API
responde):
```json
{"success": false, "message": "Requisição inválida", "data": {"errors": ["Header X-Platform-Id é obrigatório"]}}
```
Só a primeira entrada de `data.errors` (higienizada, até 160 caracteres, sem tokens) entra na
mensagem do erro e no "Testar conexão"; o resto do corpo nunca é guardado nem logado.

**Cash-in — request** (todos obrigatórios exceto `ip_address`):
`document` (CPF/CNPJ), `email`, `name`, `amount` (**reais**, 2 casas), `webhook` (URL https nossa),
`idempotency_key` (1–255, repetida no mesmo gateway → **409**), `phone` (10–13 dígitos),
`ip_address` (opcional, "exigido na prática pelo Monetipag").

**Cash-in — response 200:** `transaction_id` (uuid do proxy), `idempotency_key`, `copy_paste` (EMV),
`qr_code` (URL), `expiration_time` (**padrão created_at + 5 min** se o PSP não informar), `status: created`,
`currency: BRL`, `created_at`, `paid_at: null`.

**Status da transação:** `created`, `paid`, `refunded`, `expired`, `failed`, `callback_failed`.

**Callback para a casa:** o proxy faz `POST <webhook>` quando o pedido vira `paid`, **uma única vez**.
Se a nossa resposta falhar, o proxy faz rollback e o pedido volta a pendente.
**Não documentado:** formato do payload (só "com `paid_at`"), assinatura/HMAC, retentativas.

**Não existe:** cancelamento de cobrança, parâmetro de expiração no request, descrição/metadata livre.

---

## 2. Como está a Upper hoje (pontos de acoplamento)

O modelo de dados já é quase genérico (`payment_charges.provider` e `payment_fee_settings.provider`
existem, default `'upper'`; a RPC `billing_credit_paid_charge` não tem lógica de gateway). O que está
**preso à Upper**:

- Import direto de `createUpperCharge`/`getUpperCharge`/`cancelUpperCharge` em
  `src/lib/billing/topup.functions.ts`, `src/lib/billing/invoices.server.ts`,
  `src/lib/billing/payment-charges.server.ts`.
- Literais `provider: "upper"` — `topup.functions.ts:203`, `invoices.server.ts:446`,
  `billing-admin.functions.ts:814`.
- `recordChargeSnapshot(chargeId, UpperCharge)` recebe o tipo da Upper.
- `reconcilePendingCharges` **não filtra por provider** — mandaria cobranças SpacePay para a Upper.
- `payment_webhook_events.event_id` é PK global, sem coluna de provider.
- Sinais/health `upper_*` (`billing-health.server.ts`), `payment-reference.server.ts` lê `endToEndId`
  do payload Upper.
- `isUpperConfigured()` decide se o checkout aparece (`topup.functions.ts:71`, `invoices.server.ts:45`).

---

## 3. Arquitetura proposta

### 3.1 Interface `PixGateway`
Novo `src/lib/billing/pix-gateway.server.ts`:

```ts
type PixGatewayId = "upper" | "spacepay";
interface NormalizedCharge {
  providerChargeId: string; status: "PENDING"|"ACTIVE"|"PAID"|"EXPIRED"|"CANCELLED"|"FAILED";
  amountCents: number; emv: string|null; qrCodeImage: string|null; paymentUrl: string|null;
  expiresAt: string|null; paidAt: string|null; endToEndId: string|null; raw: unknown;
}
interface PixGateway {
  id: PixGatewayId;
  isConfigured(): boolean;
  create(input: { amountCents; externalId; description; expiresIn; payer: Payer; ip?: string }): Promise<NormalizedCharge>;
  get(charge: { providerChargeId; externalId }): Promise<NormalizedCharge | null>; // null = 404
  cancel?(charge): Promise<void>;     // SpacePay não tem → ausente
}
getGateway(id) / activeGatewayForNewCharges()
```

- `upper-pix.server.ts` ganha um adapter fino (sem mudar comportamento; testes atuais seguem verdes).
- `spacepay-pix.server.ts`: cliente novo (timeout, retry só em erro de rede/5xx com a **mesma**
  `idempotency_key`, `recordBillingSignal` em 401/403, conversão centavos↔reais).
- Mapeamento SpacePay → status interno:
  `created`→`ACTIVE` · `paid`→`PAID` · `expired`→`EXPIRED` · `failed`→`FAILED` ·
  `refunded`→`needs_review` (alerta) · `callback_failed`→continua `ACTIVE` e **re-consulta**
  (ver pergunta Q4).

### 3.2 Escolha do gateway
- Novas cobranças usam o gateway ativo: config `BILLING_PIX_PROVIDER=upper|spacepay` (env) — ou
  tabela/setting editável pelo superadmin (ver Q1). Upper continua default.
- Cobranças existentes **sempre** são consultadas/reconciliadas pelo seu próprio `provider`.
- Reaproveitamento de cobrança aberta (`createInvoicePayment`) só reaproveita se o provider for o
  ativo **e** não estiver perto de expirar.

### 3.3 Webhook SpacePay
Rota nova `src/routes/api/public/spacepay/webhook.$token.ts`
→ URL enviada no cash-in: `https://<app>/api/public/spacepay/webhook/<token>`, onde
`token = base64url(externalId) + "." + HMAC_SHA256(SPACEPAY_CALLBACK_SECRET, externalId)`.

- Como o proxy **não assina** o callback, a autenticidade vem do token na URL (por cobrança,
  não adivinhável, sem dado pessoal) **e** de sempre reconsultar `GET /transactions/{id}` antes de creditar
  (mesmo padrão "webhook é só dica" da Upper).
- Grava em `payment_webhook_events` (event_id = `spacepay:<transaction_id>:<status>`) antes de processar;
  `raw_body` passa por `maskDocumentsDeep` (mascara chaves tipo `document`/`cpf`/`cnpj`/`taxId`; como o
  formato é não documentado, nome do pagador ou documento sob outra chave ainda podem ficar no `raw_body`).
- `payment_charges.last_provider_payload` do SpacePay é uma **allow-list** (id, status, amount, datas,
  idempotencyKey, externalId, gateway, type, endToEndId) — nunca `payload`, `history` nem `callbackUrl`
  (que tem o token secreto).
- Resposta em até **3 s**: o processamento corre contra um timer; se passar, respondemos 200 e ele
  continua em segundo plano (resultado/erro gravado na linha do evento; o cron cobre o resto).
- **Atenção à semântica do proxy:** se respondermos erro, ele desfaz o "pago" do lado dele. Então:
  token válido + evento gravado → **200** mesmo que o crédito falhe depois (o cron reconcilia).
  Só respondemos não-2xx quando o token é inválido.

### 3.4 Reconciliação (`billing-reconcile.ts`)
- `reconcilePendingCharges` passa a agrupar por `provider` e chamar `getGateway(provider).get(...)`.
- SpacePay: 404 após 15 min → `FAILED` (`spacepay_not_found`); `ACTIVE` passado do `expires_at` + 10 min
  → re-consulta e expira.
- Varredura extra (opcional, fase 2): `GET /transactions?status=paid&dateField=paidAt&from=…` das
  últimas 48 h, cruzando `id` com `payment_charges.provider_charge_id` — pega pagamentos cujo callback
  se perdeu.

### 3.5 Expiração (impacto grande)
O SpacePay **não aceita** `expiresIn`; o QR pode valer só **~5 min** (depende do PSP por trás).
Hoje a fatura gera QR de 1h–7d e o top-up de 1h. Consequências:
- O diálogo `pix-payment-dialog.tsx` precisa mostrar contagem regressiva e botão **"Gerar novo Pix"**
  quando expirar (nova `idempotency_key` = `externalId` + tentativa).
- Pagamento de QR já expirado que mesmo assim cair (`paid` tardio) → crédito normal pela RPC
  (charge ainda é nossa) — validar com a RPC que hoje recusa charge `EXPIRED`? (ver tarefa B5).

### 3.6 Cancelamento
Sem endpoint de cancelamento. `cancelOpenInvoiceCharges` passa a apenas marcar `CANCELLED`
localmente para SpacePay — antes, uma consulta fresca: se já estiver `PAID`, registra e confirma
(e `createInvoicePayment` responde "fatura já paga" em vez de gerar outro Pix). Linha de um gateway
não mais configurado (ex.: `UPPER_API_KEY` removida) também é fechada só localmente. Se um `paid` chegar depois de cancelada → `needs_review` (já existe fila
em `billing-review-list.tsx`).

### 3.7 Dados do pagador (novo requisito)
A Upper não pede pagador; o SpacePay exige **CPF/CNPJ, e-mail, nome, telefone**. `tenants` não tem
CNPJ nem telefone de cobrança. Proposta: colunas em `tenant_billing`
(`payer_document`, `payer_name`, `payer_email`, `payer_phone`), formulário em **Plano e créditos**
(obrigatório antes do primeiro Pix SpacePay) e edição pelo superadmin. Documento salvo completo só
nessa tabela (RLS restrita); em `payment_charges` continua só `payer_document_masked`. Ver Q3.
`ip_address`: enviar o IP do usuário da requisição (server fn) quando houver; no fluxo sem request, omitir.

### 3.8 QR code
`qr_code` é URL https (do PSP ou `/qr/{id}.png` do proxy) → já passa em `safePixImageSrc`. Verificar
CSP `img-src` se houver. Fallback: gerar QR local a partir do `copy_paste` (lib `qrcode`) se a URL falhar.

### 3.9 Taxa
`payment_fee_settings` ganha linha `provider='spacepay'`. `adminSetPixFee`/`pix-fee-form.tsx` ganham
seletor de provider (hoje hardcoded `upper`).

### 3.10 Observabilidade
Sinais `spacepay_auth_error`, `spacepay_webhook_invalid_token`, `spacepay_not_found`;
`billing-health-card.tsx` mostra saúde por provider. O E2E do SpacePay é extraído do
`history[].payload` no parse (`spacepay-pix.server.ts`) e gravado como `endToEndId` na allow-list;
`payment-reference.server.ts` lê esse campo (com fallback no `history` para linhas antigas).
`refunded` vira `FAILED`; se a cobrança já estava paga/creditada, `confirmCharge` marca `needs_review`.

### 3.11 Operação
- **Aplicar a migração antes do deploy do código**: o webhook da Upper passa a gravar
  `payment_webhook_events.provider`; código novo sem a coluna quebra o webhook da Upper.
- **Manter `UPPER_API_KEY`** depois de virar para SpacePay, até as cobranças Upper antigas
  (abertas ou em reconciliação, janela de 48 h) se esgotarem. Sem a chave, faturas com Pix Upper
  aberto são fechadas só localmente e um pagamento tardio na Upper não é mais conferido.
- **Trocar `SPACEPAY_CALLBACK_SECRET` ou `PUBLIC_APP_URL` invalida os callbacks em voo** (o token
  da URL foi assinado com o segredo/URL antigos; QRs vivem ~5 min). Fazer em horário calmo; os
  pagamentos afetados ficam para o cron de reconciliação (5 min).
- Respostas do SpacePay (2026-11-12):
  - **Timeout do callback: 15 min.** A resposta em até 3 s fica como margem, não como necessidade.
  - **`amount` é bruto** (R$ 100 pagos → `amount` 100; a taxa sai à parte no repasse). A conferência
    `paid_amount_cents === amount_cents` vale como está.
  - **Estorno é avisado.** Se chegar no mesmo webhook, `confirmCharge` relê, vê `refunded` e marca
    `needs_review` (`flagRefundedPaidCharge`).

---

## 4. Migração SQL (uma, aditiva)

`supabase/migrations/2026111xxxxxxx_billing_spacepay_gateway.sql`
- `payment_charges.provider` CHECK `in ('upper','spacepay')`; índice `(provider, status)`.
- `payment_charges.idempotency_attempt int default 0` (para regerar QR).
- `payment_webhook_events.provider text not null default 'upper'`.
- `tenant_billing` + colunas de pagador (3.7).
- `insert into payment_fee_settings (provider, …) values ('spacepay', …) on conflict do nothing`.
- Revisar `billing_credit_paid_charge` só se B5 confirmar que precisa aceitar `EXPIRED/CANCELLED → PAID`.

Sem alterar dados existentes; Upper continua idêntica.

---

## 5. Variáveis de ambiente

```
BILLING_PIX_PROVIDER=upper            # gateway para NOVAS cobranças
SPACEPAY_API_BASE=https://integration.prod.spacedev.pro
SPACEPAY_GATEWAY_TOKEN=               # JWT GatewayBearer (gerado pelo SpacePay, não expira)
SPACEPAY_CASINO_TOKEN=                # se /transactions exigir (Q2)
SPACEPAY_PLATFORM_ID=                 # opcional: header X-Platform-Id (em branco = o token do gateway)
SPACEPAY_CALLBACK_SECRET=             # nosso, para assinar a URL do webhook
```
O GatewayBearer **não expira** e carrega as credenciais do PSP → tratar como segredo de produção,
rotação combinada com o SpacePay.

---

## 6. Tarefas

| # | Tarefa | Arquivos |
|---|---|---|
| A1 | Interface `PixGateway` + adapter Upper (refactor sem mudar comportamento) | `pix-gateway.server.ts`, `upper-pix.server.ts` |
| A2 | Cliente SpacePay + testes (fetch stub) | `spacepay-pix.server.ts(.test)` |
| A3 | Migração aditiva + teste PGlite | `supabase/migrations/…`, `*.db.test.ts` |
| B1 | Top-up e fatura usam `getGateway(active)`; remover literais `"upper"` | `topup.functions.ts`, `invoices.server.ts` |
| B2 | `recordChargeSnapshot` / `confirmCharge` genéricos (por provider) | `payment-charges.server.ts` |
| B3 | Webhook SpacePay com token na URL + reconsulta | `routes/api/public/spacepay/webhook.$token.ts` (+ teste) |
| B4 | Reconcile por provider + 404/expiração SpacePay | `payment-charges.server.ts`, `billing-reconcile.ts` |
| B5 | Pagamento tardio/cancelado → crédito ou `needs_review` | RPC / `payment-charges.server.ts` |
| C1 | Dados do pagador: colunas, formulário, validação CPF/CNPJ/telefone | `tenant_billing`, `plano-e-creditos.tsx` |
| C2 | Diálogo Pix: contagem regressiva + "Gerar novo Pix" | `pix-payment-dialog.tsx` |
| C3 | Admin: taxa por provider, gateway ativo, health por provider | `pix-fee-form.tsx`, `billing-health*.ts` |
| D1 | Homologação em produção com valor baixo (R$ 1,00) top-up + fatura | — |

Ordem: A1→A2/A3 (paralelo) → B1–B5 → C1–C3 → D1. Liberar com `BILLING_PIX_PROVIDER=upper` no deploy e
virar para `spacepay` só após D1.

---

## 7. Perguntas para o SpacePay / decisões em aberto

- **Q1.** Troca de gateway: global por env, setting no admin, ou **por tenant**?
- **Q2.** `GET /transactions/{id}` e `GET /transactions` aceitam o GatewayBearer ou exigem
  CasinoToken? A doc marca `security: []` mas cita 401/403/"de outra casa".
- **Q3.** Quem é o pagador da mensalidade: o tenant (CNPJ da operação) ou um dado fixo nosso?
  Temos esses dados hoje?
- **Q4.** Formato exato do callback para a casa (campos, headers), se há assinatura, retentativas
  e o que significa `callback_failed` (o PSP recebeu e nós não?).
- **Q5.** Qual PSP estará por trás do nosso token e qual a validade real do QR (5 min é o padrão)?
- **Q6.** Existe sandbox (`sk_test_…`)? Valor mínimo/máximo? Há estorno (`refunded`) iniciado por eles?
- **Q7.** Lista de IPs de saída do proxy (para restringir o webhook, opcional).
