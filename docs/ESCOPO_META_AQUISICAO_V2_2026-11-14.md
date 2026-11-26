# Escopo — Meta Ads e Aquisição e LTV, versão 2 — 2026-11-14

Base: [AUDITORIA_META_AQUISICAO_2026-11-14.md](AUDITORIA_META_AQUISICAO_2026-11-14.md), que reúne as visões de UX, dev e tráfego, mais leitura do banco de produção.

## 1. Objetivo

Que a casa responda sozinha a três perguntas, com números em que pode confiar:

1. **Quais contas e BMs entram?** Conectar, adicionar, trocar e remover a partir da própria tela de Aquisição.
2. **Quais campanhas entram?** Incluir, excluir ou marcar como "apoio" (engajamento, aquecimento) e ligar um grupo de campanhas a uma origem de cadastro (por exemplo, as campanhas de live ↔ cadastros `utm_medium=live`).
3. **O anúncio pagou?** Custo e ROAS com contexto: quanto do gasto tem cadastro ligado, coorte madura, comparação com o período anterior.

## 2. Situação de partida (bravabet365, 08–14/11, consulta só de leitura)

| Fato | Valor |
|---|---|
| Contas conectadas e marcadas | 13–14, todas BRL; nenhum gasto de conta desmarcada |
| Cadastros com UTM paga (`utm_medium=paid`) | 10, **todos ligados a anúncio** |
| Cadastros de live do Instagram (`utm_medium=live`) | 140 (85 depositantes, R$ 7.542), todos classificados como "sem anúncio correspondente" |
| Gasto em campanhas "CAMPANHA LIVE…" | ~R$ 3.850 de R$ 6.035, sem nenhum cadastro ligado |
| Gasto em engajamento/aquecimento | ~R$ 586 |
| Ligação feita por | nome do anúncio ("ADS 01", "Criativo 107"): frágil, porque os nomes se repetem |

## 3. Fases

### F1 — Números honestos e atalhos (esta entrega, sem tabela nova)

| ID | Entrega | Onde |
|---|---|---|
| F1-01 | Botão **"Contas da Meta"** sempre visível no cabeçalho de Aquisição quando já há conexão (sem conexão continua "Conectar Meta"), com o número de contas marcadas. No filtro "BM / conta", item fixo **"Adicionar ou remover contas"** | `midia-ltv.tsx`, `ad-account-filter.tsx` |
| F1-02 | **Só contas marcadas entram** no investido, nas métricas e no catálogo de gasto. Desmarcar uma conta tira o gasto dela de todos os períodos | migração `marketing_overview` |
| F1-03 | **Motivo de cada cadastro sem anúncio:** `live`, `other_source` (Kwai, Google, afiliado…), `id_not_found` (ID de anúncio ou campanha de conta não conectada), `macro` (`{{ad.id}}` literal), `source_only` (só source/medium), `ambiguous` (nome repetido), `name_not_found`, `pending`. A RPC devolve o resumo por motivo (todas as linhas, não só as 50 primeiras), e cada linha do Diagnóstico ganha o seu motivo | migração + `marketing-overview.ts` |
| F1-04 | Aviso de órfãos **separado por motivo**, cada um com uma ação em linguagem simples e um botão "Ver no Diagnóstico" que abre a sub-aba | `midia-ltv.tsx` |
| F1-05 | **Gasto sem cadastro ligado:** a RPC devolve `spendUnlinked`, a soma do gasto das campanhas sem nenhum cadastro ligado no período, e as 5 maiores. A tela mostra quanto do investido é isso e ensina a ligar (pôr o ID da campanha em `utm_campaign` nos links da live ou do perfil) | migração + `midia-ltv.tsx` |
| F1-06 | **Contexto nos KPIs:** ROAS com "cada R$ 1 investido voltou R$ X"; "Depósito líquido" vira "Depósito líquido de anúncio"; cartão de sincronização diz "gasto de N contas lido", e não "linhas processadas" | `midia-ltv.tsx` |
| F1-07 | **Textos:** token → chave, ROI → ROAS, plurais sem "(s)"; "Atualizar agora" desligado explica o motivo também para o admin | `midia-ltv.tsx` |
| F1-08 | **Integrações:** "Adicionar Usuário do Sistema" vira "Conectar outra BM ou chave", explicando que uma BM nova também pode chegar pela mesma chave + "Testar acesso". Renomear, Trocar chave e Desconectar passam a ser botões com texto, fora do "⋯" | `meta-copy.ts`, `connection-card.tsx` |
| F1-09 | Ajuda e tour da tela atualizados | `src/help/screens/midia-ltv.ts` |

**Fora da F1:** tabela de escopo de campanhas, grupos de mídia, coorte madura.

**Critério de aceite (bravabet365, 08–14/11):**
- o aviso mostra "140 de live" separados;
- o gasto sem cadastro ligado fica em torno de R$ 5,5 mil (90%), conferido em produção com ROLLBACK: 145 cadastros "live" e 1 "outra origem";
- o botão "Contas da Meta" leva a `/webhooks#meta`.

