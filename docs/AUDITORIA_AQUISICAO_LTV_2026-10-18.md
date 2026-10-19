# Auditoria do menu "Aquisição e LTV" (/midia-ltv), 18/10/2026

**Perspectivas:** design UX, desenvolvimento sênior, QA, engenharia de software e gestão de projeto.
**Natureza:** somente leitura. Nenhum arquivo do sistema nem dado de produção foi alterado.
**Base:** `origin/main` e5f80eb. O `main` local (0c5a973) está 32 commits atrás; as travas do tenant demo (472e163, b7c9617, 504c1c1) só existem no `origin/main`. Os números de linha podem variar alguns pontos entre as duas bases.
**Escopo de correção:** [ESCOPO_AQUISICAO_LTV_2026-10-18.md](ESCOPO_AQUISICAO_LTV_2026-10-18.md).

Siglas dos IDs: **UX** design, **DEV** desenvolvimento, **QA** qualidade, **ENG** engenharia, **PM** gestão. Quando o mesmo problema foi encontrado por mais de uma perspectiva, o achado consolidado (**AQ-xx**) cita todos.

Arquivos centrais:
- `src/routes/midia-ltv.tsx` (cerca de 2.150 linhas, 14 componentes num arquivo)
- `src/lib/meta.functions.ts`: conexão, contas, fila e sync
- `src/lib/marketing.functions.ts`: overview e métricas
- `src/lib/meta-token.server.ts`: criptografia do token
- `src/routes/api/public/meta-sync/tick.ts`: worker
- `src/lib/webhook-process.server.ts`: UTMs e atribuição no cadastro
- migrations `20260917164000`, `20260917173500`, `20261002*_meta_*`, `20261003153000`

---

## 1. Resumo executivo

A ingestão de dados do Meta está razoavelmente construída:
- token de Usuário do Sistema cifrado em AES-GCM;
- descoberta de contas por BM;
- fila com `SKIP LOCKED`, retry e cron a cada 5 minutos;
- gasto diário por anúncio gravado de forma idempotente.

**O que impede o menu de ser usado hoje é a camada de cima: números, atribuição e LTV.**

1. **Os números saem errados sem aviso.** As consultas são cortadas em 1.000 linhas e os totais somam só os 50 maiores criativos. As datas estão em UTC e as moedas são somadas como se fossem todas BRL. O CAC divide o gasto Meta por todos os FTDs da casa, inclusive os orgânicos.
2. **Não existe LTV.** A "receita" é o depósito bruto dentro do período, só dos jogadores cadastrados no mesmo período. Quando não há depósito, a tela usa o total vitalício do jogador.
3. **A atribuição é frágil:**
   - os criativos são agrupados por nome;
   - o ID do anúncio em `utm_content` não casa;
   - o tráfego do próprio CRM (SMS/WhatsApp) é contado como aquisição;
   - as UTMs do jogador são sobrescritas a cada evento;
   - a reconciliação SQL existe, mas a tela a ignora.
4. **A sincronização pode parar de vez.** Um job travado na última tentativa bloqueia a casa para sempre. Não há tratamento de rate limit. O erro de uma conta derruba a BM inteira. **A versão padrão da API (v23.0) já foi descontinuada pelo Meta.**
5. **Segurança:** qualquer membro da casa troca ou desconecta o token e, pelo PostgREST, consegue gravar gasto falso.
6. **UX:** a tela afirma fontes de dados que não existem ("LTV por criativo: disponível", "FTD vem da conta de anúncio"). Windsor e CSV são botões de fachada. Não há drill-down nem estado vazio guiado. A tabela principal não mostra nenhum dado de negócio.
7. **Não há nenhum teste no módulo.**

Status contra o [PLANO_DE_ENTREGAS.md](PLANO_DE_ENTREGAS.md) (Prioridade 4):

| Item | Status | Aceite pendente |
|---|---|---|
| Conexão | parcial | — |
| Sincronização e reconciliação | aberto | gasto bate com o Ads Manager |
| Atribuição e LTV | aberto | amostra rastreada da URL até a receita |

Pela spec do demo, nenhuma casa tem dados `meta_*` sincronizados hoje.

---

## 2. Inventário funcional

