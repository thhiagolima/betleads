# Console do superadmin — design

Data: 2026-11-05
Status: desenho (branch feat/console-superadmin)
Base: `/admin` "Visão da plataforma" (abas por hash), cobrança PG1–PG6, Financeiro com escopo
"Todas as casas", Central de Resultados (`crm_results_daily`), observabilidade de jobs
(`20261014220000_observability_job_runs_and_queue_metrics.sql`).

## 1. Intenção

O superadmin administra 15 casas reais e está às cegas. Hoje, para saber se uma casa vai mal,
se um robô parou ou se alguém deixou de pagar, é preciso abrir casa por casa, ou alguém consultar
o banco. Em 05/11 uma consulta manual achou três problemas que nenhuma tela mostrava: robô de
campanhas marcado "rodando" desde a véspera, Short.io falhando 20% das chamadas havia pelo menos
uma semana e duas casas com cadastros caindo mais de 80% (ForrandoBet −83%, Sorte da Bet −87%).

O console dá ao superadmin, numa tela, **a saúde de todas as casas** e **os problemas técnicos
abertos**, e numa segunda tela **o financeiro do CRM como negócio**: quem pagou, quem deve, quanto
entrou em recargas, quanto custaram Short Brasil e Infobip e qual a margem.

Sucesso: de manhã o superadmin abre o CRM e em menos de um minuto sabe quais casas pioraram, o que
está quebrado e quem está devendo, sem abrir nenhuma casa e sem pedir consulta no banco.

### O que o usuário decidiu (05/11)
- A primeira coisa da manhã é a **saúde das casas**.
- Saúde = **recuperação do CRM, cadastros, FTDs e conversão**.
- "Casa indo mal" = pior **que ela mesma nos dias anteriores** (não comparada com as outras).
- Formato: **tabela única com todas as casas, as piores no topo** (opção A do esboço).
- **Alertas técnicos rápidos** na mesma tela, com **todos os seis tipos**: robôs, webhook fora do
  ritmo, fila de envio, fornecedor, saldo acabando, cobrança com problema.
- Financeiro geral: quem pagou a mensalidade, quem está em atraso ou não pagou, recargas por casa,
  custo total Infobip e provedor de SMS.
- Depois disso o usuário pediu para pular as perguntas e decidir o resto pesquisando outras
  plataformas. **Tudo daqui em diante que não está nesta lista é decisão do Claude** e está marcado
  como tal.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**
- F1 — Aba **Saúde** em `/admin`, primeira e padrão: faixa de alertas técnicos + tabela de casas.
- F2 — Aba **Financeiro geral** em `/admin`: mensalidades por estado, recargas, consumo, custo por
  fornecedor, margem, por mês.
- F3 — **Alertas com ciclo de vida** (abrir, reconhecer, silenciar, resolver sozinho, histórico) e
  **resumo diário** por e-mail às 8h.

**Não-objetivos (agora)**
- Health score numérico 0–10 ponderado (Gainsight/Vitally). A tabela com motivos em texto resolve o
  pedido; um score esconde o porquê. Fica como ideia futura (§9).
- Baseline por dia da semana (Datadog). Começamos com 7 dias contra a média semanal de 4 semanas,
  que já anula o efeito do dia da semana. Ideia futura.
- Conciliação com a fatura real da Infobip/Short Brasil. O custo continua estimado
  (unidades × tarifa cadastrada) e a tela diz isso.
- Alertas para as casas (dono/gestor). O console é só do superadmin.
- Push/WhatsApp em tempo real.

**Anti-objetivos (seria fracasso mesmo funcionando)**
- **Alerta falso em casa pequena.** A Sorte da Bet passa 14 h sem webhook normalmente; uma regra
  fixa de "X horas sem evento" faria o superadmin parar de olhar os alertas. Todo alerta de volume
  compara a casa com o próprio ritmo e exige volume mínimo.
- **Números diferentes dos da casa.** Cadastros, FTDs e recuperação têm que bater com o que a
  própria casa vê no Início/Resultados/Financeiro. Reusar as mesmas fontes, nunca recalcular por
  outro caminho.
- **Tela que pesa no banco.** A auditoria de consumo de 04/11 levou o banco de 15 para 9 GB e cortou
  crons pesados. Nada de varrer `players`, `webhook_logs` ou `crm_results_daily` inteiros a cada
  abertura da tela.
- **Somar direto com influenciado.** Na Central de Resultados os dois níveis nunca são somados
  (`src/lib/crm-results.ts:2`).
- Mostrar custo de fornecedor `null` como R$ 0 (regra já existente: "não cadastrado").

## 3. Restrições

- Tema sempre escuro; componentes de `src/components/ui` e `ui-premium` (`MetricCard`, `PageTabs`,
  `DataCard`, `EmptyState`). Celular: a tabela rola na horizontal dentro do card, a página não.
