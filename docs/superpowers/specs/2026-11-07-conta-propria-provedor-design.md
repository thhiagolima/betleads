# Conta própria de provedor por casa — design (2026-11-07)

Continuação de `docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md` e de
`docs/superpowers/specs/2026-11-05-contas-padrao-canais-por-casa-design.md`.

## 1. Intenção e porquê

A **99Bet** (slug `99bet`, id `b5c4fec6-3adf-412d-868e-0bc18ad1b7c6`, plano
pago `crm_unico`) é a dona da rota de SMS que a BetLeads usa. Hoje ela envia
pela rota da BetLeads e paga o preço de venda por SMS, ou seja, compra a
própria rota com margem. Ela quer enviar pela conta dela, pagar o custo direto
ao provedor e continuar usando o CRM inteiro (jornadas, campanhas, bulk,
links rastreados, resultados).

Regra geral: **o super admin libera, por casa e por canal, o uso de conta
própria**. Liberado, o **admin da casa** cadastra a conta dele. A BetLeads
cobra uma **taxa mensal de uso do canal** (pode ser zero) e não cobra por
envio nesse canal.

A 99Bet é a primeira casa e o canal é SMS. Ela usa uma **conta própria na
Short Brasil, separada** da conta que a BetLeads usa para as outras casas
(credenciais, saldo e URL de retorno próprios). Requisito do design: uma conta
com dono nunca é a mesma conta real de uma conta da plataforma. O modelo vale para qualquer casa e
para os canais `sms`, `email` e `voice`.

## 2. Objetivos, não objetivos, anti-objetivos

**Objetivos**
- O super admin libera ou revoga "conta própria" por casa x canal e define a
  taxa mensal (centavos, >= 0).
- O admin da casa cadastra, testa, substitui e remove a própria conta, sem que
  as credenciais passem pela BetLeads.
- Envio pela conta própria: nenhum débito na carteira; todo o resto registra
  igual a hoje (logs, status, links, cliques, jornadas, histórico do lead).
- A taxa mensal entra na fatura mensal existente.
- Na Central de resultados da casa, o custo do SMS enviado pela conta própria
  usa o custo por SMS que o admin da casa informa.

**Não objetivos (nesta fase)**
- Web push (OneSignal): fora. Trocar o app zera a audiência.
- Provedor genérico/HTTP livre: fora. Só os provedores já suportados:
  Short Brasil (SMS) e Infobip (SMS, e-mail, voz).
- Fallback automático da conta da casa para a rota da BetLeads: não existe.

**Anti-objetivos (seria falha mesmo funcionando)**
- Alguém da BetLeads (inclusive super admin) ver ou receber as credenciais da
  casa pela aplicação.
- A conta de uma casa afetar o envio, a fila ou os callbacks de outra casa.
- A casa conseguir forjar eventos de entrega/voz/e-mail de outra casa.
- Cobrança dupla (taxa mensal + por envio no mesmo canal) ou envio pela rota
  da BetLeads sem cobrança.

## 3. Decisões do usuário (como decididas)

| Tema | Decisão |
|---|---|
| Quem cadastra credenciais | O admin da casa. O super admin nunca recebe nem vê. |
| Visibilidade das credenciais | Só escrita, para todos. Depois de salvas, só substituir. |
| Cobrança | Taxa mensal de uso do canal, configurável por casa x canal, pode ser zero. Envio pela conta própria não debita a carteira. Canais que seguem na rota BetLeads cobram como hoje. |
| Onde a taxa é cobrada | Como item da fatura mensal existente, no mesmo vencimento. Começa no ciclo seguinte à liberação (sem pró-rata). |
| Fatura não paga | Vale o bloqueio da casa inteira que já existe. Sem bloqueio separado do canal. |
| Revogação | O canal da casa pausa e a equipe da casa vê o aviso "Ciente". O super admin decide depois: voltar para a padrão ou manter pausado. Sem volta automática. |
| Provedores | Só os suportados (Short Brasil, Infobip). |
| Web push | Fora. |
| Registro | Tudo continua registrando no banco como hoje. |
| Custo na Central | O admin da casa informa o custo por SMS da conta dele; a Central usa esse valor nos envios pela conta própria. |
| Casa isenta (`interno`) | Não se aplica à 99Bet (plano pago). Ver seção 10. |