| Área | Item | Status |
|---|---|---|
| Configuração | Wizard de token (colar → descobrir contas por BM → selecionar) | Pronto |
| | Testar acesso, trocar token, desconectar, auditoria | Pronto |
| | OAuth "Entrar com Facebook" | Ausente (removido em 014695e; tabela `meta_oauth_states` sobrou) |
| | Validade do token (`debug_token`, expiração) | Ausente |
| | Windsor.ai, importação CSV | Só UI (grava um status e nada mais) |
| | Gerador de UTM (Meta, Google, TikTok, Kwai) | Pronto no cliente; só o Meta tem sync; template TikTok defeituoso |
| | Card "Plano técnico" | Só UI (nota interna exposta ao cliente) |
| Sync | Fila, runs, jobs, cron 5 min, sync diário de 7 dias | Pronto, com defeitos (AQ-10 a AQ-14) |
| | Backfill ao selecionar conta | Ausente (trigger `backfill` existe e não é usado) |
| | Reconciliação `reconcile_meta_attributions` | Pronta, mas a tela não usa |
| Visualização | Seletor de período | Parcial (UTC; o sync não respeita o período) |
| | 5 KPIs (Investido, ROAS, ROAS FTD, Custo/FTD, Redepósito) | Parcial (números errados, AQ-01 a AQ-05) |
| | Aba Criativos | Parcial (só métricas de mídia, sem FTD, receita ou ROAS; miniatura nunca aparece) |
| | Abas Públicos e Campanhas | Parcial (sem ROAS; legenda quebrada) |
| | Aba Evolução | Parcial (2 gráficos, cores fixas no código) |
| | Aba Diagnóstico (órfãos) | Parcial (inflada pelo tráfego do CRM) |
| | "Saúde da medição" e comparativo Meta × webhook | Só UI e falso |
| | LTV por coorte, receita líquida, drill-down até jogadores, exportação | Ausente |
| Qualidade | Testes | Ausente (zero arquivos) |
| | Controle de papel | Ausente |
| | Trava do tenant demo | Pronta no `origin/main`, exceto `enqueueMetaSync` |

---

## 3. Achados consolidados

Severidade: **C** crítica · **A** alta · **M** média · **B** baixa.

### 3.1 Integridade dos números

| ID | Sev. | Achado | Evidência | Origem |
|---|---|---|---|---|
| AQ-01 | C | As 5 consultas do overview não paginam e o PostgREST corta em 1.000 linhas. Gasto (anúncio × dia), jogadores e depósitos são truncados. Os depósitos vêm da casa inteira e são filtrados só no JS. | `marketing.functions.ts:289-328` | DEV-01, QA-01, ENG-02, PM (DEV-55 de 16/10) |
| AQ-02 | C | Investido, ROAS, receita e redepósito são somados depois do `.slice(0, 50)` dos criativos. Exemplo: 60 anúncios × R$ 10 aparecem como R$ 500. | `marketing.functions.ts:551-568` | UX-02, DEV-02, QA-02 |
| AQ-03 | A | O CAC/Custo por FTD é o gasto Meta dividido por todos os FTDs do período, inclusive orgânicos e vindos do CRM. Resultado: CAC subestimado. | `marketing.functions.ts:569-570, 599` | UX-16, DEV-08, QA-05, ENG-05 |
| AQ-04 | A | Não existe LTV. Depósitos e jogadores são filtrados pela mesma janela, então em "Hoje" o ROAS é quase zero. Quando não há depósito, a tela cai em `total_depositado` (vitalício). A receita é depósito bruto; saques e estornos são ignorados. Um status nulo conta como aprovado. | `marketing.functions.ts:306-327, 495-549` | UX-04, DEV-09, QA-05/06/07, ENG-05 |
| AQ-05 | A | Fuso horário: o cliente usa `toISOString()` e, depois das 21h em Brasília, "Hoje" vira o dia seguinte. O servidor usa o fuso do processo. Os insights são pedidos em UTC, mas o Meta responde no fuso da conta. O FTD do mesmo dia é comparado em UTC. | `midia-ltv.tsx:273-307`; `marketing.functions.ts:236-239, 276-285`; `meta.functions.ts:141-144` | UX-11, DEV-12, QA-03, ENG-08 |
| AQ-06 | A | Moeda: `marketing_ad_metrics_daily` não tem coluna de moeda. O gasto em USD é somado como BRL e a tela formata tudo como BRL. | `meta.functions.ts:714-734`; `midia-ltv.tsx:316-331` | UX-12, DEV-07, QA-04, ENG-09 |
| AQ-07 | M | Campos do Meta: `clicks` inclui todos os cliques, não `inline_link_clicks`. Reach e frequency diários são somados ou tomados pelo máximo. `actions` e `account_currency` não são pedidos. | `meta.functions.ts:146-161`; `marketing.functions.ts:367-369` | DEV-13, ENG-19 |
| AQ-08 | M | Upsert sem limpeza: linhas que o Meta deixou de devolver continuam somando. A chave única tem `ad_id` anulável, então imports sem ID duplicam. A janela de reprocessamento é de só 7 dias, mas o Meta ajusta dados por até 28 dias. | migration `20260917164000:44-63`; `meta.functions.ts:932` | DEV-30, QA-12, ENG-10, ENG-14 |

