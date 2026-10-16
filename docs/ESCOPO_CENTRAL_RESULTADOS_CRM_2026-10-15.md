# Escopo — Central de Resultados do CRM (recuperação, redepósito, custo e funil)

**Data:** 15/10/2026
**Status:** proposto para validação
**Base:** auditoria de código do estado atual. Este documento complementa o
[escopo de funil de 08/10](ESCOPO_FUNIL_CONVERSAO_CAMPANHAS_JORNADAS_2026-10-08.md),
que criou a atribuição por clique (`conversion_attributions`). O escopo de 08/10 continua
válido; este cobre o que ficou de fora: medir recuperação sem depender só de clique,
custo real, retenção, a página inicial e uma área própria de análise.

**Perspectivas aplicadas:** UX, dev sênior, QA, gerente de projeto e red team. Cada achado
foi reavaliado individualmente (linha **Reavaliação**) e, quando possível, recebe uma
proposta de melhoria.

---

## 1. Resumo executivo

O operador vê "O CRM recuperou R$ 0 com R$ 10.137,9 de mensagem — 0x". Esse número **não
mede o que o CRM faz hoje**. Ele soma três defeitos:

1. **"Recuperado pelo CRM" só conta follow-ups manuais.** A regra exige um registro em
   `lead_followups` antes do depósito. Essa tabela só recebe linhas quando um operador
   registra contato à mão (telas Jogadores, Alertas e Conversão pendente). Jornadas e
   campanhas nunca gravam ali. Os ~51 mil SMS automáticos do período não podem gerar
   nenhum real de "recuperado".
2. **O relatório de Conversão está truncado em 1.000 linhas.** A busca de origens pede
   10.000 linhas, mas o Supabase devolve no máximo 1.000, sem erro. Resultado: aparecem
   só 2 origens (999 + 1 = 1.000 envios) e **nenhuma jornada**. Cada origem também é
   cortada em 1.000 envios.
3. **A atribuição existente exige clique humano.** Hoje (15/10) os cliques do crawler do
   Short.io foram removidos; eram ~97% dos "cliques". Sem clique humano antes do
   depósito, a conversão direta fica corretamente em zero. Em reativação de base antiga,
   porém, muita gente volta sem clicar (abre o app direto). O sistema não tem nenhuma
   forma de medir esse efeito.

Também há indicadores com rótulos que não correspondem ao cálculo: "Jornadas ativas 0/0"
conta a tabela antiga `sms_flows`, e "Na fila da jornada" conta jogadores sem login há
7 dias, não a fila real.

**O que o banco mostra (Sorte Alta, 30 dias):**

| Indicador | Tela mostra | Banco |
|---|---|---|
| Jornadas ativas | 0/0 | **12 ativas, 1 pausada** |
| Na fila da jornada | 3.113 | **20.789 jogadores** (99,7% da base de 20.862) em **34.342 matrículas** abertas: o mesmo jogador pode estar em várias jornadas (ver D-16) |
| Envios rastreados (Conversão) | 1.000, 2 origens | **28.251** envios, **20 origens** (11 jornadas, 7 campanhas, 2 manuais) |
| Conversões diretas | 0 / R$ 0 | **24 depósitos / R$ 960** (todos de jornadas, todos de hoje) + 16 logins — escondidos pelo corte |
| Follow-ups manuais (base do "Recuperado") | — | **0** nos últimos 60 dias |
| Custo por SMS | R$ 0,196 | **R$ 0,12** (preço padrão; o tenant não tem preço próprio) |
| SMS cobrados | todos os logs | 56.958 reservados − 624 estornados (falhas) = **56.334** → **R$ 6.760**, não ~R$ 11,2 mil |
| Cliques | — | **207 humanos × 6.469 robôs** (97% robô) |

**Expectativa realista:** quase todo o volume de SMS (56.955 de 56.978) saiu nos últimos
7 dias; a operação de CRM tem cerca de uma semana. Uma estimativa do nível "influenciado"
(depósito de jogador inativo há 3+ dias, até 3 dias depois de receber SMS) dá **54
jogadores e R$ 3.450** no período. No mesmo período, **1.888 dos 1.940** retornos de
inativos aconteceram **sem** SMS nos 7 dias anteriores. Ou seja: corrigir as métricas não
vai, por si só, mostrar um ROI alto. Vai mostrar a verdade, e é justamente isso que a
Central precisa expor (cobertura dos inativos, custo por recuperado e grupo de controle).

**Proposta:** criar a **Central de Resultados do CRM**, sustentada por uma camada única
de definições e agregados diários. A recuperação é medida em três níveis, sempre
separados e nunca somados:

| Nível | Pergunta que responde | Como mede | Confiabilidade |
|---|---|---|---|
| **Direto** | "Quem clicou e depositou?" | clique humano → depósito em até 7 dias (já existe) | alta, mas subestima |
| **Influenciado** | "Quem recebeu e voltou?" | mensagem enviada/entregue → depósito em até N dias, mesmo sem clique | média: superestima, pois inclui quem voltaria sozinho |
| **Incremental** | "Quanto o CRM realmente gerou?" | grupo de controle (holdout) sem envio × grupo tratado | a única medida causal |

Some-se a isso o **custo real por envio** (preço do tenant × créditos, por canal, origem e
etapa). Com isso dá para responder onde o lead é recuperado, onde não é e quanto custa
cada recuperação.

---

## 2. Método e limitações

- Auditoria feita no código (`src/`) e nas migrations (`supabase/migrations/`), branch
  `main` em 15/10/2026 (commit `228db42`).
- **Validação em produção (15/10/2026, somente leitura):** consultas agregadas no banco,
  tenant Sorte Alta, período de 15/09 a 15/10/2026. Os resultados estão na seção 11 e
  foram incorporados à reavaliação de cada item.
- A página "Aquisição e LTV" (`src/routes/midia-ltv.tsx`) não foi auditada em
  profundidade. Ela está listada como item de levantamento na Fase 4.

---

## 3. Inventário do estado atual

