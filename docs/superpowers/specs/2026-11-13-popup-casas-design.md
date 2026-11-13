# Popups nas casas — design

Data: 2026-11-13
Status: proposto (aguardando aprovação)

## 1. Intenção

A casa quer mostrar avisos e promoções **dentro do próprio site** (bônus do dia, torneio, "complete seu
cadastro") e trocar esse conteúdo sozinha pelo CRM, sem pedir nada ao suporte da plataforma.

O site da casa já carrega o script do web push (`/api/public/push/loader.js?t=TOKEN`) em todas as
páginas, e quem gera esse script é o nosso servidor. O popup entra **por esse mesmo script**: a casa
não precisa alterar nada no site. O CRM passa a decidir qual popup aparece, para quem, em quais
páginas e com que frequência.

Sucesso: uma casa piloto cria dois popups no CRM (um para todos e outro só para quem nunca depositou,
só na home), vê os dois aparecerem no site em poucos minutos e acompanha as exibições e os cliques.

## 2. Objetivos e não-objetivos

**Objetivos**
- **Vários popups por casa**, cada um com prioridade, data de início e de fim e status (rascunho,
  ativo, pausado, encerrado).
- **Público escolhido pela casa:** todos os visitantes, só logados, só deslogados ou um filtro do CRM
  (o mesmo seletor de público das campanhas).
- **Páginas escolhidas pela casa:** todas as páginas, só as páginas listadas ou todas menos as
  listadas, com caminhos do tipo `/`, `/cassino/*` e `/promocoes`.
- **Conteúdo estruturado**: imagem, título, texto, botão (rótulo e link) e formato (janela central,
  faixa no rodapé ou cartão no canto). **Sem HTML livre.**
- **Gatilho e frequência:** aparece após N segundos e no máximo uma vez por sessão, uma vez por dia,
  uma vez a cada N dias ou até o visitante clicar.
- **Relatório por popup:** exibições, cliques, fechamentos e taxa de clique por dia.
- Prévia no editor (desktop e celular) idêntica ao que o site mostra.

**Não-objetivos (agora)**
- **Cobrança.** O popup fica liberado para todas as casas na v1. Toda checagem de "pode usar popup?"
  passa por uma única função (`popupsEnabledForTenant`), para que dê para plugar uma mensalidade
  depois sem mexer no resto.
- Teste A/B, gatilho de intenção de saída e formulário dentro do popup.
- Atribuição de depósito ao popup (fica para uma fase seguinte, usando o rastreador de clique).

**Anti-objetivos**
- A casa nunca injeta HTML ou JS no site pelo CRM. O popup roda no domínio da casa, junto com a
  sessão do jogador, e uma brecha ali seria um XSS em todas as casas.
- O popup nunca mostra dado pessoal do jogador (nome, saldo, CPF). O `playerId` vem de
  `window.betleads.playerId`, que qualquer visitante consegue forjar.

## 3. Como chega ao site

```
site da casa ──<script loader.js?t=TOKEN>──► nosso servidor (loader.js, cache 5 min)
     │
     └─ loader ── GET /api/public/popup?t=TOKEN&p=playerId ──► popups elegíveis (cache curto)
            │
            ├─ filtra por página atual + frequência (localStorage)
            ├─ escolhe o de maior prioridade e desenha em Shadow DOM
            └─ sendBeacon /api/public/popup/event  (exibição | clique | fechamento)
```

### 3.1 Loader
- `buildLoaderScript` ganha um módulo de popup **independente do push**. Hoje, sem app OneSignal
  ativo para a origem, o loader para em `if (!appId) return;`, e o servidor devolve
  `INACTIVE_SCRIPT` quando não há apps. As duas partes passam a ser decididas separadamente: push
  só se houver app, e popup só se `popupsEnabledForTenant` for verdadeiro e houver popup ativo.
- O loader continua estável. O conteúdo dos popups vem do endpoint próprio, e por isso trocar um
  popup no CRM não depende do cache de 5 minutos do loader.
- **Convivência com o convite do push:** se o convite da OneSignal for aparecer nessa visita
  (permissão ainda não respondida e push ativo), o popup espera o convite ser respondido ou fechado.
  Os dois nunca aparecem juntos.
- **Site SPA:** o loader observa `pushState`, `replaceState` e `popstate` e reavalia as regras de
  página a cada troca de rota.
- **Isolamento:** o popup é desenhado num Shadow DOM, com z-index alto, foco preso enquanto está
  aberto, ESC e botão "×" para fechar, e respeita `prefers-reduced-motion`. O CSS da casa não vaza
  para dentro do popup, e o do popup não vaza para fora.
- Todos os textos chegam como dado (`textContent`), nunca como `innerHTML`. Imagem e link só aceitam
  `https:`.

### 3.2 Endpoint `GET /api/public/popup`
- Recebe o token da casa e, opcionalmente, o `playerId`. Devolve os popups ativos e dentro do
  período que valem para esse visitante. O filtro de público é feito no servidor; o de página e o
  de frequência, no navegador.
- **Carga:** cada visualização de página de cada casa chama esse endpoint. Por isso o servidor
  guarda em memória, por 60 s, a lista de popups ativos de cada casa. A consulta de público por
  jogador só acontece se houver popup com filtro do CRM, e é uma única busca indexada (3.3). O
  navegador guarda a resposta no `sessionStorage` por 5 minutos.
- Resposta com `Cache-Control: private, max-age=60`. Token desconhecido ou casa sem popup devolve
  `[]` com 200, sem revelar quais tokens existem (mesma regra do loader).
- Mesmo limitador por IP do `subscribe`.

### 3.3 Público "filtro do CRM"
Resolver o filtro a cada visualização de página é caro demais (é a mesma RPC das campanhas). A
resolução é feita **antes**: ao ativar o popup e depois a cada hora por cron, o filtro é resolvido
(`resolveAudienceForTenant` com `includePlayerIds`) e gravado em `site_popup_audience_members`. O
endpoint só verifica se `(popup_id, player_id)` existe nessa tabela.

- Consequência visível para a casa: quem entra no filtro passa a ver o popup em até 1 hora. A tela
  diz isso.
- "Logados" e "deslogados" dependem só de existir ou não um `playerId` na página. Se a casa nunca
  mandou `playerId` (nenhum registro com jogador nos últimos 7 dias), o editor avisa que "logados"
  e o filtro do CRM não vão alcançar ninguém.

### 3.4 Eventos e relatório
- `POST /api/public/popup/event` (via `sendBeacon`) recebe `{ popupId, kind }` e incrementa contadores
  em `site_popup_daily_stats` (popup, dia, exibições, cliques, fechamentos). Não grava uma linha por
  evento, para não repetir o crescimento de banco visto na auditoria de 11-04.
- O clique dispara o beacon e navega direto para o link do botão. Não passa por redirect nosso, o
  que evita abrir um open redirect.
- Exibição conta só quando o popup de fato aparece na tela.

## 4. Dados (migração nova)

- `site_popups`: `id`, `tenant_id`, `nome`, `status` (`rascunho|ativo|pausado|encerrado`),
  `prioridade` int, `starts_at`, `ends_at` (opcional), `formato` (`central|rodape|canto`),
  `image_url`, `titulo`, `texto`, `botao_label`, `botao_url`, `audience_kind`
  (`todos|logados|deslogados|filtro`), `audience_criteria` jsonb, `paginas_modo`
  (`todas|incluir|excluir`), `paginas` text[], `atraso_segundos`, `frequencia`
  (`sessao|dia|n_dias|ate_clicar`), `frequencia_dias`, `audience_refreshed_at`, `created_by`,
  timestamps. Limites de tamanho nos textos e `CHECK` de `https://` em `image_url` e `botao_url`.
- `site_popup_audience_members (popup_id, player_id)`, com PK nesses dois campos.
- `site_popup_daily_stats (popup_id, tenant_id, dia, exibicoes, cliques, fechamentos)`, com PK
  `(popup_id, dia)`, mais uma RPC de incremento com `security definer` restrita ao service role.
- RLS no padrão das demais tabelas da casa: admin e gestor da casa leem e escrevem, super admin vê
  todas, expert não tem acesso.
- Cron horário para recalcular o público dos popups ativos com filtro e marcar como `encerrado` os
  que passaram de `ends_at`.
- Imagens num bucket público `popup-images`, com pasta por casa (mesmo esquema de
  `uploadEmailImage`).

## 5. Tela no CRM

- Item **Popups** no menu de campanhas. A lista mostra nome, status, período, público, prioridade e
  exibições, cliques e taxa dos últimos 7 dias, com ações de ativar, pausar, duplicar e encerrar.
- **Editor** em seções: Conteúdo → Público → Páginas → Quando e quantas vezes → Período e prioridade,
  com prévia ao lado (alternando desktop e celular).
- **Faixa de instalação** no topo: "O script está no site?", usando o `script_seen_at` que já
  existe. Se não estiver, mostra o mesmo snippet do assistente de web push.
- Textos em português simples: cada número diz o que conta e desde quando.
- Tutorial do CRM: telas de ajuda e tour para Popups.

## 6. Fases

1. **Cadastro:** migração, CRUD, editor com prévia e upload de imagem. Nada aparece ainda no site.
2. **Entrega:** módulo no loader, endpoint, renderização em Shadow DOM, eventos e contadores. Vale só
   para os públicos todos, logados e deslogados. Piloto numa casa com o loader instalado.
3. **Filtro do CRM:** tabela de membros, cron e aviso de `playerId` ausente.
4. **Relatório e tutorial:** gráfico por dia, telas de ajuda e tour.

## 7. Riscos

- **Volume de requisições** no endpoint público: mitigado pelo cache de 60 s no servidor, de 5 min
  na sessão do navegador e pelo limitador por IP.
- **Site da casa com CSP restritiva:** o loader já roda nesses sites, mas o `fetch` para o novo
  endpoint e as imagens do bucket podem ser bloqueados. A faixa de instalação aponta quando o
  script aparece no site mas nunca registra exibição.
- **Popup abusivo** (aparecendo o tempo todo) prejudica a casa. A frequência mínima permitida é
  "uma vez por sessão".

## 8. Notas de implementação (2026-11-13, branch feat/popup-casas)

Aprovado pelo usuário em 11-13; piloto **LaEleBet**.

- Migrações: `20261230100000_site_popups.sql` (tabelas, RPCs, coluna
  `tenant_webpush_settings.popup_player_seen_at`) e `20261230100100_site_popups_cron.sql` (cron
  `betleads-popups-hourly`, minuto 13 — aplicar **depois** do deploy).
- Endpoints: `GET /api/public/popup/list?t=&p=` e `POST /api/public/popup/event?t=` (corpo
  text/plain via sendBeacon); cron em `POST /api/public/hooks/popups-hourly`.
- Origens aceitas = origens de `tenant_webpush_apps` da casa com status diferente de `desativado`.
- O loader só embute o runtime do popup quando a casa tem popup ativo (zero requisição extra para
  quem não usa). Por isso, o **primeiro** popup ativo leva até 5 min (cache do loader) para aparecer;
  depois disso, trocas de conteúdo levam até ~1 min (cache do servidor) + 5 min (cache da sessão do
  navegador).
- Imagens reaproveitam o bucket público `email-images` (pasta por casa, `uploadEmailImage`) em vez
  de um bucket novo.
- Público filtro: o editor usa os públicos de sistema + os salvos em Públicos; guarda o critério e o
  nome. Ao salvar/ativar, o público é resolvido na hora; depois, de hora em hora.
- Relatório: tabela por dia (30 dias) no diálogo "Números por dia"; gráfico ficou para depois.
- Ajuda: `src/help/screens/popups.ts` (painel "?" e tour).