### 3.2 Atribuição

| ID | Sev. | Achado | Evidência | Origem |
|---|---|---|---|---|
| AQ-09 | A | **Duas fontes de verdade.** A RPC `reconcile_meta_attributions` grava `matched_*` após cada sync, mas a tela ignora essas colunas e recasa em JS com regras diferentes. | `marketing.functions.ts:213-234, 439-443`; migration `20261002200000` | DEV-18, QA-09, ENG-03, PM |
| AQ-10 | A | **Agrupamento por nome.** Anúncios com o mesmo nome em campanhas diferentes se fundem (gasto incluído), e renomear uma campanha a divide em duas. | `marketing.functions.ts:354-386` | UX-05, DEV-18, QA-08, ENG-11 |
| AQ-11 | A | **O ID em `utm_content` não casa.** A Sorte da Bet envia `utm_content=<ad_id>` numérico e nenhum `utm_id`, mas o casamento compara `utm_content` só com o nome do anúncio. O criativo nunca casa; só a campanha. | `webhook-user-envelope.test.ts:83-89`; `marketing.functions.ts:229-232` | PM |
| AQ-12 | A | **O CRM é contado como aquisição.** Links de SMS e WhatsApp levam `utm_source=betleads` e token em `utm_content`. Esses jogadores aparecem como "marcados" e "órfãos de BM". | `shortio.server.ts:244-269`; `webhook-process.server.ts:1440-1446` | DEV-19, PM |
| AQ-13 | A | **Último toque acidental.** Todo evento com UTM (depósito, login) sobrescreve `players.utm_*`, e um SMS de reativação apaga o anúncio de origem. `player_attributions` só é gravada no cadastro, mas a tela cai em `players.utm_*`. O upsert de atribuição não verifica erro. | `webhook-process.server.ts:356-361, 720-730, 1510` | ENG-04, PM |
| AQ-14 | M | Sem janela clique→cadastro e sem status explícito (`missing_utm`, `ambiguous`, `organic`). `fbclid` é guardado e não é usado. `inferAttributionProvider` usa `includes("ig")`, que casa "digital" e "original". As atribuições são filtradas por `captured_at` dentro do período, separado do cadastro. | `webhook-process.server.ts:1483, 1556`; `marketing.functions.ts:316-322` | ENG-12, QA-09 |

### 3.3 Sincronização e integração com o Meta