- Casas demo excluídas em tudo (`tenants.is_demo`). Casas isentas (`plano interno`) entram na saúde
  e no financeiro, marcadas como isentas.
- Moeda por casa (`tenants.moeda`, Los Hermanos em ARS): valores de recuperação e consumo na moeda
  da casa; totais do financeiro somados **por moeda**, nunca convertidos.
- Leituras cross-house com `supabaseAdmin` atrás de `assertSuperAdmin` em cada server function
  (padrão `*.functions.ts` → `xFor(ctx)` testável).
- Funções SQL `observability_*`, `finance_days`, `finance_activity_days`,
  `billing_runway_alert_candidates`, `billing_health_snapshot` são service_role only — continuam
  assim.
- Migrações em produção só com ok explícito do usuário a cada vez. F1 deve funcionar **sem
  migração** se possível (ver §5.4); F3 precisa de uma.
- Antes de entregar: `npm run build` (vazamento de `*.server` no bundle do cliente).

## 4. Ideias da pesquisa e o que entra

Pesquisa de 05/11 (Stripe, ChartMogul, Baremetrics, Gainsight, Vitally, ChurnZero, Segment,
Twilio, Datadog, Better Stack, PagerDuty, Optimove, Fast Track):

| Ideia | De onde | Entra? |
|---|---|---|
| Comparar a conta com o próprio volume típico, alerta só fora da faixa | Segment Source Volume Alerts | F1 (tabela e webhook) |
| Volume mínimo antes de alertar | Segment, PagerDuty | F1 |
| Motivo principal escrito em texto na linha da conta em risco | Gainsight, ChurnZero | F1 |
| Tendência pesa mais que nível | ChurnZero | F1 (delta vs base é o centro da tabela) |
| Dado faltante não conta como zero | Vitally | F1 ("sem histórico") |
| Heartbeat com tolerância por job | Better Stack | F1 (robôs) |
| Alarme por código de erro + janela | Twilio Alarms | F1 (fila/fornecedor) |
| Saldo em "dias de consumo", não em valor fixo | Twilio Usage Triggers | F1 (saldo) |
| Estados explícitos da cobrança + dias no estado | Stripe past_due/unpaid | F2 |
| Baldes "em cobrança / recuperada / perdida" e lista por valor | Stripe Revenue Recovery | F2 |
| Movimentos do mês: casa nova, pausada, reativada | ChartMogul MRR movements | F2 (simplificado) |
| Margem por casa e ranking das piores | Baremetrics | F2 |
| Incidente deduplicado por chave, reconhecer/silenciar, resolver sozinho | PagerDuty | F3 |
| Resumo diário às 8h em vez de notificação por evento | Fast Track, Segment | F3 |
| Health score 0–10 ponderado | Gainsight, Vitally | futuro |
| Baseline por dia da semana | Datadog | futuro |
| Uplift contra grupo de controle | Optimove | já existe (`journey_holdout_results`); futuro na tela |

## 5. F1 — Aba Saúde

### 5.1 Lugar
`/admin`, nova aba **Saúde** (hash `#saude`), **primeira e aba padrão** quando não há hash. O link
"Visão da plataforma" da barra lateral já leva a `/admin`. *(Decisão do Claude: não criar rota nova;
o superadmin já entra por ali.)*

### 5.2 Faixa de alertas técnicos (topo)
- Uma linha por alerta: severidade (CRÍTICO / ATENÇÃO), frase em português que diz o que é e em
  qual casa (ou "todas as casas"), "desde quando" e um link para a tela onde se resolve.
- Sem alertas: uma linha verde "Tudo funcionando — verificado às HH:MM".
- Críticos primeiro, depois atenção; dentro da severidade, o mais antigo primeiro.
- Em F1 os alertas são **calculados na hora** (sem tabela); F3 dá a eles ciclo de vida.
- Atualiza ao abrir e a cada 60 s enquanto a aba está aberta.

Regras (limites são decisão do Claude, como constantes num único arquivo para ajuste fácil):

1. **Robôs** — fonte `observability_job_health()` e `checkBillingHealth` (jobs de cobrança).
   - CRÍTICO: job com execução `running` sem heartbeat há mais de 15 min (`stale_running > 0`)
     *depois* da limpeza automática de 70dd8bc; ou job sem nenhuma execução há mais que
     3× o período esperado dele.
   - ATENÇÃO: execuções `failed` na última hora; ou todas as execuções da última hora `partial`.
   - O período esperado de cada job fica num mapa em TS (ex.: `sms_tick` 1 min,
     `shortio_sync` 5 min, `billing-cycle` diário). Job fora do mapa não gera alerta de atraso.
     Atenção: jobs que só gravam execução quando há trabalho (`sms_campaign_dispatch`) não podem
     ter alerta de "sem execução".
