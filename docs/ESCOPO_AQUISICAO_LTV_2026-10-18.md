# Escopo: deixar o menu "Aquisição e LTV" 100% funcional

**Origem:** [AUDITORIA_AQUISICAO_LTV_2026-10-18.md](AUDITORIA_AQUISICAO_LTV_2026-10-18.md). Os IDs `AQ-xx` remetem aos achados de lá.
**Status:** aprovado em 19/10/2026. As decisões da seção 2 seguem as recomendações (aceitas pelo responsável pelo produto). Em execução.
**Objetivo:** a casa conecta a BM do Meta, escolhe as contas e, em até 1 hora, vê o investimento por campanha, conjunto e anúncio cruzado com cadastros, FTD, depósitos e LTV por coorte. Os números batem com o Gerenciador de Anúncios e com o banco.
**Princípio:** primeiro números corretos, depois tela bonita. Nenhum número aparece para o cliente sem um teste que o confira. Item com "código pronto" ainda não está entregue; só fecha com a evidência do critério de aceite registrada no PR.

Esforço (uma pessoa, testes incluídos): **P** até 1 dia, **M** 2 a 4 dias, **G** 1 semana ou mais.

---

## 1. Regras de execução

1. Partir do `origin/main`; o `main` local está 32 commits atrás (AQ-48). Uma branch e um PR por item ou grupo pequeno, com CI verde.
2. Todo item de número, sync ou segurança entra com um teste que falha antes e passa depois, com o ID do item no nome do teste.
3. Qualquer escrita em produção (migration, dado ou configuração) precisa de aprovação explícita e de plano de rollback.
4. O status vive na tabela da seção 9, com o hash do commit e a evidência.
5. O tenant demo nunca chama `graph.facebook.com`, e isso vale para todos os itens.
6. O menu e a aba Aquisição da Central de Resultados passam a ler as mesmas RPCs (AQ-45). Nenhuma métrica é calculada duas vezes.

---

## 2. Decisões do responsável pelo produto

**Decididas em 19/10/2026:** todas conforme a coluna "Recomendação". D12 fica com a Sorte Alta, a confirmar que ela anuncia no Meta e que envia a exportação do Gerenciador; se não, a casa da Sorte da Bet. D10 muda a decisão anterior: o demo passa a ter gasto sintético coerente com as atribuições clonadas.

| # | Pergunta | Recomendação | Bloqueia |
|---|---|---|---|
| D1 | **Modelo de conexão:** um app Meta por casa com token de Usuário do Sistema (atual) ou um app Betleads único com "Entrar com Facebook" (OAuth)? | Manter o token por casa na entrega 100%. Abrir em paralelo o processo de App Review e verificação do negócio para o OAuth, que leva semanas e não deve bloquear | AL5-01 |
| D2 | **Receita do ROAS e do LTV:** depósito bruto, depósito líquido (menos saques) ou NGR? | **Depósito líquido** como principal, com o bruto ao lado. NGR só se as casas passarem a enviar apostas, prêmios e bônus | AL1-04, AL4-01 |
| D3 | **Atribuição:** first-touch do cadastro ou last-touch? Qual janela clique→cadastro? | **First-touch imutável no cadastro.** O toque do CRM fica separado. Janela de 7 dias, configurável | AL1-05, AL1-06 |
| D4 | **Padrão de UTM:** aceitar ID do anúncio em `utm_content` (padrão Sorte da Bet) ou exigir `utm_id={{ad.id}}`? | Aceitar os dois. Recomendar `utm_id` no gerador | AL1-05 |
| D5 | **Horizontes do LTV e data-base do CPA de FTD** | D0, D7, D30 e D90 por coorte de cadastro; coortes imaturas aparecem como parciais | AL4-01 |
| D6 | **Contas em outra moeda** | Converter para BRL com o câmbio diário (fonte PTAX/BCB), mostrando a taxa. Na primeira entrega, alertar e separar por moeda | AL1-03 |
| D7 | **Backfill inicial e frequência** | 90 dias ao selecionar a conta. Os 3 dias recentes a cada 2 horas, e 28 dias uma vez por semana | AL2-05 |
| D8 | **Quem conecta e desconecta** | Só admin e gestor; operador apenas vê | AL2-08 |
| D9 | **Windsor e CSV** | Remover da tela agora. O CSV vira AL5-03 como plano B para casas sem app | AL0-04, AL5-03 |
| D10 | **Demo:** sintetizar mídia? (a decisão anterior foi "nada é sintetizado") | Sintetizar gasto coerente com as atribuições já clonadas; sem isso o menu fica vazio ou mostra ROAS infinito | AL3-10 |
| D11 | **Nome do menu** | "Aquisição e LTV" em toda parte | AL0-05 |
| D12 | **Casa piloto** | Escolher uma casa que já rode Meta e possa enviar uma exportação do Gerenciador de um período fechado | Aceite da AL1 |
| D13 | **Outras plataformas e CAPI** | Fora do 100% desta entrega. Ficam como AL5 | AL5 |

