# Auditoria — Integração Meta Ads e tela "Aquisição e LTV" (2026-11-14)

Três frentes: designer UX, dev sênior e gestor de tráfego Meta. Leitura do código na branch `trabalho` e consulta **somente leitura** no banco de produção (bravabet365, de 08/11 a 14/11). Nenhum arquivo de código foi alterado.

---

## 0. Resumo executivo

1. **A gestão de BMs já existe, mas fica escondida.** Ela está em Configurações → Integrações (`/webhooks#meta`). A tela de Aquisição perde qualquer atalho depois da primeira chave (`src/routes/midia-ltv.tsx:270-287`). O botão de adicionar se chama "Adicionar Usuário do Sistema", e Renomear, Trocar chave e Desconectar ficam num menu "⋯" só com ícone (`connection-card.tsx:202-242`). Quem não é admin da casa não vê nenhuma dessas ações.
2. **Escolher campanhas, conjuntos ou criativos não existe em nenhuma camada.** Não há tabela, RPC nem tela para isso; a única escolha possível é por conta de anúncio.
3. **O ROAS de 0,04x está enganando, mas não por erro de casamento.** No banco, **todo o tráfego pago com UTM casou (10 de 10)**. Os 140 cadastros "sem anúncio correspondente" vêm das **lives do Instagram** (`utm_medium=live`, links no botão e no comentário fixado). E essas lives são impulsionadas por campanhas "CAMPANHA LIVE…", que levaram **cerca de R$ 3.850 dos R$ 6.035** investidos. O sistema soma esse gasto no "Investido", mas não tem como ligá-lo aos cadastros da live. Por isso a lacuna mais importante é **mapear um grupo de campanhas para uma origem de cadastro**.

### Números reais da semana (bravabet365, 08–14/11)

| Origem do cadastro | Cadastros | Depositantes | Depósitos | Gasto ligado (aprox.) |
|---|---|---|---|---|
| Live do Instagram (`utm_medium=live`) | 140 | 85 | R$ 7.542 | ~R$ 3.850 (campanhas "CAMPANHA LIVE…") |
| Anúncio direto (`utm_medium=paid`, casado) | 10 | 7 | R$ 260 | ~R$ 1.600 |
| Sem UTM | 29 | 14 | R$ 1.005 | — |
| Engajamento / aquecimento | — | — | — | ~R$ 586 |

Leitura do gestor:
- **Funil da live:** cerca de **R$ 45 por depositante** e ROAS bruto de cerca de **1,96x**.
- **Anúncio direto para o site:** cerca de **R$ 229 por depositante** e ROAS bruto de cerca de **0,16x**.

A tela mostra uma média só (R$ 862 por 1º depósito e 0,04x) e esconde o canal que funciona. São valores brutos: os saques da coorte da live não foram descontados, e o gasto das lives foi agrupado pelo nome da campanha.

---

## 1. A queixa, ponto por ponto

| Queixa | Situação | Evidência |
|---|---|---|
| O botão de conectar some depois da primeira BM | **Verdade na Aquisição.** Em Integrações o botão existe, mas com outro nome | `midia-ltv.tsx:270` (`connections.length === 0`); a ajuda confirma em `src/help/screens/midia-ltv.ts:35`. Em Integrações: `meta-connection-view.tsx:328-341` |
| Não dá para adicionar outra BM | **Dá, mas não se encontra.** O botão é "Adicionar Usuário do Sistema". Uma BM nova também pode chegar pela mesma chave + "Testar acesso", e nada explica isso | `connect-key-sheet.tsx:557`; `meta.functions.ts:704`; contas novas chegam desmarcadas e sem aviso |
| Não dá para editar nem excluir | **Dá, mas fica escondido** no "⋯" sem texto. Edita-se a *chave*, não a BM. Remover uma conta = desmarcar e salvar. Quem não é admin não vê nada | `connection-card.tsx:202-242`, `:183`; `meta-connection.tsx:49`; `account-selection.tsx:91-97` |
| Não dá para escolher campanhas ou criativos | **Verdade. Não existe** | Nenhuma tabela, coluna ou RPC de include/exclude. Só `meta_ad_accounts.selected` (`20261118100000_meta_mb1_multi_bm.sql:606`) |

O backend já aceita várias BMs: `meta_connections` por chave e `meta_ad_account_access` N:N. A redescoberta de contas roda a cada 24 h. O que falta é **interface e texto**.

