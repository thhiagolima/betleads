# Escopo — Auditoria de jornadas: custo, controle de entrada e contabilidade da recuperação — 2026-10-29

## Objetivo

A análise da casa betgreen expôs falhas estruturais que fazem as casas pagarem por SMS
que não gera depósito novo e que inflam o número de "recuperado" exibido. Este escopo
prioriza os ajustes em quatro camadas:

1. **Custo**: o que dispara sem saldo, sem orçamento ou sem confirmação.
2. **Frequência**: quantas mensagens o mesmo jogador recebe.
3. **Entrada**: quem entra nas jornadas e com quais filtros.
4. **Contabilidade**: o que o CRM chama de recuperado.

## Evidências (produção, 26 a 29/10)

| Achado | Dado |
|---|---|
| Etapa perdida por falta de saldo | Betgreen: 11.576 execuções da 1ª etapa puladas ou recusadas por saldo (27/10 20h a 28/10 11h). A matrícula avançou para a etapa seguinte e a 1ª mensagem nunca saiu. |
| Excesso de mensagens | Betgreen sem limite de contatos: até 19 SMS por jogador em 36h, vindos de PIX gerado e Saque pago. Sorte Alta, mesmo com limite 2/24h: 209 casos de jogador-dia com 5 ou mais SMS (campanhas e jornadas expressas ficam fora do limite). |
| Base antiga tratada como cadastro novo | "Cadastrou e não depositou" da betgreen matriculou 5.280 jogadores; só 725 tinham cadastro com menos de 7 dias. A 1ª mensagem diz "Bem-vindo, seu cadastro foi concluído". Resultado: 1 FTD em 5.212 envios. |
| SMS para quem já é ativo | 21% dos SMS de jornada da betgreen foram para jogadores ativos (depósito há menos de 48h): R$ 301. Sorte Alta: 7,6%; forrandobet: 11,4%. |
| Custo por FTD vindo de quem nunca depositou | R$ 72 (forrandobet) a R$ 419 (betgreen) por FTD atribuído. Na Sorte Alta, 41% dos SMS de jornada vão para quem nunca depositou. |
| Efeito real (holdout, 7 dias) | Sorte Alta, só entradas depois que o holdout foi ligado (16/10): Esfriando 56,6% × 49,0% (cerca de +R$ 105 por jogador); Dormindo 16,6% × 10,1%. Betgreen, 72h: Esfriando 22,3% × 25,0%; Dormindo 2,9% × 4,9%, ou seja, sem efeito até agora (amostra de 1,5 dia). |
| Holdout distorcido por carga inicial | Sorte Alta: a carga de 14/10 (6.954 matrículas) entrou antes do holdout existir. Comparar o período inteiro dava 15,6% × 49,0%, uma conclusão falsa. |
| "Recuperado" ampliado inflado | Betgreen: R$ 26,6 mil na visão ampla contra R$ 586 na visão direta. A visão ampla aceita qualquer SMS, inclusive transacional, sem clique, em 72h. |
| Mistura de regras | `crm_results_daily` usa `rule_version` 3 até 26/10 e 4 a partir de 27/10, sem recálculo do histórico. As migrações de 20261105 em diante não estão em `schema_migrations`. |
| Holdout pouco usado | 24 de 96 jornadas ativas usam holdout. O editor só oferece 0, 5 ou 10%. |

## Já feito (29/10)

- **Limite de contatos (2/24h e 14/7d) gravado nas 6 casas que não tinham**: betgreen,
  bravabet365, laelebet, betleads-original, crm-expert-queiroz e QA Jornadas P0. As 12 casas
  agora têm limite.
- **Migração `20261114100200_journey_contact_limits_default.sql` aplicada em produção.**
  O trigger `tenants_journey_contact_limits` cria o limite padrão em toda casa nova.
  Foi testada com uma casa fictícia dentro de uma transação desfeita. Falta commitar.