---

## 3. Fase AL0: contenção e pré-requisitos (2 a 3 dias)

**Objetivo:** parar de mostrar dado falso e garantir que o sync roda.

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| AL0-01 | **Verificar em produção (somente leitura)** se `META_API_VERSION`, `META_TOKEN_ENCRYPTION_KEY`, `CRON_SECRET` e `betleads_cron_secret` (Vault) estão definidos; ver os últimos `meta_sync_runs` e os jobs `running` antigos | AQ-15, AQ-16 | Saída anexada. Lista de casas conectadas e do estado do sync | P |
| AL0-02 | Atualizar o padrão e o `.env.example` para a versão vigente da Marketing API, confirmada no changelog no dia, e registrar no log de inicialização a versão em uso | AQ-15 | Uma chamada real com a casa piloto responde 200. Data da próxima expiração anotada no doc de operação | P |
| AL0-03 | Destravar runs e jobs presos hoje, se o AL0-01 encontrar algum, com script revisado e aprovado | AQ-16 | Nenhum job `running` com lock vencido | P |
| AL0-04 | Remover os cards Windsor, CSV e "Plano técnico"; deixar o gerador de UTM só com o Meta; corrigir o template TikTok ou removê-lo | AQ-35 | Nenhum botão sem efeito real na tela | P |
| AL0-05 | Remover os textos fixos e falsos ("Saúde da medição", o comparativo Meta × webhook, "FTD vem da conta", iFluxHub, o caminho inexistente, a legenda quebrada); trocar o banner "rode as migrations" pela mensagem real com "Tentar novamente"; padronizar o nome "Aquisição e LTV" | AQ-31, AQ-36, AQ-38 | Revisão de texto aprovada. Busca por "iFluxHub", "migrations" e "disponível" na rota retorna 0 | P |
| AL0-06 | Aviso temporário no topo do painel: "Números em revisão", até a AL1 fechar | AQ-01 a AQ-06 | Visível em produção | P |
| AL0-07 | Excluir `.claude/` da configuração do vitest | AQ-41 | `npm test` não roda as cópias dos worktrees | P |

**Saída da AL0:** o sync roda na versão vigente, não sobra funcionalidade de fachada e o cliente sabe que os números estão em revisão.

---

## 4. Fase AL1: números confiáveis (cerca de 2 semanas)