---

## 2. Achados por frente

### 2.1 Designer UX

**Descobribilidade**
- A conexão da Meta fica em Configurações → Integrações (URL `/webhooks`), na 3ª aba de 4 (`webhooks.tsx:59-64`).
- O vocabulário muda de lugar para lugar: "Chave", "Usuário do Sistema", "conexão", "BM", "conta". O usuário pensa em BM.

**Hierarquia da Mídia: há 8 blocos antes dos KPIs** (`midia-ltv.tsx:448-655`)
- Há dois indicadores de "última leitura": o cartão de sincronização e a linha "Gasto: Meta Ads…".
- Há três controles de período: o chip, os presets e as datas.
- Há até cinco banners amarelos com o mesmo peso visual.
- O banner de órfãos manda "ver a aba Diagnóstico", mas não tem link (`:653`).

**KPIs**
- "Depósito líquido" soma só os jogadores vindos de anúncio, e o título não diz isso (`marketing-overview.ts:23-27`).
- O ROAS aparece sem referência: falta dizer que abaixo de 1x ainda não pagou, falta comparação com o período anterior, e falta mostrar a ligação com os órfãos.
- "121 linhas processadas" não quer dizer nada para leigo.

**Textos (regra do leigo)**
- "token" e "ROI" aparecem em `:640-641`, enquanto o resto da tela usa "chave" e "ROAS".
- Plural "conta(s)" em vez de plural correto.
- "Números em validação" não diz desde quando nem até quando.

**Estados**
- Sem conexão, a tela mostra 5 KPIs zerados em vez de um estado vazio.
- "Atualizar agora" fica desligado sem explicar o motivo para o admin (`:454`).
- "Atualizar agora" na Mídia e "Sincronizar agora" em Integrações têm regras diferentes (`:454` × `meta-connection-view.tsx:347`; período da tela × sempre 7 dias).

**Acessibilidade**
- Os banners não têm `role` por gravidade.
- O progresso da sincronização não tem `aria-live` nem `role="progressbar"`.
- O "⋯" não tem texto visível.

**Mobile**
- Os banners empilhados empurram os KPIs para várias telas abaixo.

### 2.2 Dev sênior

**Atribuição hoje**
- As UTMs vêm no webhook de cadastro (`webhook-process.server.ts:1311-1380`) e são gravadas em `player_attributions` como `pending`.
- `reconcile_meta_attributions` (`20261019100000_aquisicao_ltv_al1.sql:110-262`) tenta casar nesta ordem: ID do anúncio → nome único do anúncio → ID da campanha → nome único da campanha. O que sobra vira `orphan_campaign`.
- O gasto vem com `level=ad` e `time_increment=1`, no fuso da conta, e é idempotente (`replace_meta_ad_metrics`).

**Bugs e fragilidades de cálculo**

| # | Problema | Sev. | Esf. | Evidência |
|---|---|---|---|---|
| D1 | O "Investido" soma todo o gasto das contas, mas ROAS e custos dividem só pelos cadastros casados. O gasto das campanhas de live e de engajamento entra sem o resultado delas | P0 | M | `20261127200000_meta_mb4_overview_filter.sql:60-73, 278, 320-323` |
| D2 | O gasto de conta **desmarcada** continua no Investido (o CTE `m` não filtra `selected`; desmarcar não apaga as métricas) | P1 | P | `mb4:56-73`; `mb1:703-709` |
| D3 | O banner "sem anúncio correspondente" mistura tudo: live orgânica, Kwai, `pending`. Não filtra `provider` nem `utm_medium` | P1 | P | `mb4:262, 314`. No banco: 140 de 141 são `instagram/live` |
| D4 | `utm_source=instagram` (orgânico) é classificado como `provider=meta` | P1 | P | `webhook-process.server.ts:1541-1560` |
| D5 | Jogador sem linha em `player_attributions` (criado por depósito ou login) fica órfão para sempre; UTM na query de `landing_page` não é lida | P1 | P | `webhook-process.server.ts:802`; `mb4:102` |
| D6 | Coorte truncada: a receita só conta depósitos dentro do período, então em 7 dias o ROAS fica baixo por construção. Não há D7/D30 | P1 | M | `mb4:116-136` |
| D7 | Gasto fora de BRL sai do Investido, mas os jogadores daquelas contas continuam contando como "pagos", o que melhora o ROAS artificialmente | P1 | P | `mb4:76-77, 109` |
| D8 | "Atualizar agora" relê `days` a partir de hoje: com "Mês passado" lê a janela errada; e reaproveita uma execução de 3 dias que já esteja ativa | P2 | P | `midia-ltv.tsx:247`; `meta.functions.ts:1192-1202` |
| D9 | O primeiro toque não fica fixo: um 2º cadastro sobrescreve a atribuição (upsert) | P2 | P | `webhook-process.server.ts:1493` |
| D10 | Link rastreado da Betleads usado num anúncio vira `crm`, nunca mídia paga | P2 | P | `webhook-process.server.ts:1410`; `al1.sql:153` |
| D11 | Só `fbclid`, sem UTM → `missing_utm`, nunca atribuído à Meta | P2 | P | `webhook-process.server.ts:1525` |
| D12 | Fuso da conta ≠ Brasília sem aviso; o gasto de "hoje" é parcial sem selo | P2 | P | `meta-sync-rows.ts:62-88`; `mb4:44-45` |
| D13 | `player_attributions` aceita gravação de qualquer membro da casa | P2 | P | `20261015090000:884` |
| D14 | Reconciliação completa a cada sync com `lower()`/`OR`/`UNION` sem índice: risco de CPU (lembra o caso do callback de SMS) | P2 | M | `al1.sql:110-262` |
| D15 | Chave de criptografia sem rotação (prefixo fixo `v2.primary`) | P2 | P | `meta-token.server.ts` |