- **P0.2, parte de configuração (aplicada em produção):**
  - **PIX gerado:** expressa, com `max_per_player_day = 1` e `min_interval_minutes = 60`.
    Foram 9 jornadas, incluindo o rascunho da laelebet. 16 matrículas que estavam
    adiadas voltaram para a fila.
  - **Saque pago:** `max_per_player_day` reduzido de 4 para 2, nas 9 jornadas.
  - Cada mudança tem registro em `journey_events` (`express_changed` e
    `entry_rules_changed`).
  - Falta a parte de código: os padrões no modelo de jornada e os campos no editor.

## Ações operacionais imediatas (configuração, sem código)

Para fazer agora nas casas, com aprovação de cada uma:

1. **Betgreen, "Cadastrou e não depositou"**: definir `trigger_config.start_after` para
   7 dias atrás, para parar de mandar "Bem-vindo" à base importada. Para os cadastros de
   7 a 30 dias, avaliar uma única campanha de "última chance" com oferta de FTD.
2. **PIX gerado e Saque pago (todas as casas)**: ver P0.2. Marcar PIX gerado como
   expressa com `max_per_player_day = 1`, para não ser bloqueado pelo limite de 2 por dia,
   e reduzir o `max_per_player_day` do Saque pago de 4 para 1 ou 2. O backend já aplica
   esses campos; só falta a interface.
3. **Betgreen**: recarregar a carteira. Saldo de R$ 742 contra cerca de R$ 960 de gasto
   por dia.
4. **Holdout de 10%** nas jornadas Esfriando, Dormindo e 30 dias que estão sem holdout.

---

## Priorização

Critério de ordem:
- **P0**: perda de dinheiro ou mensagem errada acontecendo agora.
- **P1**: dar à casa controle de entrada e de custo.
- **P2**: contabilidade honesta.
- **P3**: otimização e inteligência.

### P0 — Para a sangria (curto prazo)

#### P0.1 Falta de saldo pausa a jornada em vez de pular a etapa
- **Hoje:** `journeys.server.ts:1194-1222`. Com `decision.kind === "skip"`, a execução
  fica `skipped` e a matrícula vai para `current_position + 1`. O dispatcher legado
  (`sms-dispatcher.server.ts:54-55, 722-744`) faz o oposto: tenta de novo a cada 15 min,
  para sempre.
- **Ajuste:**
  - Saldo insuficiente devolve a matrícula para a **mesma** posição, com `next_run_at` adiado.
    Não consome tentativa. A matrícula registra o evento `paused_no_balance`.
  - Antes de buscar o lote, o dispatcher pula casas com saldo menor que o custo mínimo de
    1 envio, evitando milhares de falhas individuais.
  - Quando a carteira for recarregada, a jornada retoma sozinha.
  - Mensagens de tempo curto (PIX, saque) respeitam `max_delay_minutes` e saem como
    `stale_message` se a pausa passar do prazo, em vez de chegarem atrasadas.
  - O dispatcher legado ganha um teto de adiamentos.
- **Aceite:** com o saldo zerado, nenhuma matrícula avança de etapa e nenhuma execução
  vira `skipped` por saldo. Depois da recarga, a etapa pendente é enviada.
- **Status: implementado no branch `fix/journeys-p0-saldo`** (falta deploy). Substitui a
  decisão 6 do PG3. Como ficou:
  - `holdForBalance` (`journeys.server.ts`): a execução volta para `retrying` e a matrícula
    fica `waiting` na mesma etapa por 15 min, sem consumir tentativa. Registra o evento
    `step_deferred` com `reason='saldo_insuficiente'` e mantém o alerta de hora em hora.
  - Em vez do pré-filtro de saldo antes de buscar o lote, há um atalho por rodada: depois
    da 1ª recusa da carteira, os demais itens da mesma casa nessa rodada esperam sem
    reservar nem chamar a carteira. Com concorrência N, são no máximo N chamadas à carteira
    por casa por rodada.
  - O contador do dispatcher mudou de `skippedNoBalance` para `deferredNoBalance`.
  - PIX e saque continuam saindo como `stale_message` depois de `max_delay_minutes`,
    porque a validade é conferida antes da reserva.
  - **Ainda não feito:** o teto de adiamentos do dispatcher legado (`sms_flow_leads`).