**Objetivo:** todo número da tela vem de uma RPC SQL testada, no fuso certo, na moeda certa e com atribuição única.

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| AL1-01 | **RPCs de agregação no Postgres** (`security definer` com `has_tenant_access`, no padrão de `crm_acquisition_funnel`), substituindo os 5 selects brutos. Os totais são calculados sobre todas as linhas; as tabelas mostram as N primeiras mais a linha "Outros (N)" | AQ-01, AQ-02 | Teste PGlite com 5.000 jogadores, 10.000 depósitos e 60 anúncios × 30 dias: os totais batem com o `SUM` direto | G |
| AL1-02 | **Fuso:** cadastros e depósitos em `America/Sao_Paulo` (`tz.ts`) no cliente e no servidor; insights pedidos e gravados no `timezone_name` da conta | AQ-05 | Com o relógio fixado em 18/10 22:30 BRT e `TZ=UTC`, "Hoje" equivale a 18/10, e um depósito às 23:30 BRT cai em 18/10 | P |
| AL1-03 | **Moeda:** coluna `currency` em `marketing_ad_metrics_daily`, preenchida no sync; a RPC converte ou separa por moeda, conforme D6 | AQ-06 | Teste com conta em USD: nunca somada como BRL sem conversão. A tela mostra a taxa ou o aviso | M |
| AL1-04 | **Definição das métricas** em código único: CAC por cadastro e CPA de FTD sobre os jogadores atribuídos a anúncio pago; FTD = primeiro depósito aprovado (mesma regra da Central); receita conforme D2; sem fallback para `total_depositado`; status nulo não conta como aprovado | AQ-03, AQ-04 | Testes K1 a K9 (seção 8). As fórmulas aparecem num glossário na tela e são idênticas às do código | M |
| AL1-05 | **Atribuição única em SQL:** `reconcile_meta_attributions` vira a única fonte, lida pela RPC. Precedência: `utm_id`/`utm_content` = `ad_id` > nome único do anúncio > `campaign_id` > nome único da campanha. Status `matched_ad`, `matched_campaign`, `ambiguous`, `orphan`, `missing_utm`, `organic` e `crm`. Agregação por `ad_id`, com o nome só para exibição | AQ-09, AQ-10, AQ-11, AQ-14 | Teste com a fixture real da Sorte da Bet: o criativo casa. Dois anúncios homônimos não se fundem. Precedência coberta por teste | M |
| AL1-06 | **First-touch imutável:** o webhook deixa de sobrescrever a origem de aquisição; o toque do CRM (`utm_source=betleads` ou token de clique) fica separado e nunca entra como aquisição paga. O upsert de atribuição passa a verificar erro e registrar log | AQ-12, AQ-13 | Teste: jogador vindo de anúncio que depois clica num SMS continua creditado ao anúncio. Regressão completa de `webhook-process` | M |
| AL1-07 | **Campos de insights:** `inline_link_clicks`, `account_currency` e `actions`/`action_values`; reach e frequency do período agregado, não somados por dia | AQ-07 | Fixture "golden" do Gerenciador confere cliques de link, CTR e CPC | P |
| AL1-08 | **Catálogo separado dos fatos:** tabelas `meta_campaigns`, `meta_adsets` e `meta_ads` (status, nome, criativo, miniatura); `marketing_ad_metrics_daily` fica só com insights; fim do placeholder com `spend=0` | AQ-21, AQ-32 | Teste: uma falha nos insights não reduz o gasto já importado. A miniatura aparece em anúncio com entrega | M |
| AL1-09 | **Janela consistente:** a reimportação faz delete + insert por conta e dia dentro de uma transação; a chave única não aceita mais NULL em `ad_id` | AQ-08 | Teste: uma linha que o Meta deixou de devolver é removida, e um reimport não duplica | P |

**Saída da AL1, aceite com a casa piloto (D12):**
1. Num período fechado de 7 dias, o gasto por conta e por campanha difere em no máximo 1% (ou R$ 1) do Gerenciador, no fuso da conta, com o print anexado.
2. Uma amostra de 20 jogadores é rastreada da UTM até o anúncio, o FTD e o depósito, e bate com a tela.
3. Um período com mais de 1.000 jogadores dá o mesmo total que a consulta SQL direta.
4. O aviso da AL0-06 é removido.

---