| ID | Sev. | Achado | Evidência | Origem |
|---|---|---|---|---|
| AQ-15 | C | **A versão padrão da API é a v23.0**, que o changelog da Marketing API dá como expirada em 9/6/2026 (a v24.0 expirou em 6/10/2026; a v25.0 está vigente). Se `META_API_VERSION` não estiver definida em produção, o sync pode estar falhando. | `meta.functions.ts:98-100`; `.env.example:15` | ENG-01 |
| AQ-16 | A | **Um job travado bloqueia a casa para sempre.** `claim_meta_sync_jobs` só retoma um lock vencido se `attempt_count < max_attempts`. O run fica ativo e o índice `meta_sync_runs_one_active_tenant` faz todo sync novo reaproveitá-lo. | migration `20261002143000:47-49, 97-101`; `meta.functions.ts:771-779` | DEV-03, QA-13, ENG-06, PM |
| AQ-17 | A | **Sem tratamento de rate limit.** O código só lê `error.message` e ignora `code`, `error_subcode` e os headers `x-business-use-case-usage`/`x-app-usage`. O backoff é fixo em 2 e 4 minutos, com 3 tentativas. A classificação de erro é uma regex sobre o texto. | `meta.functions.ts:115-139, 866-868, 1014-1015` | DEV-05, QA-14, ENG-13 |
| AQ-18 | A | **O erro de uma conta derruba a BM inteira.** "missing permissions" numa conta casa com a regex e marca a conexão como `error`; as outras contas param. "Testar conexão" com timeout também desliga o sync. | `meta.functions.ts:572-584, 866-868, 1027-1033` | QA-15, QA-16 |
| AQ-19 | A | **Insights síncronos pesados.** `level=ad` com `time_increment=1`, até 90 dias, sem async report. A paginação `fetch(next)` não tem timeout e o token vai na URL. | `meta.functions.ts:141-220` | DEV-06, QA-14, ENG-13 |
| AQ-20 | A | **Vazão.** São 2 jobs a cada 5 minutos, globais e em série, ou cerca de 24 contas por hora para todas as casas juntas. O agendamento faz N+1 consultas por tenant a cada tick e engole erros. | `tick.ts:16`; `meta.functions.ts:911-939` | DEV-04, QA-19, ENG-13 |
| AQ-21 | M | **O placeholder "anúncio ativo" zera o gasto do dia.** O sync grava os anúncios ativos de hoje com `spend=0` antes dos insights. Se os insights falham, o gasto fica zerado. O upsert seguinte apaga `raw.creative.thumbnail_url`, e o placeholder mascara o status "warning". | `meta.functions.ts:681-740` | DEV-11, QA-10, QA-11, ENG-07 |
| AQ-22 | M | Selecionar contas não dispara sync (não há backfill). "Atualizar agora" sincroniza `days` contados a partir de hoje: "Mês passado" lê a janela errada. Um manual de 30 dias reaproveita um agendado de 7. Contas novas na BM só aparecem se o token for colado de novo. | `meta.functions.ts:479, 779`; `midia-ltv.tsx:493` | UX-09, UX-13, DEV-14, QA-20 |
| AQ-23 | M | `meta_ad_accounts.sync_status` fica em `syncing` para sempre depois de uma falha, e `last_error` da conta nunca é preenchido. | `meta.functions.ts:676-680, 1012-1050` | DEV-15, QA-17 |
| AQ-24 | M | Token sem `debug_token`: aceita token de usuário de curta duração e as colunas de expiração ficam vazias. Não envia `appsecret_proof`. Não há alerta de expiração. | `meta.functions.ts:268-287` | DEV-16, QA-24, ENG-17 |
| AQ-25 | B | A troca de contas selecionadas não é atômica: desmarca todas e só depois marca as novas. Uma falha no meio deixa zero contas selecionadas, e um worker que leia nesse intervalo falha o job. | `meta.functions.ts:470-483` | DEV-26, QA-26 |

### 3.4 Segurança e permissões

| ID | Sev. | Achado | Evidência | Origem |
|---|---|---|---|---|
| AQ-26 | A | Conectar, trocar, desconectar, selecionar contas e sincronizar exigem só login. Um operador consegue trocar o token da casa. | `meta.functions.ts:268, 453, 513, 587, 837`; `marketing.functions.ts:618` | UX-24, DEV-10, QA-21, ENG-16, PM (SEC-23/F1-08) |
| AQ-27 | A | A RLS `FOR ALL` com GRANT de escrita para `authenticated` em `marketing_ad_metrics_daily`, `player_attributions`, `marketing_integrations` e `meta_ad_accounts` (inclusive `connection_id`) permite inserir gasto falso pelo PostgREST. O worker não confere se a conexão é da mesma casa. | migration `20261015090000:806-835` | DEV-10, QA-22, ENG-15 |
| AQ-28 | M | Casas suspensas continuam sincronizando: o worker não chama `assertTenantCanOperate`. `enqueueMetaSync` não tem a trava de demo. | `meta.functions.ts:842, 911-939` | QA-23, PM |
| AQ-29 | M | Tokens das conexões `legacy_oauth` continuam em texto puro, e o código ainda faz fallback para eles. | `meta.functions.ts:528-530, 669-671` | DEV-17 |
| AQ-30 | B | A chave de criptografia é SHA-256 direto do segredo (sem KDF), sem AAD e sem rotação real. | `meta-token.server.ts:4-48` | DEV-28, ENG-17 |

### 3.5 Experiência e interface

