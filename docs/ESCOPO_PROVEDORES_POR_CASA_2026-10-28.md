# Escopo — Provedores por casa (SMS, e-mail, voz) — 2026-10-28

## Objetivo

Hoje existe um provedor global por canal (Short Brasil para SMS; Infobip para
e-mail e voz), configurado só por variáveis de ambiente. O super admin precisa
poder apontar uma casa para uma conta de provedor específica, por canal. Sem
configuração, a casa continua no provedor padrão da plataforma.

## Decisões

| Tema | Decisão |
|---|---|
| Dono das contas | BetLeads. A casa continua pagando pela carteira; billing não muda. |
| Fallback para o padrão se a conta da casa cair | Não. Só aquela casa pausa. |
| Infobip SMS | Fica para depois (Fase 4). Schema já aceita. |
| Contas por canal | Uma por `(casa, canal)`. Várias casas podem compartilhar a mesma conta. |
| Visibilidade | A casa nunca vê nome de fornecedor (regra de `provider-governance.server.ts`). |

## Modelo

- `provider_accounts`: uma linha por conta (`provider`, `label`, `channels`,
  `credentials_source` = `env` | `db`, `credentials_encrypted` AES-GCM,
  `config` jsonb, `status`).
- `tenant_channel_providers`: `(tenant_id, channel) → provider_account_id`.
  Sem linha = padrão. Trigger garante que a conta atende o canal.
- `provider_account_id` (nullable, sem FK) em `sms_send_logs`,
  `email_send_logs`, `call_history`. `null` = envio legado pela conta padrão.

As contas padrão são duas linhas com ids fixos e `credentials_source='env'`
(`Short Brasil (padrão)` para SMS, `Infobip (padrão)` para e-mail e voz): continuam
lendo as variáveis de ambiente atuais, então nenhum segredo precisa ser migrado.
Trocar o padrão da plataforma para uma conta do banco fica para a Fase 3, se
precisar.

### Comportamento do resolver (`src/lib/provider-accounts.server.ts`)

- Snapshot das duas tabelas em memória por 30 s (são pequenas).
- Conta da casa desativada, ilegível, inexistente, de outro canal ou de provedor
  sem suporte (Infobip SMS): o envio falha como `misconfigured`, nada é enviado.
  **Sem fallback para a conta padrão.**
- Erro ao **ler** as tabelas (banco fora): usa o último snapshot; sem nenhum,
  a conta padrão. Isso é falha de leitura, não da conta.
- E-mails da plataforma (billing, DNS) não têm casa e usam sempre o padrão.

## Status

- **Fase 1: implementada** (main, 2026-10-28)
  (migration `20261108100000_provider_accounts.sql`). Sem mudança de
  comportamento enquanto nenhuma casa tiver linha em `tenant_channel_providers`.
  O bulk de SMS já agrupa por conta.
  Pendências que ficam para a Fase 2: `campaignDeps` decide bulk vs. envio
  individual pela conta padrão; status/health exibidos para a casa olham a conta
  padrão.

## Fases

1. **Fundação (sem mudança visível).** Schema, cofre de credenciais
   (`PROVIDER_CREDENTIALS_ENCRYPTION_KEY`), resolver
   `resolveChannelAccount(tenantId, channel)` e adapters recebendo a conta por
   parâmetro em vez de ler `process.env`. Envios gravam `provider_account_id`.
2. **Runtime por conta.** Circuit breaker e throttle chaveados por conta;
   bulk/campanhas agrupando por conta; webhooks com `?account=<id>` + segredo
   por conta (fallback por `provider_message_id`); refresh de status de SMS e
   reconciliação de voz por conta; domínios de e-mail sabendo em que conta
   Infobip estão.
3. **Tela do super admin.** CRUD de contas, "Testar conexão", aba Provedores na
   config da casa, auditoria em `tenant_audit_logs`.
   **Não liberar antes da Fase 2**: sem breaker por conta, falta de saldo na
   conta de uma casa pararia o SMS de todas.
4. **Infobip SMS.** Novo adapter.

## Riscos conhecidos

- Domínios de e-mail pertencem à conta Infobip: trocar a conta de e-mail de uma
  casa exige recadastrar/verificar domínios na conta nova.
- Campanhas em andamento ao trocar de conta: novos envios usam a conta nova; o
  que já foi enviado é reconciliado pela conta gravada no log.