## 5. Fase AL2: sincronização robusta e segurança (cerca de 1,5 semana; pode correr em paralelo com a AL1)

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| AL2-01 | **Reaper:** um job `running` com lock vencido e na última tentativa vira `failed`, e o run é fechado; heartbeat ou lock renovável durante o processamento | AQ-16 | Teste E3: nenhum job fica em `running` por mais de 10 minutos depois da última tentativa. Um sync novo da casa volta a rodar | M |
| AL2-02 | **`MetaApiError` com code, subcode e type.** Tabela de erros retentáveis (1, 2, 4, 17, 32, 613, 80000–80014) e permanentes (190, 200, 10, 2635). Leitura de `x-business-use-case-usage`/`x-app-usage`, backoff com jitter que respeita `estimated_time_to_regain_access`. A regex sobre texto deixa de existir | AQ-17 | Testes D3 e B1 com fixtures de cada código | M |
| AL2-03 | **O erro de uma conta não derruba a BM:** permissão perdida numa conta marca só aquela conta; erro transitório não rebaixa a conexão; "Testar conexão" com timeout não desliga o sync. `sync_status` e `last_error` da conta ficam sempre atualizados | AQ-18, AQ-23 | Testes B2, B3 e E4 | P |
| AL2-04 | **Insights assíncronos** (`async=true` + polling de `async_status`) para períodos acima de 7 dias ou contas grandes; timeout (AbortController) em todas as chamadas, inclusive na paginação; token no header, não na URL; upsert em lotes | AQ-19 | Teste D6 (90 dias × 500 anúncios). Grep nos logs de teste não encontra o token | M |
| AL2-05 | **Política de sync conforme D7:** backfill ao selecionar a conta (em blocos de 30 dias); 3 dias recentes de forma frequente; 28 dias semanal; "Atualizar agora" com `from`/`to` do período da tela; o manual não reaproveita um agendado de janela menor; redescoberta de contas novas no agendado | AQ-08, AQ-22 | Testes F1, F2 e E5. Selecionar uma conta mostra dados em menos de 1 hora | M |
| AL2-06 | **Vazão:** enqueue agendado em um único `INSERT … SELECT`; claim maior com concorrência limitada por conta e por casa; erros do agendamento logados | AQ-20 | Teste E8: 150 contas drenadas dentro do SLA definido (sugestão: 1 hora) | P |
| AL2-07 | **Validade do token:** `debug_token` no connect, no validate e diariamente; preenche `token_expires_at`/`data_access_expires_at`; recusa ou avisa token de usuário de curta duração; `appsecret_proof` quando a casa fornecer o secret | AQ-24 | Testes A6 e A9. A expiração aparece na tela | P |
| AL2-08 | **Papéis (D8):** `requireTenantRole(['admin','gestor'])` em connect, select, validate, disconnect e save; o operador recebe 403 e a UI esconde as ações | AQ-26 | Teste H1 (matriz papel × ação) | P |
| AL2-09 | **RLS:** fatos, atribuições e integrações com apenas SELECT para `authenticated` (as escritas vão por `service_role` via server function); o worker confere que a conexão pertence à mesma casa da conta; `saveMarketingIntegration` restrito | AQ-27 | Teste G3 e G4 via PostgREST: um membro não consegue inserir gasto | P |
| AL2-10 | **Casas bloqueadas e demo:** o worker ignora casas suspensas (`assertTenantCanOperate`); `enqueueMetaSync` com a trava de demo | AQ-28 | Testes E6, I1 e I2 | P |
| AL2-11 | **Seleção de contas atômica** (RPC transacional) | AQ-25 | Teste de falha no meio da troca | P |
| AL2-12 | **Tokens legados:** verificar em produção (somente leitura) se existem; migration que zera `access_token` das conexões `legacy_oauth` e remove o fallback | AQ-29 | Consulta anexada antes e depois | P |
| AL2-13 | **Observabilidade:** atraso por conta ("último dia completo"), alerta de conta em erro ou de run parado há mais de 2 horas no canal de operação, histórico diário da taxa de casamento | AQ-44 | Alerta disparado em teste de homologação | M |

**Saída da AL2:** duas casas conectadas sem vazamento entre elas (aceite da REAUDITORIA de 03/10). Uma conta com mais de 500 anúncios sincroniza sem erro. Rate limit e token expirado se recuperam sozinhos ou alertam.

---