| ID | Sev. | Achado | Evidência | Origem |
|---|---|---|---|---|
| AQ-31 | C | **Textos fixos e falsos.** "Saúde da medição… LTV por criativo: disponível" é fixo. O comparativo "pela conta de anúncio × pelo seu webhook" mostra a mesma variável nos dois lados. "O FTD vem da conta de anúncio" é falso (vem do webhook). Aparece a marca "iFluxHub". O caminho "Integrações → Mídia paga" não existe. Há uma legenda quebrada. | `midia-ltv.tsx:846, 871-891, 1936-1939, 2035, 2130` | UX-01, UX-17, DEV-20, PM |
| AQ-32 | C | **A tabela de criativos não mostra resultado.** Diz "ordenado pelo que devolve", mas só tem Investido, CTR, CPC, CPM e Freq. Campanhas não têm ROAS. A miniatura nunca aparece: `pickNestedString` não desce em `creative`. | `midia-ltv.tsx:2035-2063`; `marketing.functions.ts:257-269, 361-363` | UX-03, UX-15, QA-11 |
| AQ-33 | C | **Não há drill-down.** Campanha, conjunto e anúncio são tabelas planas, e os números de cadastros e FTD não abrem a lista de jogadores. | `midia-ltv.tsx:942-964` | UX-05 |
| AQ-34 | C | **Primeiro acesso sem guia.** Sem conexão, o usuário cai num painel com "R$ 0", sem chamada para conectar. O wizard não termina: chega ao passo 3 e não dispara o primeiro sync. O toast diz "contas conectadas" quando elas ainda não foram selecionadas. | `midia-ltv.tsx:381, 451, 733, 1235` | UX-06, UX-09 |
| AQ-35 | C | **Funcionalidades de fachada.** Windsor e CSV só gravam um status. O card "Plano técnico" expõe notas internas. O gerador de UTM oferece plataformas sem sync e tem o template TikTok defeituoso. | `midia-ltv.tsx:246-260, 1080-1179` | UX-07, UX-18, UX-25, DEV-22 |
| AQ-36 | A | **Mensagens de erro.** Qualquer erro aparece como "As tabelas de mídia ainda não existem… rode as migrations", inclusive um período acima de 90 dias, que o seletor permite. Token expirado só aparece na aba Configuração, com o erro cru da Graph API. | `midia-ltv.tsx:555-560, 780, 1411-1415`; `marketing.functions.ts:7` | UX-08, UX-10, DEV-21, QA-25 |
| AQ-37 | A | **Hierarquia.** Os KPIs ficam abaixo de até 8 blocos de texto e banners. Faltam o funil (Investido → Cliques → Cadastros → FTD → Depósitos), LTV, payback e a comparação com o período anterior. | `midia-ltv.tsx:727-940` | UX-14 |
| AQ-38 | M | **Nomenclatura.** "Midia e LTV" na página contra "Aquisição e LTV" no menu. Dezenas de textos sem acento. "players" e "jogadores" misturados. | `midia-ltv.tsx:78, 528` e outros | UX-17, PM |
| AQ-39 | M | **Estados e navegação.** Sem skeleton (os KPIs mostram "R$ 0" enquanto carregam). Período, aba e seção ficam fora da URL. As abas não usam `TabsContent`. A seleção de contas é uma lista plana: sem busca, sem agrupamento por BM, sem aviso de alterações não salvas. | `midia-ltv.tsx:379-381, 703, 942-1014, 1457-1516` | UX-20 a UX-23 |
| AQ-40 | B | Acessibilidade (progressbar, `caption`, `aria-hidden`, alternativa textual nos gráficos), responsividade das tabelas (rolagem dupla, sem coluna fixa) e polling de 30 s do overview pesado. | `midia-ltv.tsx:403, 772-777, 1862-2063` | UX-26 a UX-30, DEV-25 |

### 3.6 Código e qualidade

| ID | Sev. | Achado | Evidência | Origem |
|---|---|---|---|---|
| AQ-41 | A | Nenhum teste em `meta.functions`, `marketing.functions`, `meta-token`, na fila ou na RLS do módulo. O `npm test` sem filtro também roda as cópias em `.claude/worktrees`. | busca por `*.test.ts` | DEV-23, QA §1 |
| AQ-42 | M | Componente monolítico: 14 componentes, 7 mutations na raiz, `ConfiguracaoSection` com 21 props. Os tipos do servidor são redeclarados à mão. Há 45 `as any`, embora `types.ts` já tenha as tabelas. | `midia-ltv.tsx`; `meta.functions.ts` | DEV-24, DEV-25, PM (F5-02) |
| AQ-43 | B | Código morto: `meta_oauth_states`, `token_expires_at`, `fbclid`/`gclid`/`ttclid` lidos e não usados, e o `catch {}` vazio no agendamento. | — | DEV-29, DEV-31 |
| AQ-44 | B | Observabilidade: não há métrica de atraso por conta, nem alerta de conta em erro ou de run parado, nem histórico da taxa de casamento. A falha de reconciliação só vai para `console.error`. | `meta.functions.ts:1061` | ENG-18 |

### 3.7 Projeto

