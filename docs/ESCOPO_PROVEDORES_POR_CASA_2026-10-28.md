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
- **Fase 3: implementada** (Admin → Integrações, abaixo das contas padrão):
  - **Contas de provedor**: criar/editar (credenciais só de escrita, cifradas;
    campo em branco mantém o valor), ativar/desativar (as duas contas padrão
    são somente leitura) e **Testar**: Infobip consulta o saldo
    (`/account/1/balance`); Short Brasil, sem consulta de saldo, envia 1 SMS de
    teste para um celular informado (não cobrado da casa).
  - **Provedor por casa**: por canal, "Padrão da plataforma" ou uma conta ativa
    que atende o canal. Confirmação avisa que não há troca automática; no
    e-mail, os domínios da casa são recadastrados na conta nova na hora e
    voltam a `pending`.
  - Regras no servidor (`provider-accounts-admin.server.ts`): só super admin;
    Infobip só e-mail/voz (SMS é Fase 4), Short Brasil só SMS; não remove de
    uma conta um canal que alguma casa usa; tudo em `admin_audit_logs` sem
    credenciais. A troca vale na hora na instância que atendeu e em até 30 s
    nas demais.
- **Fase 2: implementada** (main `2933cc4`, migration
  `20261113100000_provider_accounts_runtime.sql`):
  - **Breaker de SMS por conta.** Chave `sms` = conta padrão (a linha de sempre,
    que também alimenta o heartbeat `sms_provider`); `sms:<provider_account_id>`
    = conta própria. `SmsAccountGates` (`src/lib/sms-account-gates.server.ts`)
    decide por item, pela conta da casa, em fluxos, jornadas e campanhas; o
    envio avulso de campanha também consulta o breaker da conta da casa.
    Jornadas excluem do claim só as casas de contas bloqueadas.
  - **Throttle/pausa global** (429, 401/403, sem saldo) só quando o erro vem da
    conta padrão. Conta própria: só o lead/item daquela casa recua (SMS e e-mail).
  - **Campanhas**: bulk vs. individual decidido pela conta da casa da campanha.
  - **Domínios de e-mail**: `tenant_domains.provider_account_id` (NULL = conta
    padrão). Refresh com a conta da casa diferente da do domínio recadastra na
    conta nova (fica `pending`: DKIM muda) e remove da antiga (best effort); o
    job de verificação trata esse caso como vencido na hora. Purge apaga da conta
    do domínio. `resolveSender` só aceita domínios da conta atual da casa.
  - **Status exibido à casa** (`smsProviderStatus`, `getEmailProviderStatus`,
    observabilidade por canal) olha as contas da casa e o breaker da conta dela.

  Decisões da Fase 2:
  - **Webhooks sem segredo por conta.** Todas as contas são da BetLeads: o
    painel de cada conta aponta para a mesma URL com o segredo da plataforma, e
    os callbacks casam pelo `provider_message_id`/correlation já gravados.
  - **Nenhum job chama o provedor com credencial**: reconciliação de SMS, e-mail
    e voz só lê o banco (status chega por callback); o polling de voz em
    `call-flows.server.ts` está desligado. Nada a ajustar por conta.
  - **Limitação conhecida**: o backoff de 429 da conta padrão (`dispatch_rate_state`
    canal `sms`) ainda segura o tick inteiro do dispatcher de fluxos por alguns
    segundos, inclusive casas em conta própria. Só recua; não falha nem gasta
    tentativa.

## Fases

1. **Fundação (sem mudança visível).** Schema, cofre de credenciais
   (`PROVIDER_CREDENTIALS_ENCRYPTION_KEY`), resolver
   `resolveChannelAccount(tenantId, channel)` e adapters recebendo a conta por
   parâmetro em vez de ler `process.env`. Envios gravam `provider_account_id`.
2. **Runtime por conta.** Circuit breaker e throttle chaveados por conta;
   bulk/campanhas agrupando por conta; domínios de e-mail sabendo em que conta
   Infobip estão; status da casa pela conta dela (detalhes em Status).
3. **Tela do super admin.** CRUD de contas, "Testar conexão", aba Provedores na
   config da casa, auditoria em `tenant_audit_logs`. Ao trocar a conta de e-mail
   de uma casa, chamar `refreshTenantDomain` dos domínios dela (migra na hora e
   mostra os DNS novos) e avisar que eles voltam a `pending`.
4. **Infobip SMS.** Novo adapter.

## Riscos conhecidos

- Domínios de e-mail pertencem à conta Infobip: trocar a conta de e-mail de uma
  casa recadastra os domínios na conta nova automaticamente, mas a casa precisa
  publicar os DNS novos; até verificar, o e-mail da casa fica bloqueado
  (`EMAIL_DOMAIN_NOT_VERIFIED`).
- Campanhas em andamento ao trocar de conta: novos envios usam a conta nova; o
  que já foi enviado é reconciliado pela conta gravada no log.