#### P0.1b Falha da plataforma não pode encerrar a matrícula
- **Hoje:** erros de configuração ou de deploy encerram a matrícula para sempre
  (`status='exited'`, com a mensagem de erro em `exit_reason`). O jogador não volta para a
  jornada. Incidentes já resolvidos que deixaram matrículas perdidas:
  - **22 e 23/10, "SHORTIO_DOMAIN não configurado para este tenant":** 19.056 matrículas
    (pixreals 9.891, Sorte Alta 6.583, forrandobet 2.167, sorte-da-bet 408, 777 7).
  - **28/10, das 19h41 às 19h55, "Could not find the 'provider_account_id' column of
    'sms_send_logs'":** 188 matrículas. O código foi publicado antes da migração
    `20261108100000`.
- **Ajuste:**
  - Classificar as falhas em **falha do jogador** (telefone inválido, sem consentimento),
    que encerra a matrícula, e **falha da plataforma** (configuração ausente, coluna ou
    schema, Short.io, provedor sem conta), que segura a matrícula na mesma etapa, com
    `next_run_at` adiado e evento `platform_error`.
  - A falha da plataforma também abre um alerta (`system_alerts`) por casa e tipo de erro.
  - Ferramenta de reprocessamento para o super admin: reabrir as matrículas encerradas por
    falha da plataforma num intervalo de tempo. Essas matrículas respeitam `max_delay_minutes`
    e o limite de contatos.
- **Decisão sobre o histórico:** das 19.244 matrículas perdidas, avaliar quais ainda fazem
  sentido reabrir. As de reativação e de nível provavelmente sim; as de PIX e saque já
  venceram.
- **Aceite:** remover `SHORTIO_DOMAIN` num ambiente de teste deixa as matrículas em espera,
  e não encerradas. Ao restaurar, elas seguem da mesma etapa.
- **Achado na implementação, possível SMS em dobro:** em `sendSmsInternal`, o registro
  do envio (`logSend`) é gravado **depois** de o provedor aceitar o SMS e de a carteira
  cobrar. Se essa gravação falhava, o erro "Falha ao registrar envio SMS" fazia a jornada
  tentar de novo e reenviar. No incidente de 28/10 houve 709 tentativas para 292
  matrículas. A carteira cobrou uma vez por jogador (292 reservas, R$ 10,64, por
  idempotência), mas o provedor pode ter recebido o mesmo SMS até 3 vezes. Não dá para
  confirmar pelo banco, porque nenhum envio da janela foi registrado.
- **Status: implementado no branch `fix/journeys-p0-saldo`** (falta deploy):
  - `sms.functions.ts`: com o SMS já aceito pelo provedor, a falha ao gravar o registro
    vai para o Sentry (`log_after_accepted`) e o envio conta como feito, sem reenvio. Com o
    SMS recusado, o erro continua.
  - `journey-platform-failure.ts`: reconhece falha da plataforma (credencial de provedor
    ausente, `SHORTIO_DOMAIN` ausente, Short.io fora do ar, registro de envio recusado,
    coluna ou função inexistente). Isso só vale para decisões `fail`, e o classificador
    compartilhado com campanhas e fluxos não muda.
  - No dispatcher, falha da plataforma deixa a execução em `retrying` e a matrícula em
    `waiting` na mesma etapa por 30 min, sem consumir tentativa, com
    `metadata.platform_holds` e o evento `step_deferred` (`reason='platform_error'`,
    `platform_reason`). O Sentry recebe um aviso por casa e motivo por rodada. O teto é de
    144 retenções por etapa (3 dias); depois disso vale a política normal de tentativas.
  - Novo contador no dispatcher: `platformHeld`.
  - **Mudança de comportamento:** credencial de provedor ausente (`misconfigured`) não
    consome mais tentativa; a matrícula fica retida até corrigir.
  - **Ainda não feito:** o alerta em `system_alerts` para a casa e a ferramenta de
    reprocessamento das matrículas já encerradas (depende da decisão sobre o histórico).

#### P0.2 Separar mensagem transacional de marketing no limite de contatos
- **Hoje:**
  - O limite global (2/24h, 14/7d) conta todo SMS do jogador, inclusive campanhas,
    menos o de jornada expressa (`20261016110000_journey_independent_saque_budget.sql`).
  - A única expressa é Saque pago (8 casas), com limite próprio
    `max_per_player_day = 4` e `min_interval_minutes = 15`.
  - PIX gerado, Níveis e Cashback **não** são expressas e disputam as 2 vagas diárias
    com reativação e campanhas.
  - `max_per_player_day` vale para todas as jornadas (`20261015200000_journey_p0_rules.sql`).