### F2 — Escopo de campanhas e grupos de mídia (núcleo da queixa)

| ID | Entrega |
|---|---|
| F2-01 | **Catálogo** `meta_campaigns` / `meta_adsets` (id, nome, objetivo, status efetivo, conta, primeira e última vez visto), preenchido em todo sync, inclusive de campanhas pausadas |
| F2-02 | **Tabela `meta_campaign_scope`:** `tenant_id`, `level` (`campaign`/`adset`/`ad`), `object_id` ou `name_pattern`, `mode` (`include`/`exclude`/`support`), `created_by`, `created_at`. Gravação só por RPC `security definer` com checagem de admin e trilha de auditoria. Configuração por casa: "campanhas novas entram automaticamente" (padrão sim) |
| F2-03 | **Grupos de mídia:** `media_groups` (nome, regra de campanha por ID ou "nome contém", regra de cadastro por `utm_medium` / `utm_source` / `utm_campaign`). O gasto do grupo é dividido pelos cadastros que batem com a regra. Primeiro uso: "Live Instagram" = campanhas com "LIVE" ↔ `utm_medium=live` |
| F2-04 | `marketing_overview` respeita escopo e grupos. O jogador ligado a algo excluído vira `excluded` (fora do órfão e do pago). O gasto de "apoio" aparece à parte, com custo total opcional ("com apoio") |
| F2-05 | **Gerenciador por BM** em Integrações: lista por BM com contas marcadas/total, chave, validade e status da conta (ativa, desativada, banida, sem pagamento). Ações em texto, botão "+ Conectar outra BM" e aviso de "N contas novas encontradas" |
| F2-06 | **Tela "Campanhas que entram"**: árvore conta › campanha › conjunto › anúncio, com busca, filtros por status e por "nome contém", e marcar/desmarcar com rascunho e salvar (reaproveita `use-selection-draft.ts`). Na Aquisição, chip "N campanhas fora do cálculo · editar" |
| F2-07 | Visão "Por grupo de mídia" na Aquisição (gasto, cadastros, FTD, custo, ROAS por grupo) |

### F3 — Uso diário do gestor de tráfego

| ID | Entrega |
|---|---|
| F3-01 | Coorte madura: "receita até hoje" da coorte do período; ROAS D0/D7/D30; selo "coorte com X dias em média"; selo "hoje parcial" |
| F3-02 | Comparação com o período anterior em todos os KPIs; meta de custo por 1º depósito com alerta |
| F3-03 | Drill-down campanha › conjunto › anúncio com miniatura persistida (inclusive de anúncios pausados); clique em cadastros/FTD leva à lista de jogadores |
| F3-04 | Colunas de mídia: CPM, CPC, cliques no link, custo por clique no link, alcance, frequência, visualizações da página de destino (buscar `reach`, `frequency`, `actions`) |
| F3-05 | Guia de UTM com IDs + validador ao vivo ("dos últimos 50 cadastros, X% chegaram com ID") |
| F3-06 | Hierarquia da tela: uma faixa de status, um controle de período, avisos agrupados e recolhíveis, "Números em validação" como selo com data, estado vazio real |
| F3-07 | "Atualizar agora" relê exatamente o período da tela (`since`/`until`), com a mesma regra nas duas telas |

### F4 — Escala e acabamento

| ID | Entrega |
|---|---|
| F4-01 | "Meta diz X × casa confirmou Y" (`actions` com janela de 7 dias após clique e 1 dia após visualização) |
| F4-02 | Conversions API com cadastro e 1º depósito (`fbc`/`fbp`, `event_id`); revisar antes a política de anúncios de apostas e a LGPD |
| F4-03 | Conversão de moeda pela PTAX; % de IOF e impostos por conta; aviso de fuso diferente de Brasília |
| F4-04 | Primeiro toque fixo, `fbclid` sem UTM como "Meta sem anúncio", `instagram` orgânico fora do provedor `meta`, jogador sem linha de atribuição |
| F4-05 | Segurança e desempenho: revogar gravação de `player_attributions` para `authenticated`; rotação da chave de criptografia; índice e catálogo materializado para a reconciliação |
| F4-06 | Acessibilidade (papéis por gravidade, `aria-live`, `progressbar`), mobile com KPIs primeiro |

## 4. Riscos e decisões

- **F1-02 muda números do passado:** uma conta desmarcada some de todos os períodos. Decisão: desmarcar significa "não é desta casa". Uma conta banida que gastou deve continuar marcada.
- **F1-03 é só classificação:** nenhum cadastro muda de status no banco; a reconciliação continua igual.
- **F2-03 divide gasto entre cadastros por regra:** não é atribuição por anúncio. A tela precisa dizer isso ("gasto do grupo ÷ cadastros da origem").
- **Desempenho:** `marketing_overview` já roda em uma passada; o resumo por motivo e o gasto sem cadastro ligado saem de CTEs que já existem. Conferir o tempo da RPC antes e depois em produção.