| Tela | Fonte | Observação |
|---|---|---|
| Início: cards de KPI, Retenção & CRM, Régua de reativação, Insight | `getDashboardSummary` ([dashboard.functions.ts](../src/lib/dashboard.functions.ts)) → RPC `dashboard_summary_v2` ([migration 20261002170000](../supabase/migrations/20261002170000_optimize_analytics_queries.sql)) | mistura `tenant_daily_metrics` (agregado diário) com consultas diretas |
| Conversão executiva `/relatorios/conversao` | `getExecutiveConversionReport` ([conversion-p2.functions.ts:140](../src/lib/conversion-p2.functions.ts#L140)) | só `link_dispatches` + `conversion_attributions`; sem custo nem cliques |
| Relatório de campanha `/campanhas/$id/relatorio` | `getConversionReport` / `getCampaignReportDetails` ([conversion-report.functions.ts](../src/lib/conversion-report.functions.ts)) | paginação correta (`selectAllPages`) |
| Relatório de jornada `/jornadas/$id/relatorio` | `getJourneyReportDetails` | funil por etapa existe, mas só com atribuição por clique |
| Jornadas | `journeys`, `journey_enrollments` (com `exit_reason`), `journey_step_executions` | a saída por `deposit` existe, mas não grava qual depósito nem o valor |
| Custo | constante `SMS_UNIT_COST = 0.196` no código | existem `tenant_sms_pricing` e `sms_credit_ledger`, que não são usados |

---

## 4. Achados por perspectiva

Formato de cada item: **achado → evidência → impacto → reavaliação → melhoria**.
Severidade: **S1** = número errado ou enganoso exibido ao cliente; **S2** = falta de
capacidade essencial; **S3** = qualidade e manutenção.

### 4.1 Dev sênior — dados e cálculo

#### D-01 · "Recuperado pelo CRM" ignora jornadas e campanhas — S1
- **Evidência:** CTE `recovered` em `dashboard_summary_v2` (migration 20261002170000, linhas
  252–269): `exists (select 1 from lead_followups ...)`. Os únicos pontos que gravam
  `lead_followups` são [players.tsx:2619](../src/routes/players.tsx#L2619),
  [alertas.tsx:562](../src/routes/alertas.tsx#L562) e
  [pending-conversion.functions.ts:159](../src/lib/pending-conversion.functions.ts#L159),
  todos manuais.
- **Impacto:** o principal número do CRM fica permanentemente em ~0 para quem opera por
  automação. O "ROI 0x" sugere que o produto não funciona.
- **Reavaliação:** confirmado no código e no banco: **0 follow-ups** na Sorte Alta nos
  últimos 60 dias, portanto o número é estruturalmente zero. A regra também tem um viés
  oposto: qualquer depósito posterior a um follow-up dos últimos 30 dias conta, mesmo de
  jogador que nunca parou de jogar. Para quem usa follow-up manual, o número infla.
- **Melhoria:** substituir pela métrica em 3 níveis (seção 5.2). O follow-up manual vira
  mais uma origem (`source_type = 'manual_followup'`), com as mesmas regras de
  elegibilidade e janela.

#### D-02 · Relatório executivo truncado em 1.000 linhas e sem jornadas — S1
- **Evidência:** [conversion-p2.functions.ts:147-154](../src/lib/conversion-p2.functions.ts#L147-L154)
  usa `.limit(10000)`; o PostgREST corta em 1.000 (`max_rows`) sem erro. Em
  `sourceMetric` (linhas 70–85), as consultas de envios e de atribuições não têm
  paginação. O próprio repositório documenta o problema em
  [conversion-report.functions.ts:51-56](../src/lib/conversion-report.functions.ts#L51-L56)
  e o resolve com `selectAllPages`, mas só no relatório por origem.
- **Impacto:** a tela mostra exatamente 1.000 envios e esconde todas as jornadas.
- **Reavaliação:** confirmado no banco: há **28.251 envios em 20 origens** (11 jornadas,
  7 campanhas, 2 manuais) no período; a tela mostra 1.000 em 2 origens. As **24
  conversões diretas (R$ 960)** existentes são todas de jornadas (Dormindo 7d: 8 / R$ 370;
  Esfriando 2d: 8 / R$ 300; Nível Ouro: 5 / R$ 70; PIX não pago: 2 / R$ 200; Cadastrou e
  não depositou: 1 / R$ 20) e por isso não aparecem.
- **Melhoria:** curto prazo: listar origens por `select distinct` em RPC e reutilizar
  `selectAllPages`. Definitivo: ler do agregado `crm_results_daily` (seção 6) e exibir um
  aviso de "dados truncados" quando houver corte.

#### D-03 · Envio é contado por link, não por destinatário — S2
- **Evidência:** `sourceMetric` conta linhas de `link_dispatches`, e há uma linha por URL
  da mensagem (`url_position`, [shortio.server.ts:1326](../src/lib/shortio.server.ts#L1326)).
  O relatório por origem usa `uniqueDeliveryCount`, mas o executivo não.
- **Impacto:** uma mensagem com 2 links conta 2 envios, e mensagens sem link não contam.
  O executivo e o relatório por origem divergem.
- **Reavaliação:** confirmado no código; o tamanho do efeito depende dos templates.
- **Melhoria:** a unidade de envio passa a ser a **mensagem lida no log do canal**
  (`sms_send_logs`, execuções de jornada, logs de e-mail/WhatsApp), não o link.

#### D-04 · Custo é constante fixa, só de SMS, incluindo falhas — S1
- **Evidência:** `SMS_UNIT_COST = 0.196` em
  [dashboard.functions.ts:73](../src/lib/dashboard.functions.ts#L73), multiplicado por
  `count(*)` de `sms_send_logs` sem filtrar status (CTE `sms`). Existem
  `tenant_sms_pricing.sale_price_per_sms`, `provider_cost_per_sms` e `sms_credit_ledger`
  (migration 20260922193000), que não são usados aqui. WhatsApp, e-mail e voz não entram.
- **Impacto:** o custo exibido não corresponde ao que o tenant paga. Falhas são cobradas
  no painel mesmo que não consumam crédito. Não dá para saber o custo por jornada,
  campanha ou etapa.
- **Reavaliação:** confirmado no banco. O tenant não tem linha em `tenant_sms_pricing`;
  o ledger registra **R$ 0,12** por SMS (padrão), não R$ 0,196. Falhas são estornadas
  (624 `sms_refund` para 628 logs com erro). Custo real em 30 dias: (56.958 − 624) ×
  R$ 0,12 = **R$ 6.760**. Pela fórmula atual (todos os logs × 0,196), o painel mostraria
  ~R$ 11.167: **65% acima do real**. Os R$ 10.137,9 da captura correspondem a 51.724
  logs, ou seja, à leitura feita num período um pouco menor.
- **Melhoria:** gravar o custo **no momento do envio**, por mensagem: canal, créditos
  (segmentos), preço unitário vigente e origem/etapa. O painel soma; não recalcula. Para o
  super admin, exibir também o custo do provedor (margem).

#### D-05 · "Jornadas ativas 0/0" conta a tabela errada — S1
- **Evidência:** CTE `flow_counts` lê `public.sms_flows` (régua legada). As jornadas atuais
  estão em `public.journeys` (migration 20261005120000).
- **Impacto:** o cliente vê 0/0 com jornadas rodando.
- **Reavaliação:** confirmado no banco: `sms_flows` está vazia; `journeys` tem **12
  ativas e 1 pausada**.
- **Melhoria:** contar `journeys` por `status`: ativas / pausadas / rascunho. Exibir, por
  exemplo, "6 ativas · 2 pausadas" e linkar para `/jornadas`.

#### D-06 · "Na fila da jornada" não é fila — S1
- **Evidência:** CTE `other.reactivation_queue` conta
  `players where ultimo_login < now() - 7 days`. Não lê `journey_enrollments`.
- **Impacto:** o rótulo promete "na fila da jornada"; o número é "inativos há 7+ dias,
  desde sempre". 3.113 não tem relação com a fila.
- **Reavaliação:** confirmado no banco: estão em jornada **20.789 jogadores distintos**
  (34.342 matrículas abertas, já que um jogador pode estar em várias; ver D-16), contra
  3.113 exibidos. O conceito de "base inativa" é útil, mas com outro nome. A
  quantidade "pausada por prioridade" também merece um indicador próprio: são jogadores
  parados porque estão em outra jornada.
- **Melhoria:** separar em dois indicadores. **Em jornada agora** (jogadores distintos
  com matrícula `active`/`waiting`, nunca contagem de matrículas) e **Base inativa elegível** (inativos por faixa:
  esfriando / dormindo / 30+ dias, com a mesma definição usada nas jornadas).

#### D-07 · Redepósito depende de `ftd_em`, que está inconsistente — S1
- **Evidência:** CTE `cur_redeposits` exige `p.ftd_em is not null and d.created_at >
  p.ftd_em + 1 minute`.
- **Impacto:** todo depósito feito antes do `ftd_em` registrado do jogador some dos
  redepósitos, e "Depósitos − FTD ≠ Redepósitos".
- **Reavaliação (banco, 30 dias):** a hipótese original (jogadores sem `ftd_em`) é
  pequena: 113 depósitos, R$ 5,7 mil. O problema real é outro: **2.948 depósitos
  aprovados (R$ 176,6 mil), de ~2.009 jogadores, ocorreram antes do `ftd_em` do próprio
  jogador**. Ou seja, `ftd_em` está posterior ao primeiro depósito real. Por isso a regra
  atual soma R$ 4,11 mi de redepósito em um total de R$ 4,53 mi depositados. A definição
  alternativa ("primeiro depósito no banco") também falha, porque o histórico de
  `deposits` só começa em 02/09/2026: jogadores antigos teriam o primeiro depósito do
  banco contado como FTD. O flag `isFtd` do webhook existe em metade dos depósitos
  (2.644 `true`, 26.620 `false`) e **falta em 29.580** (R$ 2,19 mi), provavelmente os que
  entram pelo sync de exportação. Ver D-14.
- **Melhoria:** definição canônica com fonte explícita: **FTD = depósito marcado
  `isFtd` pelo provedor**; na ausência do flag, o primeiro depósito aprovado, apenas para
  jogadores com `created_at` posterior ao início do histórico; nos demais casos, o
  depósito é tratado como redepósito. Persistir `is_first_deposit` na ingestão (webhook e
  sync), fazer backfill e corrigir `players.ftd_em` = data do depósito FTD. Invariante de
  QA: `FTD + redepósitos = depósitos aprovados`.

#### D-08 · "Reativados" é, na verdade, "nunca tinha FTD" — S1
- **Evidência:** `recoveredReactivated` = `sum(...) filter (where p.ftd_em is null)`.
- **Impacto:** o rótulo "reativados" descreve o oposto do cálculo (quem nunca depositou),
  e o "de quem já jogava" é obtido por subtração.
- **Reavaliação:** confirmado.
- **Melhoria:** classificar o jogador **no momento do envio** por estado de ciclo de vida:
  `novo sem FTD`, `ativo`, `esfriando`, `dormindo`, `perdido 30+`. Reativação = depósito
  de quem estava em `esfriando`, `dormindo` ou `perdido`.

#### D-09 · A saída de jornada por depósito é tardia e sem valor — S2
- **Evidência:** `shouldExit` ([journeys.server.ts:290-318](../src/lib/journeys.server.ts#L290-L318))
  só roda quando o próximo passo executa. Grava `exit_reason='deposit'`, mas não o
  depósito nem o valor. Se o depósito ocorre depois do último passo, a matrícula termina
  como `finished`.
- **Impacto:** a melhor evidência de "voltou durante a jornada" se perde ou chega com
  horas de atraso. Não serve como métrica.
- **Reavaliação:** confirmado.
- **Melhoria:** medir pela tabela de resultados (seção 6), ligando depósito ↔ última
  mensagem enviada ao jogador, e não por `exit_reason`. Opcionalmente, um gatilho no
  depósito marca a matrícula ativa como `converted` com `deposit_id`, o que também
  interrompe envios desnecessários (economia).

#### D-10 · Comparação com o período anterior é desigual — S3
- **Evidência:** o período atual inclui hoje parcial; o anterior é cheio
  ([dashboard.functions.ts:111-116](../src/lib/dashboard.functions.ts#L111-L116)). Com
  `reset_at` no meio do período anterior, o recorte também fica desigual.
- **Impacto:** o "↓ 26,5% vs. período anterior" tende a negativo em períodos que incluem
  hoje.
- **Reavaliação:** o efeito é pequeno em 30 dias (~3%) e grande em "Hoje" e "7 dias".
- **Melhoria:** comparar "até a mesma hora" (hoje até 16h × ontem até 16h) ou excluir o
  dia corrente da comparação e informar isso na legenda.

#### D-11 · Mistura de fontes no mesmo painel — S3
- **Evidência:** valores de depósito vêm de `tenant_daily_metrics` (por dia, inclusive
  `reset_at` truncado no dia); depositantes e redepósitos vêm de `deposits` (por
  timestamp).
- **Impacto:** cards da mesma tela podem não fechar entre si, por exemplo com `reset_at`
  no meio do dia.
- **Reavaliação:** é um efeito de borda, mas mina a confiança.
- **Melhoria:** uma única camada semântica (seção 6) usada por todas as telas.

#### D-12 · Código morto que diverge da produção — S3
- **Evidência:** `fetchDashboardLegacy` ([index.tsx:230-586](../src/routes/index.tsx#L230-L586))
  não é chamada e tem regras próprias (por exemplo, follow-ups sem limite de 30 dias).
  `SMS_UNIT_COST` está duplicado ([index.tsx:107](../src/routes/index.tsx#L107)).
- **Melhoria:** remover. Esse código induz manutenção na regra errada.

#### D-13 · O atalho de "Conversão" na campanha não reaproveita o relatório por origem — S3
- **Evidência:** o executivo (`sourceMetric`) e o relatório por origem (`getConversionReport`)
  calculam envios, entregas e conversões com código diferente.
- **Melhoria:** as duas telas passam a ler do mesmo agregado.

#### D-14 · `ftd_em` e o flag de FTD não têm fonte única — S1 (novo, achado no banco)
- **Evidência:** ver a reavaliação de D-07. Metade dos depósitos do período não tem
  `isFtd` no `raw_payload`. O `ftd_em` é anterior a vários depósitos do mesmo jogador. O
  card "FTD" da página inicial usa `players.ftd_em` (7.302 no período), enquanto o
  webhook marcou 2.644 FTDs nos depósitos que trazem o flag.
- **Impacto:** FTD, redepósito, "conversão cadastro → FTD" e o funil de aquisição podem
  estar errados ao mesmo tempo, em direções diferentes.
- **Reavaliação:** confirmado como inconsistência. A causa (qual caminho grava `ftd_em`
  mais tarde, se o webhook ou `scripts/sync-sortealta-export.mjs`) ainda precisa de
  investigação dedicada antes da F1.
- **Melhoria:** item próprio na F1: rastrear quem escreve `ftd_em`, definir a fonte de
  verdade (D-07), fazer backfill e adicionar um alerta diário de "depósito anterior ao
  `ftd_em`".

#### D-15 · A maior parte dos retornos de inativos acontece sem contato — S2 (novo, achado no banco)
- **Evidência:** em 30 dias, **1.940 depósitos** foram de jogadores que estavam há 3+ dias
  sem depositar (R$ 112,3 mil). Desses, **1.888 não receberam SMS** nos 7 dias anteriores.
  Só 54 jogadores inativos depositaram até 3 dias depois de um SMS (R$ 3.450). Das 807
  vezes em que um depósito veio até 3 dias após um SMS, 753 foram de jogadores que
  **já estavam ativos**.
- **Impacto:** as campanhas em massa (cerca de 40 mil SMS em 12 e 13/10) parecem atingir
  principalmente quem já está jogando. Isso gera custo sem recuperação, e a Central
  precisa mostrar esse desperdício.
- **Reavaliação:** é uma estimativa (nível "influenciado", janela de 3 dias). A operação
  de jornadas tem cerca de 7 dias, e muitas janelas ainda estão abertas. A conclusão
  "mira em ativos" deve ser revalidada com 30 dias completos de operação.
- **Melhoria:** na Central, mostrar **cobertura** (% dos inativos que receberam contato) e
  **desperdício** (custo de envios a jogadores ativos). Nas campanhas, oferecer o filtro
  "excluir quem depositou nas últimas X horas" como padrão.

#### D-16 · Matrícula ≠ jogador: a base inteira está em jornada, com sobreposições — S1 (novo, achado no banco)
> **Correção das regras movida para escopo próprio:**
> [ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15.md](ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15.md).
> Nesta Central fica apenas a medição: contar jogadores distintos e expor sobreposição e
> pausas como métricas.
- **Evidência (matrículas abertas = `active` + `waiting` + `paused_by_priority`):**
  - 34.342 matrículas correspondem a **20.789 jogadores distintos**, contra uma base de
    20.862 (99,7%). Distribuição: 13.323 jogadores em 1 jornada, 1.964 em 2, **5.012 em
    3**, 454 em 4 e 38 em 5 ou mais.
  - **Faixas de inatividade sobrepostas:** 5.429 jogadores estão ao mesmo tempo em mais de
    uma entre "Esfriando 2d", "Dormindo 7d" e "30 dias", faixas que deveriam ser
    exclusivas. A prioridade pausa uma delas (4.279 pausadas em Esfriando), mas a
    matrícula continua aberta.
  - **Jornada pausada segurando a base:** "Boas-vindas ao primeiro depósito (FTD)" está
    pausada e mantém 7.818 jogadores, ou seja, 95% dos 8.197 depositantes; não são só
    FTDs novos. As 5.743 matrículas "ativas" estão paradas desde 14/10 (último
    `updated_at` 14/10 22h05). Pela prioridade, elas podem estar bloqueando outras
    jornadas desses jogadores (1.602 pausadas por prioridade nela).
  - **"PIX gerado e não pago" abre uma matrícula por PIX:** a `entry_key` é por PIX, então
    um jogador chegou a 16 matrículas simultâneas na mesma jornada (103 pares
    jogador × jornada repetidos, 207 matrículas extras). Hoje a regra de mensagem obsoleta
    reduz o risco, mas o desenho permite várias mensagens iguais seguidas.
  - "Cadastrou e não depositou" ainda tem 17 jogadores que já depositaram (a saída só é
    avaliada no próximo passo, D-09).
- **Impacto:** qualquer métrica "por matrícula" (fila, taxa de conversão da jornada,
  custo por matriculado) fica inflada e não bate com a base. Um depósito pode ser
  reivindicado por 3 a 5 jornadas ao mesmo tempo (R-02). Também há risco de excesso de
  contato.
- **Reavaliação:** confirmado no banco. Parte é intencional (prioridade entre jornadas),
  mas o volume de sobreposição e a jornada pausada retendo matrículas não são.
- **Melhoria:**
  - Os indicadores passam a contar **jogadores distintos**; matrícula só aparece no
    detalhe da jornada.
  - A Central mostra "jogadores em jornada", "em mais de uma jornada" e "parados por
    prioridade".
  - Saída imediata das faixas de inatividade ao cruzar para a próxima, em vez de
    pausa.
  - Ao pausar uma jornada, decidir explicitamente se as matrículas liberam a prioridade.
  - Em "PIX não pago", uma matrícula por jogador (a nova entrada substitui a anterior).
  - Revisar o backfill de "Boas-vindas FTD", que não deveria incluir depositantes
    antigos.

### 4.2 UX — designer especialista

#### U-01 · O insight afirma um fato errado com tom de veredito — S1
- **Evidência:** [index.tsx:1014-1030](../src/routes/index.tsx#L1014-L1030).
- **Impacto:** "0x o que custou" em destaque verde induz o cliente a concluir que o CRM
  não paga a conta.
- **Reavaliação:** confirmado; é consequência de D-01 e D-04.
- **Melhoria:** o insight passa a ser gerado por regras com contexto:
  - "Jornadas trouxeram de volta **142 jogadores** (R$ 38,2 mil) — **R$ 12,40 por
    jogador recuperado**. A jornada *Dormindo 15d* é a mais eficiente."
  - quando não houver dado suficiente: "Ainda não há envios com mais de 7 dias para medir
    retorno", em vez de 0x;
  - sempre com o nível (direto ou influenciado) explícito e link para o detalhe.

#### U-02 · "Ver relatórios completos" não faz nada — S1
- **Evidência:** `<Button>` sem `onClick` nem `Link` ([index.tsx:1026](../src/routes/index.tsx#L1026)).
- **Melhoria:** levar para a Central de Resultados com o mesmo período aplicado.

#### U-03 · Linhas com seta (›) que não são clicáveis — S2
- **Evidência:** `InfoRow` com `chevron` é uma `div` sem link ([index.tsx:725-765](../src/routes/index.tsx#L725-L765)).
- **Impacto:** a affordance promete navegação que não existe.
- **Melhoria:** toda linha com › vira link para o recorte correspondente (fila → jornadas;
  ROI → Central/Custo). Linhas sem destino perdem a seta.

#### U-04 · Moeda formatada com 1 casa decimal — S2
- **Evidência:** `brl()` usa `minimumFractionDigits: 0` ([format.ts:1-8](../src/lib/format.ts#L1-L8)),
  o que produz "R$ 10.137,9".
- **Melhoria:** moeda sempre com 2 casas, ou compacta em cards ("R$ 10,1 mil") com o valor
  exato no tooltip.

#### U-05 · Percentual em formato americano no relatório de conversão — S3
- **Evidência:** a coluna "Taxa" mostra "0.0%" (captura 3).
- **Melhoria:** usar `fmtPct` pt-BR em todo o produto.

#### U-06 · Não existe lugar para analisar; só cartões soltos — S2
- **Impacto:** a pergunta "onde estou recuperando e quanto custa?" exige abrir cada
  jornada. Não há comparação, ranking nem visão por etapa, canal ou segmento.
- **Melhoria:** a Central de Resultados (seção 7) organiza a navegação como "visão geral →
  ranking → origem → etapa → jogador".

#### U-07 · Termos ambíguos e sem definição — S2
- **Evidência:** "Recuperado", "Retorno sobre o envio", "Conversões diretas",
  "Receita assistida" sem explicação; "Clicaram e depositaram" ao lado de "Recuperado",
  como se fossem a mesma base.
- **Melhoria:** glossário fixo (seção 5.1). Cada número tem um ícone (i) com a definição,
  a janela e a fonte. Usar os mesmos nomes em todas as telas.

#### U-08 · O relatório executivo identifica a origem por UUID — S3
- **Evidência:** captura 3: o UUID aparece em destaque abaixo do nome.
- **Melhoria:** mostrar tipo (Campanha SMS / Jornada), canal e status; mover o UUID para
  um menu "copiar ID". A linha inteira leva ao relatório da origem.

#### U-09 · Estados vazios não explicam a causa — S2
- **Impacto:** "0 conversões" pode significar sem envios, sem clique humano, janela ainda
  aberta ou corte de dados. O usuário não distingue.
- **Melhoria:** estados vazios diagnósticos ("Envios dos últimos 7 dias ainda estão dentro
  da janela de medição", "Nenhum clique humano: 4.210 cliques de robôs foram descartados").

#### U-10 · Os dois "funis" da página inicial confundem — S3
- **Evidência:** o "Funil de aquisição" passa de 100% e precisa de nota explicativa
  ([index.tsx:1215-1260](../src/routes/index.tsx#L1215-L1260)).
- **Melhoria:** o funil de aquisição fica restrito à coorte de cadastros do período
  (cadastro → FTD → 2º depósito → 3º+). A base antiga vai para Retenção.

### 4.3 QA

#### Q-01 · Não há testes de reconciliação entre telas — S2
- **Impacto:** os erros D-02, D-05 e D-07 passaram despercebidos.
- **Melhoria:** suíte de invariantes que roda em CI contra um dataset sintético e,
  diariamente, em produção (alerta, não bloqueio):
  1. `FTD + redepósitos = depósitos aprovados` (valor e quantidade);
  2. soma por origem = total do período (envios, custo, receita);
  3. direto ⊆ influenciado (todo depósito direto também é influenciado);
  4. nenhum depósito é creditado a mais de uma origem dentro do mesmo nível;
  5. custo da Central = soma do `sms_credit_ledger` do período (com tolerância
     documentada);
  6. executivo = soma dos relatórios por origem.

#### Q-02 · Nenhum teste cobre volume acima de 1.000 linhas no executivo — S2
- **Melhoria:** teste com mock de 2.500 envios, 3 origens e jornada, garantindo que todas
  apareçam. Lint/regra de revisão: nenhuma consulta a tabela grande pode depender de
  `.limit()` acima de 1.000.

#### Q-03 · Bordas de fuso e de janela — S2
- **Casos obrigatórios:** depósito às 23h59 e às 00h00 BRT; envio no dia 1 e depósito no
  dia 7 às 23h59 (direto) e no dia 8 às 00h01 (assistido/fora); horário de verão
  histórico; período "Hoje" comparado com ontem até a mesma hora.

#### Q-04 · Bots e testes — S2
- **Casos:** clique do crawler (UA conhecido) não gera conversão direta; envios de teste e
  "Individual" (envio manual a 1 número) não entram em rankings de eficiência; contas
  internas são excluídas.

#### Q-05 · Idempotência e reprocessamento — S2
- **Casos:** webhook de depósito duplicado, depósito aprovado → estornado, recálculo do
  agregado diário duas vezes (resultado idêntico), sync de exportação + webhook do mesmo
  depósito (`scripts/sync-sortealta-export.mjs`).

#### Q-06 · Isolamento de tenant — S1 (preventivo)
- **Casos:** usuário do tenant A não lê agregado, drill-down ou CSV do tenant B, nem
  trocando `tenantId` na chamada; o cache de servidor tem `tenantId` na chave
  ([dashboard.functions.ts:120](../src/lib/dashboard.functions.ts#L120)), e o mesmo padrão
  vale para os novos endpoints.

#### Q-07 · Dataset dourado — S2
- **Melhoria:** um fixture SQL com ~50 jogadores e casos conhecidos (novo, ativo,
  esfriando, dormindo, com clique, sem clique, holdout, bot, estorno) e os resultados
  esperados calculados à mão. Toda mudança de regra roda contra ele.

### 4.4 Red team — como os números podem mentir ou ser abusados

#### R-01 · O nível "influenciado" infla por natureza — S1 se exibido sozinho
- **Ataque/efeito:** mandar SMS para toda a base faz "quase todo depósito" virar
  "influenciado". Isso premia o envio em massa e esconde desperdício.
- **Mitigação:** (a) só conta como recuperação o depósito de quem estava **inativo no
  envio** (esfriando, dormindo, 30+); (b) janela curta (padrão 3 dias, configurável até
  7); (c) sempre exibir junto do holdout quando houver; (d) nunca somar níveis; (e) o
  ROI principal usa incremental quando disponível e direto quando não houver, nunca
  influenciado.

#### R-02 · Dupla atribuição entre jornadas, campanhas e follow-up — S1
- **Efeito:** o jogador está em 2 jornadas e numa campanha; as três reivindicam o mesmo
  depósito e a soma por origem passa do total.
- **Mitigação:** regra de crédito único por nível: **último envio elegível antes do
  depósito** recebe o crédito, com desempate determinístico (envio mais recente; depois
  jornada > campanha > manual). As demais origens recebem "tocou, mas não levou o
  crédito" (métrica de exposição, não de receita).

#### R-03 · Clique de robô e prévia de link — S1 (incidente real em 15/10)
- **Efeito:** 92% da receita atribuída estava ligada a cliques do crawler.
- **Mitigação:** manter o filtro (`is_human`), monitorar a proporção de bots por dia com
  alerta se passar de X%, e exibir na tela "cliques descartados como robô".

#### R-04 · Grupo de controle mal desenhado gera falso lift — S1
- **Efeitos:** holdout escolhido pelo operador (viés de seleção); holdout que recebe
  campanha manual (contaminação); amostra pequena tratada como certeza.
- **Mitigação:** sorteio determinístico por hash de `player_id + journey_id` no momento da
  matrícula; holdout bloqueado também em campanhas de mesma finalidade durante a janela;
  exibir intervalo de confiança e "amostra insuficiente" abaixo de N conversões.

#### R-05 · Estorno, chargeback e depósito de teste — S2
- **Mitigação:** a receita da Central usa apenas o status final aprovado; estorno remove o
  crédito no recálculo diário (agregado reprocessa D-30 → D).

#### R-06 · PII em drill-down e exportação — S1
- **Mitigação:** o drill-down por jogador e o CSV ficam restritos a admin do tenant e super
  admin (padrão já usado em `hasConversionReportAdmin`); telefone mascarado; evento de
  auditoria por exportação; limite de linhas por exportação.

#### R-07 · Consultas pesadas como vetor de indisponibilidade — S2
- **Efeito:** com Supabase Small a ~94% de CPU, um período de 365 dias com drill-down sem
  agregado derruba o painel de todos.
- **Mitigação:** telas leem só dos agregados; período máximo de 180 dias no detalhado;
  timeout e cache por tenant já existentes; refresh incremental em cron (padrão
  `betleads-refresh-dashboard-metrics`).

#### R-09 · O saldo de créditos não limita o gasto — S2 (novo, achado no banco)
- **Evidência:** ajuste manual de **+99.040.530 créditos** em 14/10 ("Saldo solicitado
  para ativação das jornadas das três casas"), deixando saldo de 99.999.999.
- **Impacto:** o saldo deixa de ser uma trava de custo. Uma jornada mal configurada pode
  gastar sem limite, e o card "créditos de SMS" perde o sentido para o cliente.
- **Mitigação:** a Central exibe o custo pelo ledger (reservas − estornos) e não pelo
  saldo. Adicionar um teto de gasto diário por tenant e por jornada, com alerta, que
  independe do saldo.

#### R-08 · Mudança de regra reescreve o passado — S2
- **Mitigação:** cada linha do agregado guarda `rule_version`; mudança de janela ou de
  definição gera versão nova, e a tela informa "regra v2 desde 20/10".

---

## 5. Modelo de medição proposto

### 5.1 Glossário canônico (usado em todas as telas)

| Termo | Definição |
|---|---|
| **Depósito aprovado** | linha de `deposits` com status final aprovado, uma vez por id do provedor |
| **FTD** | primeiro depósito aprovado do jogador (por ordem temporal, não por `ftd_em`) |
| **Redepósito** | depósito aprovado que não é o FTD |
| **Estado do jogador no envio** | `novo sem FTD` · `ativo` (<3d do último depósito) · `esfriando` · `dormindo` · `perdido 30+`. As faixas são configuráveis por tenant e iguais às das jornadas de inatividade |
| **Envio** | 1 mensagem aceita pelo provedor para 1 destinatário (não 1 link) |
| **Entregue** | só quando o provedor confirma por callback; senão "não informado" |
| **Clique humano** | `click_events.is_human = true`; um por destinatário e envio |
| **Recuperação direta** | redepósito/FTD de jogador inativo ou sem FTD, até 7 dias após clique humano |
| **Recuperação influenciada** | redepósito/FTD de jogador inativo ou sem FTD, até N dias (padrão 3) após envio, sem exigir clique; crédito ao último envio |
| **Recuperação incremental** | (taxa de retorno do tratado − taxa do controle) × tratados × ticket médio do tratado |
| **Custo** | soma do custo gravado por envio (créditos × preço unitário vigente do tenant) |
| **Custo por recuperado** | custo da origem ÷ jogadores recuperados (por nível) |
| **ROI** | receita recuperada ÷ custo (nível sempre explícito) |

### 5.2 Por que três níveis

- **Direto** é o único auditável por jogador, mas, em reativação, a maioria volta pelo app
  sem clicar, então ele subestima.
- **Influenciado** captura esse retorno, mas mistura quem voltaria sozinho.
- **Incremental** resolve as duas distorções, mas exige grupo de controle e volume.

Exibir os três lado a lado, com legenda, é o que permite ao operador confiar e decidir.
O número principal do insight segue a ordem: incremental (se houver significância) →
direto, com o influenciado como contexto.

### 5.3 Grupo de controle (holdout)

- Configurável por jornada: 0% (desligado), 5% ou 10% (padrão sugerido: 5%).
- O sorteio acontece na matrícula; a matrícula do controle é registrada com
  `is_holdout = true` e percorre a jornada sem enviar (as mesmas regras de saída valem).
- A tela de jornada mostra: taxa de retorno do tratado × controle, lift, intervalo de
  confiança e o aviso "amostra insuficiente" quando aplicável.
- Campanhas pontuais: holdout opcional no disparo.

---

## 6. Arquitetura de dados

### 6.1 Novos dados na origem

| Mudança | Onde | Motivo |
|---|---|---|
| `message_costs` (ou colunas no log de cada canal): `channel`, `segments`, `unit_price`, `cost`, `provider_cost`, `source_type`, `source_id`, `journey_step_id`, `player_id`, `sent_at` | gravado no envio (SMS, WhatsApp, e-mail, voz) | D-04 |
| `player_state_at_send` no envio | calculado no envio a partir de `ultimo_deposito` / `ftd_em` | D-08, R-01 |
| `journey_enrollments.is_holdout` | sorteio na matrícula | 5.3 |
| `deposits.is_first_deposit` (ou visão com `row_number`) | ingestão/backfill | D-07 |
| `source_type = 'manual_followup'` | follow-up manual vira origem | D-01 |

### 6.2 Agregado `crm_results_daily`

Uma linha por `tenant × dia × source_type × source_id × step_position × canal ×
estado_do_jogador × rule_version` com:

`sent, delivered, failed, unique_recipients, human_clicks, bot_clicks_discarded, cost,
provider_cost, direct_players, direct_revenue, influenced_players, influenced_revenue,
holdout_players, holdout_returned, treated_players, treated_returned`.

- Calculado por cron incremental (D-30 → hoje a cada 5–15 min para hoje; D-30 diário para
  capturar estornos e janelas que fecham), reaproveitando o padrão por tenant com
  advisory lock já usado em `betleads-refresh-dashboard-metrics`.
- Crédito do nível influenciado: função SQL que, para cada depósito elegível, encontra o
  último envio ao jogador dentro da janela (índice em `(tenant_id, player_id, sent_at)`).
- RLS por `has_tenant_access(tenant_id)`.
- **Todas** as telas (Início, Central, relatório de jornada/campanha, executivo) leem
  daqui. Nenhuma tela soma linhas brutas.

### 6.3 Agregados de retenção

- `retention_cohorts_monthly`: coorte por mês de FTD × mês relativo (M0..M12): jogadores
  ativos, redepositantes, valor.
- `player_lifecycle_daily`: contagem por estado (ativo, esfriando, dormindo, perdido) por
  dia, para mostrar o fluxo entre estados.

---

## 7. Produto — Central de Resultados do CRM

Rota sugerida: `/resultados` (menu "Visão geral" → **Resultados**), substituindo
"Conversão" no menu Engajamento. Filtros globais persistentes: **período**, **canal**,
**tipo de origem**, **estado do jogador**, **nível de atribuição**.

### 7.1 Aba "Visão geral" (P&L do CRM)
- Linha de KPIs: Receita recuperada (nível selecionado) · Jogadores recuperados ·
  Custo · Custo por recuperado · ROI · Lift (quando houver holdout).
- Gráfico diário: custo × receita recuperada (barras + linha).
- Cascata: Base inativa → Alcançados → Clicaram → Voltaram (direto) → Voltaram
  (influenciado), com taxas entre etapas.
- Insight automático (regras, não IA livre): melhor e pior origem por custo por
  recuperado, etapa com maior queda, canal mais eficiente.

### 7.2 Aba "Onde recupera" (ranking)
- Tabela de origens (jornadas, campanhas, manual) com: envios, alcance, CTR humano,
  recuperados, receita, custo, custo por recuperado, ROI, lift, tendência
  (sparkline). Ordenável; a linha leva ao relatório da origem.
- Matriz **estado do jogador × canal**: quem responde a quê (por exemplo, "dormindo
  responde a WhatsApp, esfriando a SMS").
- Destaque de **origens que gastam e não recuperam** (custo > X e ROI < 1 em 14 dias).

### 7.3 Relatório da jornada (evolução do existente)
- Funil por etapa: matriculados → etapa 1 enviada → clique → voltou → etapa 2 … com
  **queda e custo por etapa** ("a etapa 4 custa R$ 900/semana e recupera 2 jogadores").
- Motivos de saída (`exit_reason`) em gráfico: depositou, login, mudou de categoria,
  mensagem obsoleta, falha de envio.
- Tratado × controle quando houver holdout.

### 7.4 Aba "Custo"
- Custo por canal, origem e etapa; custo de falhas (se cobradas); créditos consumidos ×
  saldo; projeção de consumo do mês.

### 7.5 Aba "Retenção"
- Redepósito: valor, quantidade, jogadores, taxa de redepósito (redepositantes ÷
  depositantes do período anterior).
- Coortes por mês de FTD (heatmap M0..M12).
- Fluxo entre estados (ativos → esfriando → dormindo → perdido e retornos).
- Tempo até o 2º depósito (mediana, distribuição).

### 7.6 Aba "Aquisição"
- Funil da coorte: cadastro → FTD → 2º depósito → 3º+ (percentuais sobre cadastros do
  período, nunca acima de 100%).
- Por origem de aquisição (UTM ou mídia), integrando o que existe em "Aquisição e LTV"
  (levantamento na Fase 4).

### 7.7 Aba "Saúde dos dados"
- Última atualização do agregado; atraso de webhooks; % de cliques descartados como
  robô; envios sem custo gravado; depósitos sem jogador; invariantes de QA (seção 4.3)
  com status verde ou vermelho. Visível para admin.

### 7.8 Página inicial (ajustes)
- Insight reescrito (U-01) e botão funcional (U-02).
- "Retenção & CRM": Redepósitos (definição canônica) · Recuperado (nível direto +
  influenciado entre parênteses) · Jogadores recuperados · Custo real.
- "Régua de reativação": Em jornada agora · Base inativa elegível · Jornadas ativas
  (de `journeys`) · Custo por recuperado — todos clicáveis.

---

## 8. Plano de entregas (gerente de projeto)

| Fase | Prioridade | Entregáveis | Itens resolvidos | Esforço estimado |
|---|---|---|---|---|
| **F0 — Parar de mostrar número errado** | P0 | corrigir truncamento do executivo (D-02); "Jornadas ativas" de `journeys` (D-05); renomear/separar "fila" (D-06); botão e setas funcionais (U-02, U-03); moeda e percentual pt-BR (U-04, U-05); custo por `tenant_sms_pricing` e só SMS aceitos (D-04 parcial); rótulo honesto em "Recuperado pelo CRM" ("por follow-up manual") até a F2; remover código legado (D-12) | S1 visíveis | 2–3 dias |
| **F1 — Fundação de dados** | P0 | **primeiro:** investigar e corrigir a origem de `ftd_em`/`isFtd` (D-14); glossário aprovado; `is_first_deposit` + backfill (D-07); teto de gasto diário por tenant e por jornada (R-09); estado do jogador no envio (D-08); custo gravado por envio em todos os canais (D-04); `crm_results_daily` com nível direto e influenciado; crédito único (R-02); cron incremental; dataset dourado + invariantes (Q-01, Q-07) | D-01, D-03, D-07…D-11, D-13 | 8–12 dias |
| **F2 — Central de Resultados v1** | P0 | rota `/resultados` com Visão geral, Onde recupera, Custo e Saúde dos dados; relatório de jornada/campanha lendo o agregado; página inicial nova (7.8); glossário em tooltips | U-01, U-06…U-09 | 8–10 dias |
| **F3 — Incrementalidade** | P1 | holdout por jornada e campanha (5.3); tela tratado × controle; alertas de amostra | R-01, R-04 | 5–7 dias |
| **F4 — Retenção e aquisição** | P1 | coortes, fluxo de estados, tempo até o 2º depósito; levantamento e integração de "Aquisição e LTV"; funil de coorte (U-10) | U-10 | 6–8 dias |
| **F5 — Evolução** | P2 | recomendações automáticas (pausar etapa de ROI < 1, testar canal); export agendado; comparação entre tenants para o super admin | — | a definir |

### 8.1 Dependências e riscos
- **CPU do banco** (Supabase Small ~94%): a F1 precisa nascer com agregados incrementais;
  backfill fora do horário de pico e em lotes.
- **Callback de entrega** varia por provedor: "entregue" pode ficar "não informado" para
  alguns canais.
- **Custo de WhatsApp e voz** depende da tabela de preços do provedor; se não houver preço
  cadastrado, a F1 grava `cost = null` e a tela informa "custo não configurado", sem
  assumir zero.
- **Histórico:** envios anteriores à F1 não têm custo nem estado gravados; o backfill
  estima com o preço vigente e marca a linha como `estimated = true`.

### 8.2 Decisões pendentes (dono: produto/cliente)
1. Janela do nível influenciado: 3 dias (recomendado) ou 7?
2. Faixas de inatividade padrão (por exemplo, esfriando 3–7d, dormindo 7–30d, perdido
   30d+): usar as mesmas das jornadas do cliente?
3. Holdout padrão em jornadas novas: 5% ligado por padrão ou opt-in?
4. Custo exibido ao tenant: preço de venda (recomendado); custo do provedor só para o
   super admin.
5. O follow-up manual entra na Central como origem própria?
6. O ROI principal do insight: incremental quando houver, senão direto (recomendado).

### 8.3 Critérios de aceite globais
- Nenhuma tela soma dados brutos para números de CRM; todas leem o mesmo agregado e
  fecham entre si (invariantes de Q-01 verdes).
- Todo número tem definição, janela e "atualizado há X min" acessíveis.
- Jornadas aparecem em todos os relatórios, independentemente do volume.
- O custo da Central difere menos de 1% do `sms_credit_ledger` no mês (SMS).
- Nenhum depósito é creditado duas vezes no mesmo nível.
- Isolamento de tenant testado em agregados, drill-down e CSV.
- p95 da Central < 2 s para 90 dias com o maior tenant.

---

## 8.4 F0 — entrega (16/10/2026, madrugada)

Commit `211ecb0` (branch `feat/central-f0-crm-numbers`), 512 testes, build ok. Migrations
`20261016120000_dashboard_crm_truth` e `20261016121000_conversion_report_sources`.

| Item | O que mudou |
|---|---|
| D-01 / U-01 | "Recuperado pelo CRM" passa a ser o nível **direto** (`conversion_attributions`, clique humano → depósito em 7 dias); follow-up manual deixa de ser a regra. Insight descreve o fato com a definição e trata o caso sem dados. |
| D-02 / D-03 / U-05 / U-08 | Relatório executivo agregado no banco: todas as origens do período, envio contado por mensagem; percentuais em pt-BR; tipo da origem no lugar do UUID; linha leva ao relatório da origem. Teste em produção (leitura): 17 origens, 72 conversões, R$ 4.276 (antes 2 origens, 0). |
| D-04 | Custo = créditos cobrados (reservas − estornos × preço registrado); fallback para SMS aceitos × preço do tenant. Sorte Alta 7 dias: R$ 6.897,36 (fórmula antiga: ~R$ 11.394). |
| D-05 / D-06 | "Jornadas ativas" de `journeys` (12/12); "Em jornada agora" = jogadores distintos (12.998). |
| U-02 / U-03 / U-04 | Botão "Ver relatórios completos" e linhas com seta navegam; moeda sempre com 2 casas. |
| D-12 | Removido o carregador legado do painel (~470 linhas). |

Pendências da F0: nenhuma de código. **Fora da F0, observado:** "entregues" é 0 em todas as
origens (o provedor não envia confirmação de entrega), mesmo sintoma do R-10 do escopo de
jornadas.

## 8.5 Correção do D-07 / D-14 após investigação (16/10/2026)

A reavaliação anterior de D-07 e D-14 estava **exagerada**. `deposits.created_at` é o
momento em que o PIX foi **gerado**; `players.ftd_em` é o momento da **aprovação**, minutos
depois. Dos 2.312 jogadores com "depósito antes do `ftd_em`", **2.109** têm diferença média
de 2 minutos: é o próprio primeiro depósito, corretamente excluído do redepósito. Os
"R$ 176,6 mil fora do redepósito" eram, em sua maioria, FTDs legítimos.

- **Inconsistência real:** 203 jogadores (~1% dos depositantes) têm `ftd_em` apontando
  para um depósito posterior ao primeiro aprovado; em 189 o primeiro depósito veio do sync
  de exportação. Causa: o script de sync sobrescreve `ftd_em` com
  `primeiro_deposito_em` da exportação, que nesses casos não é o primeiro depósito
  aprovado do banco.
- **`isFtd` do webhook é coerente:** `true` no primeiro depósito do jogador (2.693) e
  `false` quando ele já tinha depósitos do período do sync (1.366).
- **Reavaliação:** D-07 e D-14 passam de S1 para **S3**. A regra atual de redepósito
  (`created_at > ftd_em + 1 min`) está correta para ~99% da base. Correção recomendada,
  de baixa prioridade e com a equipe: o sync não deve sobrescrever um `ftd_em` mais antigo
  (`least(ftd_em, primeiro_deposito_em)`), e um ajuste único dos 203 casos para o primeiro
  depósito aprovado. A F1 não depende mais disso.

## 8.6 F1 — tabela diária de resultados (16/10/2026)

Commit `74159ca` em `main`; migration `20261016130000_crm_results_daily` aplicada com
trava de tempo (14/10, dia de pico: 0,69 s). Cron: hoje + ontem a cada 10 min; últimos 8
dias às 03h20. Histórico preenchido de 15/09 a 16/10 (6 casas × 31 dias, 35 s).

- **Dimensões:** casa × dia (BRT) × origem (jornada, campanha pelo nome, outra) × etapa ×
  estado do jogador no envio (`sem_ftd`, `ativo`, `esfriando`, `dormindo`, `perdido`,
  `sem_historico`).
- **Medidas:** envios, falhas, custo, destinatários, cliques humanos, recuperação direta
  (clique → depósito em 7 dias), recuperação influenciada (inativo ≥ 48 h ou primeiro
  depósito real, até 72 h após SMS, crédito único ao último SMS). Os níveis não se somam.
- **Testes:** dia de referência com resultado calculado à mão (6 casos, PGlite),
  inclusive idempotência e invariantes.
- **Invariantes em produção (15/09 a hoje):** envios idênticos aos brutos nas três casas;
  custo a 0,01–0,45% do ledger (estornos em horário diferente do envio); conversões
  diretas 84 de 85 na Sorte Alta (uma atribuição ligada a link fora de campanha ou
  jornada).

**Primeira leitura (Sorte Alta, 15/09 a 16/10, nível influenciado):**

| Origem | Custo | Recuperados | Custo por recuperado |
|---|---|---|---|
| Esfriando 2d | R$ 301,68 | 85 jogadores · R$ 5.856,80 | R$ 3,55 |
| Dormindo 7d | R$ 703,08 | 21 · R$ 916,50 | R$ 33,48 |
| 30 dias | R$ 132,72 | 4 · R$ 178,00 | R$ 33,18 |
| Cadastrou e não depositou | R$ 721,08 | 8 FTD · R$ 370,00 | R$ 90,14 |
| 6 campanhas em massa (10–13/10) | R$ 4.861,08 | 0 | — |

As campanhas em massa custaram mais que todas as jornadas e não recuperaram nenhum
jogador inativo (foram para a base ativa) nem tinham link rastreado (0 cliques).

**Pendências da F1:** gravar o id da campanha no log de SMS (hoje a origem é resolvida
pelo nome; 18 campanhas, 17 nomes distintos); custo de WhatsApp/e-mail/voz quando houver
preço; holdout (F3). A F2 (tela da Central) já pode ler desta tabela.

## 8.7 F2 — tela da Central (16/10/2026)

Commit `640b371` (branch `feat/central-f2-results-page`), 523 testes, build ok, sem
migration. Rota `/resultados`, item "Resultados do CRM" no menu (Visão geral). Períodos 7,
30 e 90 dias (BRT). Lê só de `crm_results_daily` (paginado).

- **Visão geral:** recuperado influenciado e por clique (lado a lado, nunca somados),
  custo em SMS, custo por recuperado, retorno; gráfico diário custo × recuperado;
  destaques: origem mais eficiente (mín. 3 recuperações), origens que gastam sem
  recuperar (custo ≥ R$ 50 e 0 recuperado), parcela do custo em jogadores já ativos.
- **Onde recupera:** ranking por origem, com etapas de cada jornada; selo "gasta sem
  recuperar"; nome leva ao relatório da origem.
- **Situação do jogador:** envios, jogadores, custo, recuperados, taxa e custo por
  recuperado por situação no envio; envios a ativos marcados como não recuperáveis.
- **Saúde dos dados:** última atualização e envios conferidos com o registro de SMS.
- Não verificada no navegador (sem sessão local); regras de agregação com testes.

Ainda previsto (fora desta entrega): aba de custo detalhada por canal (depende de preço
de WhatsApp/e-mail/voz), retenção e aquisição (F4), holdout (F3).

## 8.8 F3 e F4 (16/10/2026)

Branch `feat/central-f3-f4`: `eff8f40` (F3) e `67f4e4e` (F4); 540 testes, build ok.

**F3 — grupo de controle (holdout):** `journeys.holdout_percent` (0 = desligado, padrão;
máx. 50). Sorteio na matrícula, estável por (jornada, jogador), nunca escolhido pelo
operador. Jogadores do controle percorrem a jornada (esperas, saídas, loops) sem nenhum
envio nem custo (`provider = 'holdout'`). `journey_holdout_results` compara o retorno em 7
dias dos dois grupos só para entradas com a janela fechada. Na Central, aba "Teste de
controle": taxas, lift com intervalo de 95%, jogadores e receita a mais, e leitura
("traz jogadores de volta", "sem diferença comprovada", "pior que não enviar", "amostra
insuficiente" abaixo de 100 jogadores por grupo ou 10 retornos). Campo no editor: desligado,
5% ou 10%. Limitação conhecida: o controle ainda pode receber campanhas (subestima o
efeito).

**F4 — retenção e aquisição:** coortes semanais de novos depositantes reais (2º depósito
em 7/14/30 dias, só com janela fechada; mediana até o 2º; depositado em 30 dias), funil
dos cadastros do período (1º, 2º, 3º+ depósito; por `utm_source`; mediana até o 1º) e
retrato do ciclo de vida da base. Abas "Retenção" e "Aquisição". Teste em produção
(leitura, Sorte Alta): 2º depósito em 7 dias entre 41% e 64% por semana; mediana até o 2º
caiu de ~3 h para < 1 h nas coortes recentes; cadastros dos últimos 30 dias: 19.122 →
7.159 com 1º depósito (37%) → 4.145 com 2º → 3.066 com 3+.

## 8.9 Pendências da Central fechadas (16/10/2026)

Commits `3daa09b`, `dedb29c`, `d41ca67`, `77f8a8e` em `main` (566 testes, build ok).
Migrations `20261016170000`, `20261016180000`, `20261016190000` aplicadas; histórico
recalculado (resultados desde 15/09, estados desde 02/09) em 88 s, sem erros.

- **Id da campanha no log de SMS:** gatilho no banco grava `campaign_id` em todo envio
  de campanha (a campanha não cancelada mais recente com aquele nome, criada antes do
  envio); 50.446 de 50.472 registros antigos preenchidos (26 sem campanha
  correspondente). A tabela diária usa o id.
- **Evolução da base:** `player_lifecycle_daily` com jogadores por estado ao fim de cada
  dia, reconstruída do histórico; gráfico na aba Retenção.
- **Checagem diária de consistência (Q-01):** todo dia às 03h40, para ontem e cada casa:
  envios × registro de SMS, custo × créditos cobrados, conversões por clique ×
  atribuições. Resultado em `crm_results_health` e na aba "Saúde dos dados". Últimos 7
  dias verificados: nenhuma divergência.
- **Grupo de controle fora das campanhas em massa (R-04):** jogador com matrícula aberta no
  controle fica fora de campanhas com mais de um destinatário (motivo `grupo_controle`,
  visível no aviso do compositor e no relatório da campanha); envio individual não é
  afetado.

### F5 (16/10)

- **Recomendações:** aba "Recomendações" com regras fixas sobre os números do período
  (origem que gasta ≥ R$ 50 sem recuperar ninguém, etapa morta, ≥ 50% do custo em
  jogadores ativos, custo por recuperado ≤ metade ou ≥ 3× a mediana com 3+ origens
  comparáveis, leitura do grupo de controle). Cada uma traz o número que a justifica.
- **Comparação entre casas:** `/resultados/comparar`, mesmas métricas lado a lado.
  Decisão do cliente: só quem é **admin em duas ou mais casas** compara, e só essas casas
  (gestor e membro não contam; super admin vê todas). A regra é checada no servidor a
  cada chamada; o link na Central só aparece para quem pode.
- **Exportação CSV:** botão "Exportar CSV" na Central com total, cada origem e cada etapa
  do período (só números agregados, sem dado de jogador).

- **Menu "Conversão" incorporado à Central:** repetia parte da Central e tinha uma
  "receita assistida" de 14 dias que não batia com o modelo de recuperação. O menu saiu e
  `/relatorios/conversao` redireciona para `/resultados`.
- **Relatório agendado por e-mail:** descartado pelo cliente (16/10).

**Ainda fora:** custo de WhatsApp, e-mail e voz (sem preço cadastrado).

## 9. Reavaliação consolidada

| ID | Severidade | Status da reavaliação | Fase |
|---|---|---|---|
| D-01 | S1 | confirmado no código e no banco (0 follow-ups em 60 dias) | F0 rótulo / F1–F2 correção |
| D-02 | S1 | confirmado no banco (28.251 envios / 20 origens × 1.000 / 2) | F0 |
| D-03 | S2 | confirmado no código; no banco, 1 link por mensagem no período (efeito atual nulo) | F1 |
| D-04 | S1 | confirmado no banco (R$ 0,12 real; falhas estornadas; painel ~65% acima) | F0 parcial / F1 |
| D-05 | S1 | confirmado no banco (12 ativas + 1 pausada × 0/0) | F0 |
| D-06 | S1 | confirmado no banco (34.390 × 3.113) | F0 |
| D-07 | S3 | **corrigido em 8.5**: a regra está certa para ~99%; 203 jogadores com `ftd_em` posterior ao 1º depósito (sync) | equipe |
| D-14 | S3 | **investigado (8.5)**: falta de `isFtd` = depósitos do sync; `isFtd` coerente no webhook | equipe |
| D-15 | S2 | novo; estimativa, revalidar com 30 dias de operação | F2 |
| D-16 | S1 | novo; 34.342 matrículas = 20.789 jogadores; sobreposição e jornada pausada retendo matrículas | F0 (contagem) / F1 (regras) |
| D-08 | S1 | confirmado | F1 |
| D-09 | S2 | confirmado | F1 |
| D-10 | S3 | confirmado; efeito pequeno em 30d | F2 |
| D-11 | S3 | efeito de borda | F1 |
| D-12 | S3 | confirmado | F0 |
| D-13 | S3 | confirmado | F2 |
| U-01…U-10 | S1–S3 | confirmados por captura e código | F0/F2/F4 |
| Q-01…Q-07 | S1–S2 | lacunas de cobertura | F1 |
| R-01…R-08 | S1–S2 | riscos preventivos; R-03 já ocorreu (97% dos cliques são de robô) | F1–F3 |
| R-09 | S2 | novo; saldo de 99.999.999 créditos não limita o gasto | F1 |

---

## 10. Fora de escopo

- Modelos de atribuição multitoque ponderados (linear, decaimento temporal).
- Previsão de churn por machine learning (pode usar a base da F4 no futuro).
- Alterar relatórios já emitidos quando a regra mudar (há versionamento, não reescrita).

---

## 11. Validação em produção — resultados (15/10/2026)

Leitura agregada em sessão somente leitura (`default_transaction_read_only = on`), tenant
Sorte Alta (`03b73a96-…`), período de 15/09/2026 00h00 BRT até o momento da consulta.
Nenhum dado pessoal foi extraído.

| ID | Pergunta | Resultado |
|---|---|---|
| V-01 | Depósitos aprovados e redepósitos | 58.839 depósitos / R$ 4.529.993,67. Regra atual: 50.313 redepósitos / R$ 4.112.941,16. Sem `ftd_em`: 113 / R$ 5.714,80. **Antes do `ftd_em`: 2.948 / R$ 176.593,13 (~2.009 jogadores)**. Sem jogador: 0 |
| V-01b | FTD por fonte | `players.ftd_em` no período: 7.302. Webhook `isFtd=true`: 2.644; `false`: 26.620; **sem flag: 29.580 (R$ 2.185.315,78)**. Histórico de `deposits` começa em 02/09/2026 |
| V-02 | Envios rastreados × relatório executivo | `link_dispatches`: jornada 14.213 (11 origens), campanha 14.034 (7), manual 4 (2). Mensagens = linhas (1 link por mensagem). Execuções de jornada SMS: 15.755 enviadas, 7.925 puladas, 622 com falha |
| V-03 | Nível influenciado (estimativa) | 54 depósitos / 54 jogadores / R$ 3.450,40 de inativos (3+ dias) até 3 dias após SMS; o mesmo com 7 dias. 807 depósitos até 3 dias após SMS no total (753 de ativos). Retornos de inativos no período: 1.940 / R$ 112.339,97, dos quais 1.888 sem SMS nos 7 dias anteriores |
| V-04 | Conversões e cliques | Direto: 24 depósitos / R$ 960 e 16 logins, todos de jornadas e todos em 15/10. Cliques: 207 humanos × 6.469 robôs. Follow-ups manuais em 60 dias: 0 |
| V-05 | Custo de SMS | `sms_send_logs`: 56.328 enviados, 628 com erro, 13 pendentes. Ledger: 56.958 reservas, 624 estornos, a R$ 0,12. Sem preço próprio em `tenant_sms_pricing`. 56.955 dos 56.978 SMS saíram nos últimos 7 dias |
| V-06 | Depósitos duplicados por `external_id` | 0 |
| V-07 | Jornadas e fila | `journeys`: 12 ativas, 1 pausada; `sms_flows`: 0. Matrículas: 17.649 ativas, 10.479 aguardando, 6.262 pausadas por prioridade, 1.364 saíram, 58 concluídas, 43 pausadas, 41 com falha |
| V-07c | Motivos de saída (30 dias) | entrada deixou de valer 683 · **depósito 290** · mudou de faixa de inatividade 283 · mudou de nível 72 · mensagem obsoleta 38 · passo final 33 · fim 26 |
| V-09 | Créditos | ajustes manuais: +1.000.000 (30/09) e +99.040.530 (14/10), saldo 99.999.999 |
| V-10 | Origem dos SMS (30 dias) | jornadas 16.440; campanhas: "12/10 atualização" 13.079, "SMS 10/10 manhã" 13.030, "terça 13/10" 5.003, "12/10 22:42" 4.060, "12/10 14:00" 3.071, "terça 13/10 parte 2" 1.267, "09/10 BOTO" 999; individuais/manuais 15 |

**Observação:** o card "Recuperado pelo CRM" fica em zero por D-01 (nenhum follow-up). Já
as 290 saídas de jornada por "depósito" mostram que há retorno durante as jornadas que
nenhuma tela exibe hoje (D-09).

**Pendente:** investigar quem grava `players.ftd_em` com data posterior ao primeiro
depósito (D-14) e repetir V-03 e D-15 quando houver 30 dias completos de operação das
jornadas.