- **Problema:** o limite bloqueia justamente o PIX gerado, a mensagem de maior intenção.
  Em 29/10, depois das 17h19, houve 24 bloqueios `global_limit_24h`, todos em PIX gerado.
  Com `max_delay_minutes` de 120, o PIX bloqueado sai como vencido e se perde, enquanto a
  vaga foi ocupada por reativação ou campanha.
- **Ajuste:**
  - **PIX gerado passa a ser expressa**, com `max_per_player_day = 1` e
    `min_interval_minutes = 60`. Fica fora do limite global e com vaga própria.
  - Saque pago: `max_per_player_day` de 4 para 1 (ou 2, a decidir).
  - Níveis e Cashback continuam dentro do limite global (marketing). Sem limite próprio.
  - Migration grava esses valores nas jornadas existentes. O modelo de jornada passa a
    sair com eles por padrão.
- **Depende de:** P1.6 (campanhas consumindo vagas sem respeitar o limite). Até lá, um
  disparo em massa pode ocupar as vagas do dia e bloquear as jornadas de marketing.
- **Aceite:**
  - Nenhum bloqueio `global_limit_*` em PIX gerado.
  - Um jogador com 5 PIX gerados no dia recebe 1 SMS dessa jornada.
  - Reativação e campanha continuam limitadas a 2/24h somadas.

#### P0.2b Repetição sem fim nas jornadas de nível
- **Hoje:** as 40 jornadas de nível (5 níveis × 8 casas) terminam com
  `end.loop_to_position = 9`. A saída é só `level_changed`. Um jogador parado num nível
  recebe "suba de nível" a cada 48h, sem fim. Novos depósitos não tiram o jogador da
  jornada.
- **Comportamento correto já existente:** quando o limite global bloqueia, a etapa fica em
  espera na mesma posição e é enviada quando abre vaga, sem pular nada. Nível não tem
  validade (`max_delay_minutes`), então a mensagem sai mesmo atrasada. Se o nível mudar
  durante a espera, o jogador sai sem receber a mensagem antiga, o que é o desejado.
- **Ajuste:**
  - Teto de repetições por matrícula: novo `entry_rules.max_loops`, padrão 2, conferido
    contra `journey_enrollments.loop_iteration`. Ao atingir, a matrícula termina como
    `completed`, com `exit_reason='max_loops'`.
  - Mostrar no editor quando uma jornada tem repetição e quantas vezes ela repete.
  - Avaliar a saída por depósito nas jornadas de nível, porque a mensagem pede depósito.
    Com saída por depósito, a matrícula sairia no 1º depósito depois de entrar, e o
    próximo depósito que mudar o nível abre uma nova.
- **Aceite:** um jogador parado em Prata recebe no máximo 7 + 2 × 2 = 11 SMS da jornada,
  e não uma série sem fim.
- **Achado na implementação, o problema não é só de nível.** Todos os modelos principais
  repetem sem fim (produção, 29/10):

  | Gatilho | Jornadas com loop | Matrículas abertas | Com 2+ voltas |
  |---|---|---|---|
  | Inatividade (Esfriando, Dormindo, 30 dias) | 27 | 14.747 | 1.337 |
  | Cadastrou e não depositou | 9 | 7.321 | 43 |
  | Nível | 45 | 1.292 | 40 |
  | PIX gerado | 9 | 388 | 5 |

  "30 dias sem depósito" e "Cadastrou e não depositou" não têm saída natural: quem nunca
  deposita recebia SMS a cada 48h para sempre.