## 6. Fase AL3: experiência pronta (cerca de 2 semanas; começa quando a AL1-01 estiver mergeada)

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| AL3-01 | **Dividir a rota** em `components/midia-ltv/*`, com hooks `useMetaConnection` e `useMarketingOverview`, tipos inferidos das server functions e fim dos `as any`. Período, aba e seção na URL | AQ-39, AQ-42 | Nenhum arquivo acima de 400 linhas. `tsc` sem `as any` no módulo | M |
| AL3-02 | **Estados de entrada:** sem conexão, tela vazia com "Conectar Meta Ads"; conectado sem conta, "Escolha as contas"; primeira sincronização com progresso; sem dados no período; operador em modo só leitura | AQ-34 | Os 5 estados cobertos por teste de componente | M |
| AL3-03 | **Wizard completo:** guia passo a passo com links do Business Manager e imagens; validação do token em linha; salvar dispara o backfill e leva ao painel; passo "concluído"; seleção de contas agrupada por BM, com busca, "selecionar todas", moeda, fuso, status, erro visível e aviso de alterações não salvas | AQ-34, AQ-39 | Roteiro de usabilidade com uma pessoa da casa piloto: conecta sem ajuda | M |
| AL3-04 | **Cabeçalho e saúde:** indicador "Atualizado há X" com painel de detalhes (como o `HealthIndicator` da Central); banner de token expirado ou permissão perdida com "Atualizar token"; erros do Meta traduzidos; o polling só roda quando o período inclui hoje | AQ-36, AQ-40 | Token revogado no teste aparece no painel em linguagem clara | P |
| AL3-05 | **Hierarquia do painel:** filtro de período em segmented control com "Personalizado" (no máximo o limite suportado); faixa de funil Investido → Cliques → Cadastros → FTD → Depósitos; KPIs ROAS, CAC (FTD pago), LTV D30 e payback, com variação contra o período anterior; avisos num bloco único "Precisa de atenção" | AQ-37 | Revisão de design aprovada. Os KPIs aparecem na primeira dobra em 1366×768 | M |
| AL3-06 | **Tabelas de negócio:** Investido, Cliques, Cadastros, FTD, CAC, Depósitos, ROAS e LTV em criativos, conjuntos e campanhas, com ordenação por cabeçalho (`aria-sort`), busca, filtro de status e linha "Outros" | AQ-32 | As colunas batem com a RPC. Ordenação testada | M |
| AL3-07 | **Miniatura e prévia do criativo** a partir do catálogo (AL1-08), renovada no sync | AQ-32 | Miniatura visível em 100% dos anúncios com criativo | P |
| AL3-08 | **Diagnóstico de atribuição** num painel lateral: taxa de casamento, sem UTM, órfãos, ambíguos e CRM, com ação "copiar UTM correta" | AQ-12, AQ-14 | Os números somam 100% dos cadastros do período | P |
| AL3-09 | **Acessibilidade e responsividade:** `TabsContent`, `aria-pressed`, `role="progressbar"`, `caption`, alternativa textual nos gráficos, primeira coluna fixa, sem rolagem dupla, cartões abaixo de `md`; gráficos com os tokens `--chart-*` | AQ-40 | Auditoria axe sem erros críticos. Teste em 375 px sem rolagem horizontal da página | M |
| AL3-10 | **Demo (D10):** fixtures de catálogo e gasto coerentes com as atribuições clonadas, recriadas no reset | AQ-47 | O demo mostra o painel completo sem nenhuma chamada ao Meta | M |
| AL3-11 | **Textos:** revisão completa em PT-BR com acentos e "jogadores" em vez de "players" | AQ-38 | Revisão aprovada | P |

---

## 7. Fase AL4: LTV e drill-down (cerca de 2 semanas; depende da AL1 e de D2/D5)

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| AL4-01 | **LTV por coorte de cadastro:** D0, D7, D30 e D90 por campanha, conjunto e anúncio, com receita bruta e líquida; coortes imaturas marcadas como parciais; payback (dia em que o LTV acumulado passa o CAC) | AQ-04 | O LTV D30 de uma coorte bate com uma consulta SQL independente. Teste K6 | G |
| AL4-02 | **Visão de coortes:** tabela ou heatmap semana × D0…D90 e curva de LTV acumulado contra o CAC | AQ-04 | Revisão de design aprovada | M |
| AL4-03 | **Drill-down** Campanha ▸ Conjunto ▸ Anúncio com as mesmas colunas e breadcrumb na URL | AQ-33 | Navegação por teclado e URL compartilhável | M |
| AL4-04 | **Do anúncio aos jogadores:** clicar em cadastros ou FTD abre `/players` filtrado pela campanha ou anúncio, com o LTV individual | AQ-33 | A contagem da lista é igual ao número clicado | M |
| AL4-05 | **Exportação CSV** (separador `;`, BOM, fórmulas neutralizadas, só para admin, com auditoria, no padrão da F1-07) | — | Teste com o nome `=1+1` | P |
| AL4-06 | **Unificar com a Central de Resultados:** a aba Aquisição da Central passa a ler as RPCs da AL1 e da AL4 | AQ-45 | Os mesmos números nas duas telas para o mesmo período | M |
| AL4-07 | **Evolução:** gráfico combinado gasto × depósitos com ROAS em linha e o trecho final "ainda chegando" | AQ-40 | Revisão de design aprovada | P |