Garantia honesta sobre credenciais (comunicada ao usuário): o servidor precisa
decifrá-las para enviar; quem tem a infraestrutura (banco + chave
`PROVIDER_CREDENTIALS_ENCRYPTION_KEY`) poderia tecnicamente ler. A garantia é
"nenhuma pessoa vê pela aplicação, e tudo fica auditado".

## 4. Estado atual relevante (origin/main edaa0cb)

- `provider_accounts` (sem dono; comentário "todas da BetLeads"),
  `tenant_channel_providers` (casa x canal -> conta; sem linha = padrão),
  `platform_channel_defaults`, `tenant_channels` (ligado/desligado),
  `tenant_channel_notice_acks`. Só `service_role`.
- Credenciais cifradas AES-GCM (`src/lib/secret-box.server.ts`), só escrita.
- Breaker por conta (`sms:<account_id>`), pausa só da casa em erro de conta
  própria (`src/lib/sms-account-gates.server.ts`).
- Todo CRUD de conta exige super admin
  (`src/lib/provider-accounts-admin.server.ts`, `assertSuperAdmin`).
- Cobrança por envio: tudo termina em `wallet_reserve` (SQL, versão atual em
  `20261210100100_webpush_billing_item.sql`), que já zera o valor para casa
  isenta via `billing_effective_price`. A conta da casa é resolvida
  **depois** do reserve em `sendSmsInternal` (`src/lib/sms.functions.ts`,
  reserve ~:981, `smsAccountFor` dentro de `callSmsProvider`).
- `provider_unit_cost` no ledger vem do `billing_price_book` global.
- Fatura: `billing_monthly_amount` / `billing_issue_invoice` /
  `billing_reprice_open_invoice` (`20261023100000_billing_invoices.sql`).
  Valor único; **não existe item de fatura**.
- Central: `refresh_crm_results_day` (`20261129100000_supabase_consumo_p0.sql`)
  custo SMS = unidades enviadas x preço de venda da casa.
- Callbacks:
  - Short Brasil: `src/routes/api/public/sms-webhook.ts`, segredo global
    `SHORT_BRASIL_WEBHOOK_SECRET`; URL configurada no painel do provedor.
  - Infobip: token global (`INFOBIP_SMS_CALLBACK_TOKEN` /
    `INFOBIP_VOICE_CALLBACK_TOKEN`) enviado **em cada requisição** na
    `notifyUrl` (`src/lib/infobip-sms.server.ts:41-56`,
    `src/lib/infobip-voice.server.ts:99-108`, e-mail igual).
- Validação de URL de conta (`assertHttpsUrl`) aceita `http:` e qualquer
  host; o "Testar" devolve status HTTP/erro.
- A casa não tem tela de canais SMS/e-mail/voz em Integrações
  (`src/routes/webhooks.tsx`: plataforma, links, meta, webpush).

## 5. Modelo de dados (aditivo)

- `provider_accounts.owner_tenant_id uuid null references tenants(id) on
  delete cascade`. `null` = conta da plataforma.
  - Conta com dono: só pode ser ligada à própria casa
    (`tenant_channel_providers_check_channel`) e **nunca** pode ser padrão
    (`platform_channel_defaults_check` recusa).
  - Excluir a casa apaga a conta e as credenciais.
- Concessão por casa x canal (tabela nova, ex.
  `tenant_own_provider_grants`): `tenant_id`, `channel` (sms/email/voice),
  `allowed boolean`, `monthly_fee_cents bigint >= 0`, `granted_at`,
  `granted_by`, `revoked_at`, `revoked_by`, `updated_at`. Histórico de
  liberação/revogação vai para `tenant_audit_logs`.
- Custo informado pela casa: `own_unit_cost` (numeric, R$ por unidade do
  canal: SMS por segmento, voz por bloco de 30 s, e-mail por envio) na conta
  própria (coluna própria, não dentro de credenciais).
- Token de callback **por conta** (gerado pelo servidor, guardado como hash
  ou cifrado), usado nas URLs de retorno das contas com dono.
- `wallet_ledger.provider_account_id` (nullable): de qual conta saiu o envio.
  Ajuda Financeiro e conciliação.
- Fatura: `billing_invoices.channel_fees_cents bigint not null default 0`
  (mais um detalhamento por canal, ex. jsonb `channel_fees`), somado em
  `amount_cents`. Alternativa aceitável a critério do builder: tabela de itens.
  Requisito: o detalhamento aparece na fatura da casa e no console do super
  admin.

## 6. Comportamento

### 6.1 Liberação e revogação (super admin)
- Liberar: grava a concessão com a taxa. Nada muda no envio até a casa
  cadastrar e ativar a conta dela.