- **Status: implementado no branch `fix/journeys-p0-loops`** (falta deploy):
  - O limite fica no passo de fim, `end.config.max_loops`, ao lado de `loop_to_position`,
    e não em `entry_rules`. Vale para **qualquer** jornada com repetição.
  - Sem valor configurado, o padrão é `DEFAULT_MAX_LOOPS = 2` (`journeys.shared.ts`).
    Isso vale de imediato para todas as jornadas existentes. O máximo é 50; não existe
    "repetir para sempre".
  - Ao atingir o limite, a matrícula termina como `completed` com `exit_reason='max_loops'`.
    Matrículas que já passaram de 2 voltas terminam na próxima vez que chegarem ao fim.
  - Editor: o campo "Repetir o loop no máximo" aparece quando a jornada tem repetição.
  - **Ainda não feito:** a saída por depósito nas jornadas de nível (decisão de produto).

#### P0.3 Idade máxima do evento de entrada
- **Hoje:** `journey-scanner.server.ts:138-144`. `cadastrados_sem_deposito` só é limitado
  por `start_after`, e `saque_pago` não tem limite de idade.
- **Ajuste:**
  - Novo `trigger_config.max_event_age_hours`, aplicado em `matchJourneyScanPlayer`.
    Padrões: cadastro 168h, saque 24h, PIX = `expire_hours`, primeiro depósito 72h.
  - O editor mostra o campo com o padrão já preenchido.
- **Aceite:** um jogador cadastrado há 30 dias sem FTD não entra em "Cadastrou e não
  depositou" com o padrão.
- **Status: implementado no branch `fix/journeys-p0-event-age`** (falta deploy):
  - `eventMaxAgeHours` e `eventYoungEnough` (`journey-policy.ts`), com padrões de 168h para
    cadastro, 72h para primeiro depósito e 24h para saque. `trigger_config.max_event_age_hours`
    sobrescreve o padrão, e `0` desliga o limite. PIX continua com o seu `expire_hours`.
  - Aplicado no scanner (`matchJourneyScanPlayer` e `financialOccurrences`), que atende os
    três caminhos de entrada: scanner completo, webhook e cruzamento.
  - **Só vale para a entrada.** A verificação antes de cada etapa (`matchFinancialTrigger`)
    não mudou, então quem já está na jornada não é cortado quando o evento envelhece.
  - Editor: o campo "Só entra quem… nas últimas (horas)" aparece para os três gatilhos.
  - **Não mexe nas matrículas já abertas** (por exemplo, a base importada da betgreen). Elas
    terminam pelo limite de repetições do P0.2b.

#### P0.4 Carga do histórico só com confirmação explícita
- **Hoje:** uma jornada de evento sem `start_after` matricula todo o histórico, e o
  scanner só registra um aviso (`journey-scanner.server.ts:481-493`). Ativar sem
  `entryScope` mantém o `trigger_config` como está.
- **Ajuste:**
  - O servidor recusa ativar uma jornada de evento sem `start_after`, a menos que venha
    `entryScope='include_base'` com a confirmação de quantos jogadores vão entrar.
  - O scanner trata a falta de `start_after` como `new_only`.
- **Aceite:** nenhum caminho (tela, API, duplicação ou edição) consegue matricular a base
  inteira sem confirmação registrada em `tenant_audit_logs`.
- **Achado na implementação:** as jornadas das casas novas foram ativadas em 26/10 por um
  **script fora do repositório**, que gravou direto no banco (`journey_events.detail.source =
  'copy_from_sorte_alta'`) e não passou pelo diálogo de escopo. Nas 8 casas, PIX e Saque
  ficaram com `start_after`, mas "Cadastrou e não depositou" e "Cashback" não, e carregaram a
  base inteira. Uma checagem só no servidor da aplicação não teria impedido isso.
- **Status: implementado no branch `fix/journeys-entry-scope`** (falta aplicar a migração e
  fazer o deploy):
  - Migração `20261115100100_journeys_default_start_after.sql`: o trigger `BEFORE INSERT OR
    UPDATE OF status` em `journeys` grava `start_after` com a hora da ativação quando uma
    jornada de evento passa a `active` sem ele. Vale para qualquer caminho, inclusive
    scripts. Gatilhos de estado (inatividade, nível) e jornadas que já estavam ativas não
    mudam.
  - `activationTriggerConfig`: "Incluir a base atual" numa jornada de evento sem
    `start_after` grava `INCLUDE_BASE_START_AFTER` (1970-01-01), uma escolha explícita que
    fica registrada no `journey_events` (`entry_scope`) com o usuário. O limite de idade do
    P0.3 continua valendo.
  - Diferente do aceite original: a confirmação fica em `journey_events` (com
    `actor_user_id`), não em `tenant_audit_logs`, e o servidor não recusa a ativação; o
    padrão seguro passa a ser "só novos".
  - **Ainda não feito:** a estimativa do diálogo (`journey_eligible_lead_count`) ignora o
    limite de idade do P0.3, então mostra mais jogadores do que de fato entram nos gatilhos
    de evento. As 16 jornadas já ativas sem `start_after` (Cadastrou e Cashback) não mudam.