2. **Webhook fora do ritmo** — por casa ativa não demo.
   - Ritmo = eventos por hora nos últimos 7 dias. Silêncio atual = agora − último evento.
   - CRÍTICO: silêncio > max(2 h, 6 × intervalo médio entre eventos) **e** a casa tem ≥ 100
     eventos/dia na média dos 7 dias.
   - ATENÇÃO: mesma regra com ≥ 20 eventos/dia; ou mais de 5% dos eventos das últimas 24 h com
     status `erro` (com ≥ 50 eventos).
   - Casa com < 20 eventos/dia nunca recebe alerta de silêncio (Sorte da Bet).
3. **Fila de envio** — fonte `observability_queue_metrics()`, por casa e canal.
   - CRÍTICO: `oldest_ready_age_seconds` > 30 min com `ready` > 0 e sem pausa.
   - ATENÇÃO: > 10 min; ou `errors_15m / (sent_15m + errors_15m)` > 20% com ≥ 20 tentativas.
   - Fila pausada por falta de saldo não é alerta de fila (é de saldo).
4. **Fornecedor** — fontes já lidas por `getChannelObservability` / `getProviderAuthHealth`:
   `provider_circuit_breakers`, `dispatch_rate_state`.
   - CRÍTICO: disjuntor aberto por `auth` ou `no_balance` (Short Brasil sem saldo, Infobip
     recusando credencial).
   - ATENÇÃO: `backoff_until` no futuro por erro do provedor; Short.io com mais de 20% dos links
     adiados nas últimas 6 execuções (`dispatcher_runs.rate_limited` de `shortio_sync`).
5. **Saldo acabando** — fonte `billing_runway_alert_candidates` (já usa consumo de 24 h).
   - CRÍTICO: casa não isenta com `runway_hours` < 6 (`RUNWAY_URGENT_HOURS`).
   - ATENÇÃO: < 24 h (`RUNWAY_ALERT_HOURS`).
6. **Cobrança** — fonte `checkBillingHealth` (o mesmo do card de saúde da cobrança): cada
   `finding` vira um alerta com a mesma severidade e mensagem; link para `/admin#faturamento`.

Cada fonte é lida de forma independente: se uma falhar, a faixa mostra "Não foi possível verificar
<fonte>" como ATENÇÃO e as outras continuam.

### 5.3 Tabela de casas
Colunas: **Casa · Cadastros · FTDs · Conversão · Recuperação CRM**. Cada célula mostra o valor dos
últimos 7 dias completos (até ontem, fuso America/Sao_Paulo) e, ao lado, a variação contra a
**base** = média semanal das 4 semanas anteriores (dias −35 a −8).

- Cadastros e FTDs: `finance_days` (mesmos números do Financeiro e do Início, de
  `tenant_daily_metrics`). Variação em %.
- Conversão: FTDs ÷ cadastros do período. Variação em **pontos percentuais**.
- Recuperação CRM: `crm_influenced_revenue` de `finance_activity_days` — o mesmo número que a
  Central de Resultados chama de recuperado. Na moeda da casa. Variação em %. *(O esboço de 05/11
  usou receita direta por clique; o correto é influenciada. O builder deve confirmar com o rótulo
  da Central de Resultados.)*
- **Situação** (bolinha + motivo em texto, decisão do Claude):
  - Vermelho: cadastros ou FTDs ≤ −50%, ou conversão ≤ −10 pts, ou recuperação ≤ −50%.
  - Amarelo: ≤ −25%, ou conversão ≤ −5 pts, ou recuperação ≤ −25%.
  - Verde: o resto.
  - Cada regra só vale se a base da métrica tiver volume mínimo: ≥ 20 cadastros/semana para
    cadastros e conversão, ≥ 10 FTDs/semana para FTDs, recuperação base ≥ 500 na moeda da casa.
  - Cinza "sem histórico": menos de 3 das 4 semanas da base com algum cadastro (casa nova).
  - "Sem movimento": zero cadastros e zero FTDs nos últimos 7 dias e na base; essas casas vão
    para uma linha resumida no fim da tabela.
  - O motivo é a pior regra disparada, em texto: "Cadastros −83% (107 vs ~636/semana)".
- Ordem: vermelho, amarelo, verde, sem histórico; dentro de cada grupo, pela maior queda.
- Clique na casa: troca a casa ativa no cabeçalho para ela e abre `/resultados`. *(Decisão do
  Claude.)*
- Rodapé: "Últimos 7 dias até DD/MM contra a média das 4 semanas anteriores. Casas demo fora."