**Saída da AL4: o menu está "100% funcional"** (definição na seção 10).

---

## 8. Plano de testes

Notação: **U** unitário vitest, **I** integração PGlite (padrão `crm-results.db.test.ts`), **C** contrato com fixtures da Graph API (`src/lib/__fixtures__/meta/*.json`, com `fetch` mockado), **E2E** Playwright no tenant demo com o Meta mockado.

| Bloco | Casos | Tipo |
|---|---|---|
| A. Conexão | Token válido com 1 e com 2 BMs; sem `ads_read`; escopo parcial; token de outro app; token de usuário comum; reconectar sem duplicar; ida e volta da cifra v1/v2; desconectar apaga o token | C+I+U |
| B. Token | Erro 190 → `error` sem retry; permissão perdida em 1 conta; timeout no validate | C+I |
| C. Contas | BRL+USD e fusos diferentes; conta sem gasto; conta desativada; anúncios homônimos | C+I+U |
| D. Volume | Paginação de 3 páginas; timeout no meio; códigos 4, 17, 613 e 80004; mais de 1.000 linhas no overview; 60 criativos; 90 dias × 500 anúncios | C+I+U |
| E. Fila | Claim concorrente; lock vencido nas tentativas 1 e 3; transições de estado; manual × agendado; casa bloqueada; tick sem secret; vazão | I+U |
| F. Janela | Ajuste em D-5 e D-20; linha removida; reconciliação idempotente e com precedência | C+I |
| G. Isolamento | Casas A e B com a mesma conta; `connectionId` de outra casa; RLS via PostgREST; worker com conexão de outra casa | I |
| H. Papéis | Matriz admin/gestor/operador/super admin × ações; UI do operador | I+E2E |
| I. Demo | `fetch` para o Meta com 0 chamadas; cron ignora o demo; o reset recria as fixtures | U+I |
| J. Conferência | Fixture "golden" do Gerenciador (diferença ≤ 0,01 no gasto, exata em impressões e cliques); conferência manual em produção em 3 períodos | C+I+Manual |
| K. Métricas | Gasto 0; FTD 0; receita 0; estorno e status nulo; sem fallback vitalício; coorte D+10; CPA com orgânicos; virada do dia às 23:30 BRT; `from > to` e período inválido; presets às 22h BRT | U+I |

Cada linha das seções 3 a 7 cita o caso que a fecha.

---

## 9. Sequência e esforço

```
AL0 (2-3 dias) ──┬─> AL1 (≈2 sem) ──┬─> AL3 (≈2 sem) ──┐
                 │                  └─> AL4 (≈2 sem) ──┴─> 100% funcional
                 └─> AL2 (≈1,5 sem, em paralelo com a AL1)
D1–D12 respondidas antes do início da AL1
```

Com duas pessoas (uma em dados/back e outra em front), a entrega estimada é de **6 a 7 semanas** a partir da aprovação. Com uma pessoa, de **9 a 10 semanas**. A AL5 não está incluída.