#### P0.5 Alerta de saldo por autonomia
- **Hoje:** `low_balance_threshold` fixo de R$ 200 e e-mail de hora em hora só depois
  das falhas.
- **Ajuste:** calcular as horas de autonomia (saldo dividido pelo gasto médio das últimas
  24h ou pela previsão das jornadas ativas). Alertar abaixo de 24h e de 6h, com aviso na
  tela da casa.
- **Aceite:** a betgreen com R$ 742 e gasto de R$ 960 por dia recebe o alerta de menos de
  24h.
- **Caso real (29/10, 16h):** a betgreen tinha R$ 552 de saldo e R$ 1.090 de gasto em 24h,
  cerca de 12 horas de autonomia, e nenhum alerta, porque o saldo estava acima de R$ 200.
- **Status: implementado no branch `fix/wallet-runway-alert`** (falta aplicar a migração e
  fazer o deploy):
  - Migração `20261115100000_billing_runway_alert_candidates.sql`, **só aditiva**: a função
    `billing_runway_alert_candidates(_after, _limit, _hours)` calcula o gasto líquido em 24h
    (reservas menos estornos do `wallet_ledger`) e a autonomia, com os mesmos filtros do
    alerta de limite.
  - `sendLowBalanceAlerts` roda primeiro a varredura por autonomia:
    - abaixo de 24h, e-mail `low_runway` "Seu saldo na BetLeads dura cerca de N horas", uma
      vez a cada 24h;
    - abaixo de 6h, `low_runway_urgent`, a cada 6h.
    A casa coberta por essa varredura não recebe também o e-mail de limite. Se a varredura
    falhar (por exemplo, função ainda não criada), o alerta de limite continua normal.
  - Corrigido o texto do e-mail de "Saldo insuficiente", que ainda dizia que as jornadas
    "pulam" envios.
  - **Ainda não feito:** o aviso de autonomia na tela da casa (`walletBalanceNotice`), que
    precisaria do gasto em 24h no `wallet_summary`. O e-mail continua restrito à janela de
    08h às 20h, como os demais alertas de billing.

### P1 — Controle de leads e de custo para a casa

#### P1.1 Filtros de entrada (segmentação)
- **Hoje:** o público é só "todos", "status ativo" ou "VIP" (`journey-policy.ts:239-248`).
  Não há filtro de valor, de recência nem de quem está ativo.
- **Ajuste:** novo `entry_rules.filters`, avaliado na entrada (`matchJourneyScanPlayer` e
  `enrollPlayerOnEvent`) e de novo antes de cada etapa (`journeys.server.ts:341`):
  - excluir quem depositou nas últimas N horas (padrão de 48h nas jornadas de reativação);
  - exigir FTD;
  - total depositado mínimo e máximo;
  - número mínimo e máximo de depósitos;
  - dias desde o último depósito (intervalo);
  - nível VIP;
  - tags (incluir ou excluir).
- **UI:** um bloco "Quem pode entrar" no editor, com contagem estimada em tempo real.
- **Aceite:** é possível montar "Dormindo, depositou R$ 200 ou mais, sem depósito em 48h"
  e a contagem bate com uma consulta SQL de conferência.

#### P1.2 Prévia de público e custo ao ativar
- **Ajuste:** o diálogo de ativação (`journey-status-control.tsx`) mostra:
  - jogadores que entram agora e a estimativa de entradas por dia;
  - número de etapas SMS, segmentos médios e custo estimado (R$ 0,08 por segmento,
    `crm_sms_report_price`);
  - autonomia da carteira depois da ativação.