- Alterar a taxa: vale a partir da próxima fatura emitida.
- Revogar:
  - a conta própria da casa naquele canal fica **suspensa** (não envia);
  - o canal da casa **pausa**: mesmo comportamento de hoje para conta da casa
    indisponível (envios falham `misconfigured`/a jornada não reivindica
    passos daquela casa naquele canal; nada sai pela rota da BetLeads);
  - a equipe da casa (admins, gestores, experts) vê aviso "Ciente" (reusar o
    padrão de `tenant_channel_notice_acks`);
  - no console, o super admin vê "Pausado: aguardando decisão" com duas ações:
    **Voltar para a padrão** (remove a ligação; a cobrança por envio volta) ou
    **Manter pausado**.
- Liberar de novo: a conta antiga da casa pode ser reativada pelo admin dela.

### 6.2 Cadastro pela casa (admin da casa)
- Só papel admin da casa ativa; gestor, expert e membro não veem.
- Só aparece o canal com concessão ativa; canal sem concessão fica escondido.
- Passos: provedor (da lista do canal) -> credenciais e remetente -> custo por
  unidade -> configurar webhook (URL com o token da conta, botão copiar, aviso
  "sem isso você não verá entregas") -> testar -> ativar.
- Ativar = criar/atualizar `tenant_channel_providers` para a conta da casa.
  Confirmação lista: sem troca automática se a conta cair; no e-mail, os
  domínios voltam a `pending` (DKIM novo); a cobrança por envio deixa de
  existir e passa a valer a taxa mensal.
- Substituir credenciais: campo em branco mantém; exige **reautenticação**
  (senha de novo). Os outros admins da casa recebem e-mail avisando
  (cadastro, troca, remoção, ativação).
- "Voltar para a rota da BetLeads": a casa pode desligar a conta própria
  sozinha; a cobrança por envio volta na hora e a taxa sai da próxima fatura
  (6.5).
- Card de saúde: estado da conta, último envio aceito, **último callback
  recebido há X**, saldo quando o provedor informa (Infobip). Erros com dono
  claro: "sua conta recusou / está sem saldo".
- A regra "a casa nunca vê nome de fornecedor" deixa de valer **só** para a
  conta própria dela.

### 6.3 Envio
- Igual a hoje em jornadas, campanhas, bulk, fluxos e envio avulso.
- O reserve passa a saber a conta: resolver a conta da casa **antes** do
  `wallet_reserve` (ou o SQL ler `tenant_channel_providers`). Envio por conta
  com dono: valor 0, unidades registradas, `provider_unit_cost` 0 para a
  BetLeads, `provider_account_id` gravado.
- Envio por conta com dono **não passa pelas travas de saldo** (saldo zero,
  pausa por falta de saldo, elegibilidade de jornada/campanha por saldo):
  a casa não pode parar por carteira vazia num canal que a BetLeads não cobra.
  *(Decisão minha.)*
- Se a conta resolvida no envio não for a mesma do reserve (troca no meio),
  a regra é: quem decide a cobrança é a conta usada de fato; o builder garante
  que não há envio pela rota BetLeads com reserve zerado nem o contrário.
- Isolamento: timeout menor e concorrência própria por conta com dono; timeout
  conta para abrir o breaker da conta. Uma conta lenta não pode segurar o tick
  das outras casas.

### 6.4 Callbacks
- Cada conta com dono tem token próprio; a URL que a casa configura (Short
  Brasil no painel; Infobip na `notifyUrl` de cada requisição) leva esse
  token, nunca o token global.
- O endpoint só aplica um evento se o log/mensagem casado tiver
  `provider_account_id` igual à conta do token. O token global continua
  valendo só para contas da plataforma.

### 6.5 Cobrança da taxa
- A taxa é paga adiantada junto com o plano (a fatura cobre o período que
  começa no vencimento). Entra na fatura só se, **no momento da emissão**, a
  concessão estiver ativa **e** a conta própria da casa estiver ativa e ligada
  ao canal (decisão do usuário: quem está na rota da BetLeads paga só por
  envio, nunca taxa + envio). Liberação ou ativação depois da emissão só entra
  na próxima.
  Revogação no meio do ciclo: sem estorno; a próxima fatura não cobra.
  *(Decisão minha.)*
- O valor é congelado na emissão (`channel_fees_cents` gravado na fatura);
  `billing_reprice_open_invoice` não o recalcula.