| ID | Achado | Origem |
|---|---|---|
| AQ-45 | **Sobreposição com a Central de Resultados.** A aba Aquisição da Central (`crm_acquisition_funnel`) e este menu podem mostrar números diferentes para a mesma coisa. | PM |
| AQ-46 | **Adoção depende da casa.** O modelo atual exige que cada casa crie um app Meta e um Usuário do Sistema, ou seja, alguém técnico do lado dela. Um app único da Betleads com OAuth exige App Review, verificação do negócio e Advanced Access, um processo que leva semanas. | PM, ENG |
| AQ-47 | **Demo vazio ou distorcido.** O clone copia atribuições, mas não copia gasto, e a decisão anterior foi "nada é sintetizado". O menu vai mostrar receita e órfãos com investimento zero. | PM |
| AQ-48 | **`main` local desatualizado** (32 commits). Qualquer trabalho no módulo deve partir do `origin/main`. | PM |

---

## 4. Arquitetura atual e alvo

```
ATUAL
pg_cron */5 ─> /api/public/meta-sync/tick ─> processMetaSyncQueue(2)
   enqueue agendado (N+1 por tenant, 7 dias a cada 23h)
   claim_meta_sync_jobs (job travado na última tentativa = tenant bloqueado)
      ─> Graph API (padrão v23.0) ─ /ads ACTIVE gravado como fato com spend=0
                                  └ /insights síncrono, level=ad, por dia
         ─> marketing_ad_metrics_daily (sem moeda; authenticated escreve)
         ─> reconcile_meta_attributions (matched_* que ninguém lê)
Casa ─webhook─> players.utm_* (sobrescrito a cada evento)
             └> player_attributions (só no cadastro)
/midia-ltv ─> 5 selects sem paginação (≤ 1.000) ─> casamento por NOME em JS
           ─> ROAS = depósito bruto do período ÷ gasto; CPA = gasto ÷ todos os FTDs

ALVO
pg_cron ─> enqueue em SQL (quente: 3 dias várias vezes ao dia; 28 dias semanal; backfill ao selecionar)
        ─> worker: concorrência limitada, insights assíncronos, backoff pelos headers, erro por código
           ├> meta_campaigns / meta_adsets / meta_ads (catálogo, miniatura)
           └> marketing_ad_metrics_daily (fuso da conta, moeda; delete+insert por janela)
Casa ─webhook─> aquisição first-touch IMUTÁVEL (utm_*, ad_id, fbclid, captured_at), separada do toque do CRM
attribution_resolve() em SQL, versionada: ad_id > nome único > campanha; status explícito
RPCs agregadas (has_tenant_access) por tenant × campanha × conjunto × anúncio × dia de cadastro:
   gasto, cadastros, FTD, depósitos e saques D0/D7/D30/D90, LTV por coorte
/midia-ltv e Central de Resultados ─> as mesmas RPCs
(fase posterior) Conversions API de volta para o Meta
```

---

## 5. Métricas: o que os dados permitem

| Métrica | Possível hoje? | Observação |
|---|---|---|
| Gasto, impressões, cliques, CTR, CPC, CPM | Sim | Corrigir cliques de link e moeda |
| Cadastros e FTD atribuídos | Sim | Depois de corrigir a atribuição |
| Depósito bruto D0/D7/D30/D90 por coorte | Sim | `deposits` aprovados |
| Depósito líquido (menos saques) | Sim | A tabela `withdrawals` existe |
| GGR / NGR | **Não** | Só existe o snapshot `total_apostado`. Seria preciso que as casas enviassem apostas, prêmios e bônus |
| Conversões reportadas pelo Meta | Não importado | Bastaria pedir `actions`/`action_values` |

Rotular como "ROAS" um valor calculado sobre depósito bruto superestima o retorno, porque depósito não é receita da casa. O nome na tela precisa ser explícito ("ROAS sobre depósitos").

---

## 6. Fontes externas (Meta)

- [Changelog da Marketing API](https://developers.facebook.com/docs/marketing-api/marketing-api-changelog): datas de expiração das versões.
- [Autorização e níveis de acesso](https://developers.facebook.com/docs/marketing-api/overview/authorization): acesso Limited vs. Full, App Review, verificação do negócio.
- [Boas práticas da Insights API](https://developers.facebook.com/docs/marketing-api/insights/best-practices): jobs assíncronos, headers de throttle, dados estáveis após 28 dias, fuso da conta.

As datas de expiração das versões devem ser reconfirmadas no momento da correção (item AL0-01 do escopo).