- **Aceite:** o valor estimado fica dentro de ±15% do custo real das primeiras 24h.

#### P1.3 Orçamento em R$
- **Hoje:** só `daily_limit` em número de mensagens. `channel_budget_buckets` é um limite
  de taxa, não de gasto.
- **Ajuste:**
  - `daily_budget_brl` por jornada e por casa, com reserva atômica junto da reserva de
    entrega.
  - Ao atingir o orçamento, a jornada pausa até o dia seguinte com a mesma semântica do
    P0.1 (não pula etapa).
- **Aceite:** com orçamento de R$ 50, o gasto do dia fica abaixo de R$ 50,08.

#### P1.4 Expor no editor o que já existe no backend
- `max_per_player_day`, `min_interval_minutes`, dias da semana (hoje fixos em todos os
  dias, `journey-editor.tsx:513`), `hours_max` da inatividade, `expire_hours`,
  `max_delay_minutes`.
- Holdout de 0 a 50%: hoje o editor só oferece 0, 5 ou 10% (`journey-editor.tsx:120-124`).
- `max_attempts` e `retry_base_seconds` hoje são gravados fixos (`journey-editor.tsx:516-517`).
  Deixar assim, mas documentar.
- Limite de contatos da casa (`get/saveJourneyContactLimits` existe, sem tela). Criar a
  tela em Configurações.

#### P1.5 Corrigir semântica e nomes
- O público "Só jogadores ativos" significa `status='ativo'` (conta ativa), não quem
  depositou recentemente. Renomear para "Conta ativa" e deixar a recência para o P1.1.
- `conversion_objective` só é gravado. Ou ganha comportamento de saída, ou sai da tela.
- `reentry` `once` e `never` são idênticos (`journey-policy.ts:162-175`). Unificar.

#### P1.6 Campanhas dentro do limite global (decisão de produto)
- **Hoje:** `sms-campaign-dispatch.server.ts:488-489` diz que campanhas não têm limite.
- **Proposta:** a campanha conta para o limite e tem a opção "respeitar o limite de
  contatos", ligada por padrão. Quem for bloqueado aparece no relatório da campanha.

### P2 — Contabilidade honesta da recuperação

#### P2.1 Holdout padrão e grupo de controle global
- Holdout de 10% por padrão em jornadas novas de reativação (inatividade e sem FTD).
- **Grupo de controle global da casa:** 5% dos jogadores, por hash estável, que não
  recebem nenhum SMS de marketing (nem jornada, nem campanha). Isso elimina a
  contaminação atual: quem é holdout de uma jornada ainda recebe as outras.
- **Aceite:** cada casa tem uma medida de ganho do CRM como um todo, além do ganho por
  jornada.

#### P2.2 "Recuperado incremental" como número principal
- **Hoje:** "Recuperado pelo CRM" é bruto (clique + depósito sem baseline). O ganho só
  aparece na aba Teste de controle (`crm-results.ts:340-379`) e não ajusta nenhum número
  principal.
- **Ajuste:**
  - Na Home, na Visão geral e em Jornadas, o número principal passa a ser
    (taxa de quem recebeu − taxa do controle) × quem recebeu, mais o valor equivalente,
    com intervalo de confiança.
  - Abrir por estado do jogador (esfriando, dormindo, perdido, sem FTD).
  - A visão direta continua como diagnóstico de clique.
  - Sem amostra mínima, mostrar "dados insuficientes" em vez de zero.

#### P2.3 Alinhar regras e janelas
- Hoje o holdout usa qualquer depósito em 7 dias e todos os estados, enquanto a visão
  direta e a ampla exigem intervalo de 48h ou mais e janelas de 7d e 72h. Definir uma
  regra única ("depósito que encerra um intervalo de pelo menos 48h, em até N dias") e
  aplicar nas três.
- **Correção do viés de entrada:** a comparação usa só matrículas do período em que o
  holdout já estava ligado. Matrículas anteriores a `holdout_percent > 0` ficam fora do
  grupo que recebeu SMS.

#### P2.4 Visão ampla
- Excluir as fontes transacionais (PIX, saque, nível, cashback) e `other`.
- Contar jogadores distintos no período, não somar por dia (`overview.tsx:169`).
- Tirar o "retorno" dessa visão, ou renomear para "receita de quem recebeu SMS".