| ID | Status | Commit | Evidência | Data |
|---|---|---|---|---|
| AL0-01 | feito | — | Leitura em produção (sessão `read_only: on`, PG 17.6). Nenhuma casa conectada no modelo de token; a única conexão é a legada da `betleads-original`, em `error` e **com token em texto puro** (AQ-29 confirmado). Nenhum run ou job de sync jamais criado. Cron `betleads-meta-sync-worker` ativo a cada 5 min e `betleads_cron_secret` presente no Vault. Sorte Alta (`pixpgf`): 12.424 atribuições, 9.389 com o ID do anúncio em `utm_content`, campanha e conjunto também por ID em `utm_campaign`/`utm_term`; 98% marcadas como `orphan_campaign`; 19 mil cadastros e 87 mil depósitos em 30 dias (o corte em 1.000 linhas atinge a casa com certeza). A `META_API_VERSION` do container não é legível pelo banco; o `.env` local fixa v23.0 e o AL0-02 cobre o caso | 19/10/2026 |
| AL0-02 | implementado | branch `feat/aquisicao-ltv-al0` | `meta-api-version.ts` com piso v25.0: um valor expirado no ambiente é ignorado com aviso. 4 testes. Versões conferidas no changelog em 19/10/2026: v23.0 expirou em 09/06, v24.0 em 06/10, v25.0 vigente (expiração a definir) | 19/10/2026 |
| AL0-03 | não necessário | — | Nenhum run ou job existe, então não há nada travado | 19/10/2026 |
| AL0-04 | implementado | branch `feat/aquisicao-ltv-al0` | Cards Windsor, CSV e Plano técnico removidos; gerador só com Meta; link da casa como placeholder; erro ao copiar tratado | 19/10/2026 |
| AL0-05 | implementado | branch `feat/aquisicao-ltv-al0` | Textos falsos removidos; banner de erro com a mensagem real e "Tentar novamente"; nome "Aquisição e LTV". Busca por iFluxHub, migrations e "disponível" na rota retorna 0 | 19/10/2026 |
| AL0-06 | implementado | branch `feat/aquisicao-ltv-al0` | Aviso "Números em revisão" no painel | 19/10/2026 |
| AL0-07 | implementado | branch `feat/aquisicao-ltv-al0` | `npm test` com `--exclude ".claude/**"`: 107 arquivos e 1.176 testes verdes | 19/10/2026 |

---

## 10. Definição de "100% funcional"

1. **Conexão:** uma casa nova conecta a BM sem ajuda e, em até 1 hora, vê os 90 dias anteriores.
2. **Números:** o gasto bate com o Gerenciador (≤ 1%), e cadastros, FTD, depósitos e LTV batem com o banco, em qualquer volume.
3. **Atribuição:** cada cadastro tem um status explícito. O tráfego do CRM não aparece como aquisição. Anúncios homônimos não se misturam.
4. **LTV:** coorte D0/D7/D30/D90 com payback, por campanha, conjunto e anúncio, até a lista de jogadores.
5. **Operação:** o sync se recupera de rate limit, de travamento e de erro numa conta. Token expirado e atraso de dados geram alerta.
6. **Segurança:** só admin e gestor mexem na conexão, nenhum membro grava dados de mídia e o demo nunca chama o Meta.
7. **Interface:** estados vazios guiados, nada de fachada, textos revisados, acessível e utilizável em 375 px.
8. **Qualidade:** os blocos A a K do plano de testes estão verdes no CI.
9. **Coerência:** a Central de Resultados e este menu mostram os mesmos números.

---

## 11. Fora desta entrega (AL5, backlog)

| ID | Item | Depende de | Esf. |
|---|---|---|---|
| AL5-01 | App Betleads único com "Entrar com Facebook" (Facebook Login for Business), com App Review, verificação do negócio e Advanced Access. O token de Usuário do Sistema fica como opção avançada | D1 | G (mais semanas de processo no Meta) |
| AL5-02 | Conversions API: enviar `CompleteRegistration` e o FTD com valor, com `event_id` para deduplicar, `fbc`/`fbp`, hash, base legal LGPD e política de anúncios de apostas | D13, jurídico | G |
| AL5-03 | Importador CSV real (upload, mapeamento, prévia, histórico) como plano B | D9 | M |
| AL5-04 | Google Ads, TikTok e Kwai (o esquema já prevê `provider`) | D13 | G por plataforma |
| AL5-05 | Criptografia com KDF, AAD por conexão e keyring com rotação | AQ-30 | P |
| AL5-06 | NGR, se as casas passarem a enviar apostas, prêmios e bônus | D2 | G |