### 5.4 Custo e dados
- Uma server function `adminPlatformHealth` (GET, superadmin) devolve
  `{ checkedAt, alerts[], houses[], quietHouses[] }`. Leituras em paralelo, cada uma com timeout
  próprio; `finance_days`/`finance_activity_days` uma vez para todas as casas e 35 dias.
- **Webhook** é a única leitura nova. Preferência: consulta por casa usando o índice
  `webhook_logs_tenant_status_created_idx` (último evento + contagem de 24 h e de 7 dias) para as
  ~15 casas, em paralelo limitado. Se a contagem de 7 dias custar caro (medir no banco com
  `EXPLAIN ANALYZE` antes), usar uma função SQL pequena — isso vira migração e precisa de ok.
- Cache em memória do servidor de 60 s por resultado completo (o superadmin é uma pessoa; evita
  recarga em sequência pesar no banco).

## 6. F2 — Aba Financeiro geral

Lugar: `/admin`, aba **Financeiro geral** (hash `#financeiro-geral`), seletor de mês (padrão: mês
atual). *(A aba Faturamento continua sendo onde se age sobre a cobrança; esta é de leitura.)*

1. **Cartões do mês** (por moeda): mensalidades recebidas, recargas recebidas, consumo vendido,
   custo de fornecedor (Short Brasil | Infobip), taxa Pix, **margem** (receita líquida − custo).
2. **Mensalidades por estado** (Stripe): cartões clicáveis Em dia · Vence em 5 dias · Vencida
   (dias de atraso) · Bloqueada · Aguardando primeiro pagamento · Isenta. Abaixo, a lista das casas
   que devem, ordenada por valor e dias de atraso. Fonte: `tenant_billing.access_state` +
   `billing_invoices`.
3. **Tabela por casa**: estado da mensalidade, mensalidade paga, recargas (quantidade e valor),
   consumo SMS/voz/e-mail, custo Short Brasil, custo Infobip, taxa Pix, margem, isenta. Ordenável;
   as piores margens no topo por padrão. Exporta o mesmo CSV que já existe.
4. **Custo por fornecedor**: SMS → Short Brasil; voz e e-mail → Infobip. Enquanto
   `tenant_channel_providers` estiver vazio essa regra é exata; se uma casa passar a ter fornecedor
   próprio por canal, o custo dela tem que vir de `provider_account_id` dos logs de envio (o
   builder deve tratar ou mostrar aviso). Custo `null` = "não cadastrado".
5. **Movimentos do mês** (ChartMogul simplificado): casas novas pagantes, casas que deixaram de
   pagar (bloqueadas/congeladas), reativadas.

Regra de implementação: tirar o cálculo por casa de `adminBillingMonthlyCsvFor`
(`src/lib/billing/billing-admin.functions.ts:1228`) para uma função pura usada **pelo CSV e pela
tela**, para os dois nunca divergirem.

## 7. F3 — Ciclo de vida dos alertas e resumo diário

- Tabela `platform_alerts` (migração): chave (`tipo` + `casa` + `assunto`), severidade, mensagem,
  aberto em, visto pela última vez, contador, estado (aberto / reconhecido / silenciado até /
  resolvido em). Um cron a cada 5 min roda as mesmas regras de F1 e abre, atualiza ou resolve.
- Na faixa: botões **Reconhecer** e **Silenciar 24 h**; "Histórico" com os resolvidos dos últimos
  30 dias.
- **Resumo diário** às 8h (BRT) por e-mail para os superadmins: alertas abertos, casas vermelhas e
  amarelas com motivo, mensalidades vencidas, saldos acabando. Críticos novos fora do horário: e-mail
  imediato, no máximo um por chave a cada 6 h.
- `system_alerts` (tabela antiga, nunca lida) é substituída; o `morning-check` passa a gravar em
  `platform_alerts`.

## 8. O que fica para o builder
- Nomes de componentes/arquivos, layout fino, textos de link exatos.
- Como ler o "período esperado" de cada job (mapa em TS) e quais jobs entram.
- Se a leitura de webhook cabe sem migração (medir antes).
- Testes: regras de alerta e de situação como funções puras com testes de tabela; server function
  testada via `xFor(ctx)` com `createFakeDb`; componentes com `renderToStaticMarkup`.

## 9. Ideias futuras (registradas, fora do escopo)
- Health score 0–10 por grupos (aquisição, conversão, CRM, técnico) com tendência.
- Baseline por mesmo dia da semana (mediana de 4–6 semanas) para alertas diários.
- Uplift real do CRM por casa a partir do grupo de controle das jornadas.
- Custo por FTD recuperado por casa como argumento comercial.
- Conciliação mensal com as faturas de Short Brasil e Infobip.

## 10. Ordem
F1 primeiro (é o que o usuário quer ver de manhã e não precisa de migração), depois F2, depois F3.
Cada fase é entregue, revisada e publicada antes da seguinte.
