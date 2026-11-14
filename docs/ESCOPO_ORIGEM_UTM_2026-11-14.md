# Escopo — Origem dos cadastros (UTMs sem depender da Meta) — 2026-11-14

## Problema

O sistema já salva as UTMs e os click IDs de cada cadastro, em `player_attributions` e em `players.utm_*`, mas a casa não tem onde ler isso. A única leitura é a aba Mídia de Aquisição e LTV, que parte do gasto da Meta e só funciona com BM conectada. Nem toda campanha vem da Meta: há lives, influencers, SMS de terceiros, Kwai e afiliados.

A análise foi feita pelo designer UX, pelo gestor de tráfego e pelo engenheiro.

## Dados de produção (últimos 30 dias, até 14/11)

**Cobertura de UTM** (cadastros com UTM ÷ cadastros):

| Casa | Cadastros com UTM / total |
|---|---|
| pixpgf | 4.852 / 9.617 |
| pixreals | 1.192 / 8.441 |
| laelebet | 1.407 / 2.019 |
| forrandobet | 658 / 1.165 |
| sorte-da-bet | 360 / 413 |
| bravabet365 | 274 / 390 |
| betgreen | **25 / 17.879** |
| mega-sorte-7k | **0 / 220** |
| 99bet | **0 / 210** |
| 777 | **0 / 137** |

**Fonte/meio:**

| Fonte / meio | Cadastros |
|---|---|
| ig/paid | 6.024 |
| fb/paid | 3.476 |
| sem UTM | 2.026 |
| instagram/live | 183 |
| betleads/sms | 75 |
| an/paid | 40 |
| chatgpt.com, rcs/messaging, ifluxhub/sms, kwai, wa | poucos |

**Formato da campanha:**
- **Só o ID da Meta:** pixpgf, pixreals, forrandobet e sorte-da-bet mandam a campanha como ID (ex.: `120250280510370075`), e o conteúdo e o termo também vêm como IDs.
- **Nomes:** a laelebet manda nomes ("CBO LA ELE", "AD - 4").
- **Nomes manuais de live:** a bravabet manda coisas como `live_12_11` e `humor_realeza`.

**Casamento com a Meta conectada** (`match_status`):

| Status | Cadastros |
|---|---|
| `orphan_campaign` | 9.652 |
| `missing_utm` | 2.026 |
| `matched_*` | 75 |

Ou seja, quase nada casa com a Meta conectada.

## Decisão

Criar uma **3ª aba "Origem" em Aquisição e LTV** (`/midia-ltv#origem`), ao lado de Mídia e de Retenção.

- **Por que não uma tela nova:** a seção Resultados já tem 5 itens, e uma tela "Campanhas UTM" responderia a mesma pergunta que a Aquisição.
- **Sem Meta:** a aba abre e funciona sem a Meta conectada.
- **Divisão das abas:** a Mídia continua mostrando gasto × retorno; a Origem mostra quem chegou, por onde e se depositou.
- **Ordem:** a Origem vem **antes da F2** de `ESCOPO_META_AQUISICAO_V2_2026-11-14.md`. Ela atende já as 6 casas com UTM que não casam com a Meta. Depois, a F2 só pluga o gasto da Meta nos mesmos grupos.

## Regras de número

- **Coorte por data de cadastro.** Os cadastros do período e tudo o que eles depositaram **desde o cadastro até hoje**. O texto da tela diz isso.
- **1º depósito:** é o primeiro depósito aprovado do jogador. Segue a mesma regra da Mídia: com `ftd_em` da casa mais de 10 min antes, o depósito não conta como o primeiro.
- **Depósito líquido = depósitos − saques**, os dois aprovados e desde o cadastro. **Não é GGR.** O GGR só existe por casa, e a tela diz isso.
- **Sem origem:** é sempre uma linha própria, no fim, e entra no total. Nunca é distribuída entre as campanhas.
  - Quando há fbclid mas não há UTM, o cadastro cai no canal "Meta (sem campanha)".
- **CRM próprio não é aquisição.** Um cadastro conta como CRM quando:
  - tem `player_attributions.bl_click_id`; ou
  - tem `utm_source = betleads`.

  O link do SMS pode carregar a `utm_source` da própria casa, por isso a chave confiável é o `bl_click_id`. Esses cadastros saem dos totais e aparecem numa linha "Mensagens do CRM (fora da conta)".
- **Canal normalizado** pela função `attribution_channel` (regras na tabela abaixo). O valor bruto continua visível.

| Canal | Regra |
|---|---|
| Meta pago | ig/fb/an/msg/meta/facebook/instagram com meio pago ou vazio |
| Live | meio começa com "live" |
| Google | google ou gclid |
| TikTok | tiktok ou ttclid |
| Kwai | kwai |
| WhatsApp | wa/whatsapp |
| SMS e mensagens | sms, rcs, messaging |
| Busca/IA orgânica | chatgpt.com, perplexity, bing… |
| Afiliados e indicação | sem UTM, mas com `players.affiliate_id`; ou meio afiliado |
| Outros | o resto |
| Meta (sem campanha) | só fbclid |
| Sem origem | nada |

- **Nome exibido:**
  1. apelido da casa (U2);
  2. nome do catálogo da Meta (`meta_ads`), quando o valor é ID;
  3. o próprio valor.
- **Aviso de cobertura:** abaixo de 70% de cadastros com origem, a tela avisa. Abaixo de 20%, o aviso é forte. Se houver menos de 30 cadastros com origem, as porcentagens aparecem como "poucos dados".
- **Moeda:** usar a moeda da casa (`useMoney`).

## Fases

### U0 — por que 4 casas não trazem UTM — FEITO 14/11