#### P2.5 Versão da regra e histórico
- Recalcular `crm_results_daily` de 19/09 a 26/10 com a regra v4.
- A consulta da tela filtra ou exibe `rule_version` e avisa quando o período mistura
  versões.
- Registrar em `supabase_migrations.schema_migrations` as migrações aplicadas por fora
  (20261105 em diante, incluindo 20261109 e 20261114). Definir como aplicar migrações
  daqui em diante.

#### P2.6 Comissão de expert
- `20261105143000_expert_credits.sql` paga por último clique humano em até 72h, com a
  mesma exposição a depósito orgânico. Revisar depois de P2.2 se a comissão deve exigir
  jogador não ativo no clique.

### P3 — Otimização e inteligência

1. **Ganho por segmento alimentando recomendações:** sugerir excluir ou pausar segmentos
   sem ganho com amostra suficiente (`crm-recommendations.ts`).
2. **Inatividade relativa ao ritmo do jogador:** o gatilho dispara quando o intervalo
   atual passa de k vezes o intervalo médio do próprio jogador, em vez de horas fixas.
3. **Lista de verificação ao criar uma casa:**
   - limite de contatos (feito via trigger);
   - carteira com autonomia mínima;
   - holdout padrão;
   - `new_only` nas jornadas semeadas;
   - aviso de mensagens sem oferta.
4. **Remover código morto:** `check_contact_frequency_limit` e
   `checkContactFrequencyLimit` (`contact-frequency.server.ts`) não têm quem os chame.
5. **Conteúdo (negócio, fora do código):** os templates semeados são genéricos e iguais
   em todas as casas. Testar ofertas reais (bônus, giros) via A/B
   (`conversion_experiments`) com holdout.

---

## Sequência sugerida

| Fase | Itens | Observação |
|---|---|---|
| 0 (já) | Ações operacionais imediatas | Configuração com aprovação das casas |
| 1 | P0.1, P0.1b, P0.2, P0.2b, P0.3, P0.4, P0.5 | Sem mudança de interface grande; reduz gasto na hora |
| 2 | P1.1, P1.2, P1.4, P1.5 | Editor e diálogo de ativação |
| 3 | P2.1, P2.3, P2.5 | Base de medição; precisa ficar rodando 2 a 3 semanas antes do P2.2 |
| 4 | P2.2, P2.4, P1.3, P1.6 | Troca do número principal; comunicar às casas antes |
| 5 | P2.6, P3 | |

## Decisões em aberto

| Tema | Pergunta |
|---|---|
| Campanhas e limite global | Por padrão contam? A casa pode desligar por campanha? |
| Grupo de controle global | 5% é aceitável para as casas? Isso reduz o alcance. |
| Número principal | Trocar "Recuperado" bruto pelo incremental muda o número que a casa vê, que provavelmente cai. Como comunicar? |
| Matrículas puladas por saldo (betgreen) | Reenviar a 1ª etapa para quem ainda está dentro do prazo, ou aceitar a perda? |
| Padrões de idade máxima | 168h para cadastro e 24h para saque estão bons? |
| Repetição nas jornadas de nível | Quantas repetições permitir (padrão proposto: 2)? Sair por depósito? |
| Matrículas perdidas por falha da plataforma | Reabrir as de reativação e nível dos incidentes de 22 e 23/10 e de 28/10? |

## Riscos

- **P0.1:** pausar em vez de pular pode acumular matrículas. Na recarga, o dispatcher
  libera tudo de uma vez. Precisa respeitar `daily_limit` e o limite de contatos, e
  descartar mensagens vencidas.
- **P1.1:** filtros reavaliados antes de cada etapa podem tirar jogadores no meio da
  jornada. É o comportamento desejado, mas precisa estar registrado em `exit_reason`.
- **P2.2:** amostras pequenas geram intervalos largos. Casas pequenas vão ver "dados
  insuficientes" por semanas.
- Todos os números de evidência são de 1,5 a 14 dias de dados. Reavaliar a betgreen
  depois de 7 dias de operação com os ajustes.