- Taxa zero não gera linha cobrada.
- Desconto contínuo e desconto avulso continuam valendo **só** sobre a base do
  plano. *(Decisão minha.)*
- Fatura já aberta não é repreçada ao liberar/revogar (começa no ciclo
  seguinte).
- Casa sem pagar: bloqueio existente da casa inteira.

### 6.6 Central e Financeiro
- Central (`refresh_crm_results_day`): SMS enviados por conta com dono custam
  `own_unit_cost` da conta (por segmento); os demais seguem no preço de venda.
  Mudar o custo informado reprocessa como hoje acontece com o preço de venda
  (história recalculada). *(Decisão minha; mesmo comportamento atual.)*
- Nesta fase o custo informado é pedido e usado **só para SMS** (por
  segmento), que é o custo que a Central mostra. E-mail e voz por conta
  própria registram custo 0. *(Decisão minha.)*
- Financeiro da BetLeads (super admin): envio por conta com dono tem receita 0
  e custo 0; a taxa mensal entra como receita de mensalidade. O Financeiro
  geral mostra a taxa separada da base do plano.

## 7. Segurança (bloqueia a liberação para qualquer casa)

1. Token de callback por conta + amarração ao `provider_account_id` (6.4).
2. SSRF: URLs de conta com dono só `https`, host em allowlist
   (`*.api.infobip.com` e os hosts reais da Short Brasil), sem seguir
   redirect, sem IP privado/link-local; o "Testar" devolve mensagens genéricas
   (sem status HTTP cru nem texto de erro de rede). Vale também para as
   contas da plataforma.
3. Isolamento de timeout/concorrência (6.3).
4. Reautenticação + e-mail aos outros admins em mudança de credencial/ativação.
5. Funções de servidor da casa separadas das do super admin; cada uma checa:
   admin da casa ativa, concessão ativa no canal, `owner_tenant_id` = casa,
   provedor suportado no canal. Nunca devolvem credenciais.
6. Tudo em `tenant_audit_logs` sem credenciais. O super admin pode
   desativar a conta de uma casa, mas não editar credenciais.

## 8. Teste mínimo (QA)

- Permissão: liberar/revogar/liberar; chamada direta por API com canal não
  liberado; gestor/expert/membro bloqueados; conta de outra casa recusada;
  conta com dono recusada como padrão da plataforma.
- Envio por conta própria em jornada, campanha, bulk e avulso: carteira não
  debita, ledger com valor 0 e `provider_account_id`, log igual ao de hoje.
  Canal na rota BetLeads continua cobrando.
- Conta sem saldo/401: pausa só a casa; breaker global intacto; endpoint lento
  não atrasa outras casas.
- Callback com token da conta A e mensagem da conta B recusado; token global
  não aplica evento de conta com dono.
- Revogação: canal pausa, aviso "Ciente", nada sai pela rota BetLeads; "Voltar
  para a padrão" retoma com cobrança.
- Fatura: taxa no ciclo seguinte, zero não aparece, desconto não incide na
  taxa, fatura aberta não muda.
- Central: custo informado nos SMS da conta própria.
- SSRF: `http`, IP privado, redirect recusados no salvar e no testar.

## 9. Decisões minhas (para o usuário conferir)

- A casa pode voltar sozinha para a rota da BetLeads (a taxa sai da próxima
  fatura).
- Taxa adiantada, congelada na emissão, sem estorno em revogação no meio do
  ciclo.
- Envio por conta própria ignora as travas de saldo da carteira.
- Custo informado só para SMS nesta fase.
- Desconto do plano não incide sobre a taxa do canal.
- Durante a pausa por revogação, passos de jornada esperam (como conta
  indisponível hoje), não são pulados.
- Mudar o custo informado recalcula a Central retroativamente.
- Allowlist de host vale também para contas da plataforma.

## 10. Deixado para o builder

- Forma exata do detalhamento da fatura (colunas vs tabela de itens).
- Onde resolver a conta antes do reserve (TS antes do RPC ou SQL).
- Formato do token por conta (hash vs cifrado) e rotação.
- Layout das telas, seguindo o padrão atual (Integrações da casa ganha a aba
  de canais; console do super admin em `src/routes/tenants.tsx`).
- Casa isenta (`interno`) com conta própria: taxa não cobrada (o plano não
  gera fatura), envio já é zero.
- Atualizar o tutorial do CRM nas telas novas.
- Rollout: aplicar migrations antes do app; 99Bet como piloto em SMS.