Conclusão: nas quatro casas o parser não perde nada. As casas não mandam UTM porque o tráfego vem de afiliado ou de indicação. A investigação foi só de leitura, em `webhook_logs`, eventos `cadastro` dos últimos 30 dias.

| Casa | Formato | O que mostram os dados |
|---|---|---|
| betgreen | Axio, igual à pixpgf (`data.signupAttribution`, `data.trackingContext.landingUrl`) | De 31.801 cadastros, só 99 trazem `utmSource`, e todos são links nossos. Na `landingUrl`: `inviteCode` em 10.376 (indicação entre jogadores), `axioAffId`/`axioClickId` em 5.973 (afiliado) e `fbclid` em 1.325. O fbclid já é capturado (1.090 em `player_attributions`). |
| mega-sorte-7k e 99bet | envelope `user` | `tracking.utm_*` chega sempre como `""`. Só `tracking.ref` / `?ref=` aparece preenchido. |
| 777 | payload mínimo | Não tem objeto de tracking. Às vezes vem um `ref` numérico. |

**Afiliado já gravado:** `players.affiliate_id` cobre a maior parte dos cadastros sem UTM nos 30 dias.

| Casa | Cadastros sem UTM com afiliado |
|---|---|
| betgreen | 6.370 |
| pixreals | 6.055 |
| pixpgf | 2.860 |
| mega-sorte-7k | 188 |
| 99bet | 150 |

Por isso a U1 ganhou o canal **"Afiliados e indicação"** e o agrupamento **Afiliado**, com o nome do expert quando o código é de um expert.

**`bl_click_id`:** está vazio em todos os cadastros dos últimos 30 dias. Na prática, o CRM é reconhecido por `utm_source=betleads`.

**Pendências (fora da U1, para decidir):**
- **`inviteCode` da betgreen:** é indicação entre jogadores e hoje não é lido. Gravar como "indicação" separada do afiliado.
- **`tracking.ref` e `ref` (777):** guardar como afiliado. Cuidado: `affiliate_id` também credita expert, então antes é preciso confirmar com as casas que o `ref` é código de afiliado.
- **`resolveUtm`:** usar a query da `landingUrl` como fallback, para proteger casas que só ecoam a URL.
- **Pedir às casas** UTM nos links de anúncio.

### U1 — aba Origem (leitura) — FEITO 14/11 (migração 20261231101000 não aplicada)

Medido em prod com SELECT equivalente só leitura:

| Casa | Período | Agrupamento | Tempo |
|---|---|---|---|
| pixpgf | 90 dias | canal | 0,97 s |
| pixpgf | 30 dias | campanha | 0,56 s |
| pixreals | 30 dias | canal | 0,31 s |
| laelebet | 30 dias | campanha | 0,42 s |

Os tempos incluem a rede. A série diária por subconsulta custava 2,6 s e foi trocada por um único agrupamento.


**RPC `origin_breakdown(_tenant, _from, _to, _group, _filters, _include_crm, _limit)`:**
- `security definer`, com `has_tenant_access`, período em BRT e no máximo 93 dias;
- `statement_timeout` de 8 s;
- sem tabela agregada nem cron. O volume é o mesmo da `marketing_overview`.

**Agrupamentos:** canal, fonte, meio, campanha, conjunto (`utm_term`), anúncio (`utm_content`) e afiliado (`players.affiliate_id`, com o nome do expert).

**Filtros:**
- valor exato por dimensão, que é o que faz o drill-down;
- busca;
- "só com 1º depósito".

**Retorno:**
- `rows` com até `_limit` linhas, ordenadas por cadastros, e `others` com o resto;
- `noOrigin`, `crm` e `totals`;
- `coverage`;
- `daily`, com cadastros e 1º depósito por dia.

**Tela:**
- período compartilhado com a aba Mídia;
- cards de cadastros, com origem, 1º depósito e depósito líquido;
- faixa de cobertura;
- chips "Agrupar por" e caminho com breadcrumb;
- gráfico diário;
- tabela ordenável, em que clicar desce um nível;
- CSV do nível atual;
- versão celular em cards;
- estado vazio com montador de link UTM.

**Ajuda:** seção `origem` em `src/help/screens/midia-ltv.ts`.

### U2 — regras e apelidos por casa

- `tenant_utm_labels (tenant_id, dimension, value_norm, label)`, com edição na própria tabela (✎).
- `tenant_channel_rules (tenant_id, field, match, pattern, channel, priority)`, com sugestões a partir dos 20 valores mais frequentes.
- A gravação passa por uma RPC de admin com auditoria. A leitura segue a RLS por casa.

### U3 — aprofundar

- lista de jogadores de uma linha (`origin_breakdown_players`, 50 por página), ligada aos números;
- depósito líquido em D7 e D30 da coorte, com "coorte imatura" quando ainda não deu o prazo;
- comparação com o período anterior;
- alternância "por data do depósito";
- visões salvas;
- CSV por cadastro.

### U4 — custo (junto com a F2)

- `media_group_costs` sobre os `media_groups` da F2-03, para cachês de live e influencer e para afiliados por CPA;
- custo por cadastro, custo por FTD e ROAS por grupo;
- nome vindo do catálogo `meta_campaigns` da F2-01.

## Riscos

- **F1 na mesma branch.** A U1 é feita na branch `feat/meta-aquisicao`, que já tem a F1 sem aplicar. A migração da U1 não depende da F1: ela tem a função própria.
- **Desempenho.** Medir a RPC em produção com ROLLBACK, na pixpgf com 90 dias, antes de liberar. Se passar de 1,5 s, avaliar o índice `deposits (tenant_id, player_id, created_at) include (valor) where status='aprovado'`.
- **Fonte suja.** Até a U2, valores sem regra caem em "Outros".