**O que está bom**
- Chave criptografada com AES-GCM, sem acesso pelo cliente.
- Checagem de saúde diária, com alerta de vencimento.
- Respeito ao limite de uso da Meta (pausa a 90%).
- Paginação completa.
- Erro de uma conta não derruba a chave.
- Claim com lock e reaper.
- Cron protegido por segredo.
- RLS por casa.

### 2.3 Gestor de tráfego Meta

**Os números permitem decidir? Ainda não.** O gasto está certo; o que falta é **ligar o gasto ao resultado**. Do jeito atual, a tela levaria a desligar a campanha de live, que é justamente a que paga.

**Lacunas para o uso diário**
- **Mapeamento de campanhas por origem.** Exemplo: "CAMPANHA LIVE*" → cadastros `utm_medium=live`. Também excluir campanhas de outra casa ou de branding, e tratar engajamento e aquecimento como "custo de apoio" à parte.
- **Status da conta** (ativa, desativada, banida, sem pagamento). Ele é lido (`meta.functions.ts:350`), mas não aparece na tela; contas de contingência mortas viram o aviso "sem gasto".
- **Drill-down** campanha › conjunto › anúncio com miniatura persistida. Hoje a miniatura vem só dos anúncios ativos, e a URL da Meta expira.
- **Métricas de mídia:**
  - CPM, CPC e cliques no link já são gravados, mas não aparecem;
  - alcance, frequência, visualizações da página de destino e hook rate de vídeo não são lidos.
- **Métricas de negócio:**
  - ROAS D0/D7/D30, payback e LTV por coorte de criativo;
  - comparação com o período anterior;
  - meta de custo por 1º depósito com alerta.
- **"Meta diz X cadastros, a casa confirmou Y".** As `actions` com janela de 7 dias após clique e 1 dia após visualização não são buscadas (AL1-07 do escopo).
- **IOF e impostos sobre o gasto** não existem; **conversão de USD pela PTAX** não existe (D6 do escopo). Por isso o Investido fica abaixo do custo real.

**Padrão de UTM que a tela deveria ensinar e validar**

Vai no campo *Parâmetros de URL*, no nível do anúncio:

```
utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}&utm_id={{ad.id}}
```

- **IDs, e não nomes.** Hoje o casamento funciona por nome ("ADS 01", "Criativo 107"), mas "ADS 01" se repete entre campanhas e contas de contingência. Basta um nome duplicado para virar `ambiguous`.
- **Para lives:** usar `utm_medium=live` e `utm_campaign=<id da campanha que impulsionou a live>`. Assim o mapeamento fica automático.
- **Validador ao vivo:** "dos últimos 50 cadastros, X% chegaram com ID de anúncio, Y% com macro literal `{{`, Z% só com source".

---

## 3. Plano priorizado

### P0: deixar os números confiáveis e devolver o controle

| # | Entrega | Esf. |
|---|---|---|
| 1 | **Atalho "Contas da Meta (N BMs · M contas)" sempre visível** na Aquisição, mais o item "+ Adicionar ou remover contas…" no filtro BM/conta | P |
| 2 | **Gerenciador com linguagem de BM.** Lista por BM, com contas marcadas/total, chave, validade e status. Ações em texto: Renomear, Trocar chave, Testar, Remover. Botão "+ Conectar outra BM", explicando a opção "mesma chave + Testar acesso". Em modo leitura, dizer quem é o admin | M |
| 3 | **Escopo de campanhas e grupos de mídia** (detalhado abaixo) | G |
| 4 | **Banner de órfãos separado por motivo,** cada um com sua ação: live/orgânico, outra fonte (Kwai, afiliado), anúncio de conta não conectada, só source/medium, nome ambíguo, macro literal. Link real para o Diagnóstico | P |
| 5 | **Corrigir o gasto de conta desmarcada** no Investido (D2) | P |
| 6 | **ROAS e custos com contexto:** % de cadastros ligados a gasto ao lado de cada KPI; com menos de ~50%, mostrar "—" e um aviso; frase "para cada R$ 1 investido voltaram R$ X" | P |

**Detalhe do item 3 (escopo e grupos de mídia)**
- **Catálogo:** `meta_campaigns` e `meta_adsets` (id, nome, objetivo, status, conta), preenchidos no sync.
- **Tabela `meta_attribution_scope`:** casa, nível (campanha, conjunto ou anúncio), objeto ou padrão de nome, modo (incluir, excluir ou *apoio*), `created_by`. Gravação só por RPC no servidor, com auditoria. Configuração por casa: "campanhas novas entram automaticamente?".
- **Grupo de mídia:** regra "campanhas cujo nome contém `LIVE`" ↔ "cadastros com `utm_medium=live`". O gasto do grupo vai para os cadastros daquela origem.
- **`marketing_overview`:** passa a respeitar o escopo. Jogador casado com algo excluído ganha o status `excluded`, em vez de virar órfão.
- **Interface:** árvore conta › campanha › conjunto › anúncio com busca e marcar/desmarcar (reaproveita `use-selection-draft.ts`). Na Aquisição, um chip "3 campanhas fora do cálculo · editar".

### P1: uso diário

7. Coorte madura: "receita até hoje" da coorte do período, ROAS D0/D7/D30 e o selo "coorte com X dias em média".
8. Nova hierarquia da tela:
   - uma faixa única de status;
   - um único controle de período;
   - avisos recolhíveis por gravidade;
   - "Números em validação" como selo com data;
   - estado vazio real quando não há conexão.
9. KPIs renomeados: "Depósito líquido de jogadores de anúncio · desde dd/mm"; "gasto de 14 contas lido de dd/mm a dd/mm" no lugar de "121 linhas".
10. Drill-down campanha › conjunto › anúncio com miniatura persistida e clique levando à lista de jogadores.
11. Colunas de mídia: CPM, CPC, cliques no link, custo por clique no link, alcance, frequência e visualizações da página de destino.
12. Status da conta com selo; contas mortas escondidas sem perder o histórico.
13. Guia de UTM com validador ao vivo; aviso de conta nova encontrada e desmarcada.
14. Correções D3, D4, D5, D7 e D8; "Atualizar" com a mesma regra nas duas telas.
15. Comparação com o período anterior e meta de custo por 1º depósito com alerta.

### P2: escala e acabamento

16. Conversions API com cadastro e 1º depósito (`fbc`/`fbp`, `event_id`, base LGPD; revisar antes a política de anúncios de apostas); "Meta diz X × casa confirmou Y".
17. Conversão de moeda pela PTAX, % de IOF e impostos por conta, aviso de fuso diferente de Brasília, selo "hoje parcial".
18. D9 a D15: primeiro toque fixo, `fbclid`, gravação em `player_attributions`, desempenho da reconciliação, rotação da chave.
19. Acessibilidade, textos (token → chave, ROI → ROAS, plurais), mobile com os KPIs primeiro.
20. Atualizar a ajuda (`help/screens/midia-ltv.ts:35`) e o tour; criar a fase de tutorial do gerenciador.

### Sequência sugerida

- **Sprint 1 (esforço P, efeito imediato):** itens 1, 4, 5 e 6, mais textos.
- **Sprint 2:** itens 2 e 3, o núcleo da queixa.
- **Sprint 3:** itens 7 a 13.
- **Depois:** P2.
