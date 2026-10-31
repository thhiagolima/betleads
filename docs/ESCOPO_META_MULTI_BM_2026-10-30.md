# Escopo — Conexão Meta Ads com várias BMs — 2026-10-30

## 1. Objetivo

Uma casa conecta uma ou mais Business Managers (BMs) da Meta, escolhe as contas de anúncio, e o gasto
de todas elas chega ao Aquisição e LTV em até 1 hora. Daí em diante a sincronização se mantém sozinha:
se recupera de erros, avisa quando um token expira e nunca mistura contas de BMs diferentes nem de
casas diferentes.

Este escopo cobre a aba **Integrações → Meta Ads** (`/webhooks#meta`), o pipeline de sincronização e
os testes. O painel de relatórios (hierarquia, LTV por coorte, drill-down) continua no
[ESCOPO_AQUISICAO_LTV_2026-10-18.md](ESCOPO_AQUISICAO_LTV_2026-10-18.md) (AL3-05 em diante e AL4). Os itens
da AL2 e da AL3 daquele escopo que tratam da conexão e da sincronização passam a ser fechados aqui; o
mapa está na seção 10.

## 2. Estado atual (30/10/2026)

### Produção (leitura somente leitura)

| Fato | Valor |
|---|---|
| Casas conectadas no modelo de token (Usuário do Sistema) | **0** |
| `meta_sync_runs` / `meta_sync_jobs` já criados | **0 / 0**: o pipeline nunca rodou em produção |
| Conexões legadas | 1 (`betleads-original`, `legacy_oauth`, `error`), **token em texto puro** em `access_token` |
| Contas da conexão legada | 5 contas de 4 BMs, BRL e USD, nenhuma selecionada |
| Cron `betleads-meta-sync-worker` | ativo, `*/5 * * * *` |
| `authenticated` em `meta_connections` | sem SELECT/INSERT/UPDATE: os tokens não vazam pelo PostgREST |
| `authenticated` em `meta_ad_accounts` e `marketing_integrations` | **INSERT e UPDATE** liberados (política `FOR ALL` da casa) |

Consequência: nenhuma mudança de modelo exige migração de dados de clientes. Este é o momento mais
barato para corrigir o modelo.

### O que já funciona (código)

- Um token é agrupado por BM e cria uma linha em `meta_connections` por BM
  (`src/lib/meta.functions.ts:233-380`). Um segundo token de outra BM ou de outro app soma, sem apagar
  as conexões existentes.
- "Testar acesso" e "Desconectar" agem por conexão, e o erro de uma conexão não afeta as outras.
- A fila trabalha por conta de anúncio, com retry exponencial, e cada conta usa o token da sua conexão.
- Moeda por linha: o gasto fora de BRL aparece separado e fica fora do ROAS (AL1-03).
- Janela de insights no fuso da conta, com substituição transacional (`replace_meta_ad_metrics`).

## 3. Achados

Severidade: **A** quebra ou risco de segurança; **M** comportamento errado num caso realista; **B**
acabamento.

### 3.1 Back-end e modelo (dev sênior)

| ID | Sev. | Achado | Evidência |
|---|---|---|---|
| MB-01 | A | **Run preso para sempre.** Um job `running` com lock vencido na última tentativa não é mais reclamado (`attempt_count < max_attempts`) nem marcado `failed`. O run fica `running`, o índice `meta_sync_runs_one_active_tenant` impede um run novo e `createMetaSyncRun` devolve sempre o run preso: **a casa nunca mais sincroniza** | `claim_meta_sync_jobs` em `20261002143000_meta_sync_queue.sql`; `meta.functions.ts:703-711` |
| MB-02 | A | **Qualquer usuário da casa conecta, troca e desconecta a Meta.** As server functions só exigem login (`requireSupabaseAuth`), sem `requireTenantAdmin`, ao contrário da Short.io | `meta.functions.ts:211,397,458,533,769` |
| MB-03 | A | **Escrita direta pelo PostgREST.** Qualquer membro da casa pode dar UPDATE em `meta_ad_accounts` (`selected`, `connection_id`) e escrever em `marketing_integrations`. O worker não confere se a conexão é da mesma casa da conta | consulta de privilégios; `meta.functions.ts:902-911` |
| MB-04 | A | **Token legado em texto puro** ainda no banco, e o fallback `connection.access_token` continua no código | consulta `conns`; `meta.functions.ts:474-476,616-618` |
| MB-05 | A | **Um erro permanente numa conta derruba todas as contas da conexão.** `isPermanentMetaError` (regex sobre o texto) marca a conexão inteira como `error`; `createMetaSyncRun` e o claim exigem `status = 'connected'`. Nada volta a `connected` sozinho: só quem clicar em "Testar acesso" | `meta.functions.ts:798-800,961-967,718` |
| MB-06 | A | **Selecionar uma conta não dispara sincronização.** A conta fica "aguardando" até o próximo agendado (até 23 h) ou um "Atualizar agora" na outra tela. O agendado busca só 7 dias: os 90 dias anteriores nunca chegam | `meta.functions.ts:421-428,866` |
| MB-07 | M | **Uma conta compartilhada entre duas conexões tem dono único.** `UNIQUE (tenant_id, meta_ad_account_id)`: o upsert passa a conta para a última conexão feita. Se essa conexão for desconectada, a conta sai da seleção mesmo que a outra ainda tenha acesso | `create_meta_oauth_tables.sql:47`; `meta.functions.ts:324-340,550-554` |
| MB-08 | M | **"BM" na verdade é a BM dona da conta.** O agrupamento usa `account.business.id`. Num token com contas compartilhadas por parceiros, viram vários cartões com o nome de BMs de terceiros, todos com o mesmo token cifrado | `meta.functions.ts:233-241` |
| MB-09 | M | **Trocar o Usuário do Sistema da mesma BM duplica a conexão.** A busca inclui `meta_user_id`: nasce uma conexão nova, as contas migram para ela e a antiga fica `connected`, sem contas e com o token velho | `meta.functions.ts:242-254` |
| MB-10 | M | **Conectar não é atômico.** Num token com 3 BMs, uma falha na segunda deixa a primeira gravada e a terceira não. A seleção também não é atômica: limpa tudo e depois marca, em dois comandos | `meta.functions.ts:240-380,415-428` |
| MB-11 | M | **Vazão: 2 contas a cada 5 minutos, para todas as casas** (cerca de 24 contas por hora). Não há divisão justa entre casas: uma casa com 40 contas segura todas as outras por quase 2 horas | `tick.ts:16`; cron |
| MB-12 | M | **Erros da Meta tratados por texto.** Não há leitura de `code`/`subcode`, dos headers de uso (`x-business-use-case-usage`, `x-app-usage`) nem de `estimated_time_to_regain_access`. Rate limit (4, 17, 613, 80004) consome as 3 tentativas e falha | `meta.functions.ts:79-103,798` |
| MB-13 | M | **Token na URL e paginação sem timeout.** O `access_token` vai na query string, e as páginas seguintes de insights e de anúncios usam `fetch(next)` sem `AbortController` | `meta.functions.ts:113-138,152-166` |
| MB-14 | M | **Validade do token desconhecida.** `token_expires_at` e `data_access_expires_at` nunca são preenchidos (não há `debug_token`), e um token de usuário comum (60 dias) é aceito como se fosse de Usuário do Sistema | `meta.functions.ts:211-230` |
| MB-15 | M | **"Testar acesso" com timeout desliga a conexão**: qualquer exceção grava `status: 'error'` | `meta.functions.ts:518-529` |
| MB-16 | M | **Demo e casa suspensa.** `enqueueMetaSync` não tem `assertTenantNotDemo`, e o worker não confere se a casa está suspensa ou bloqueada por cobrança | `meta.functions.ts:769-780,843-873` |
| MB-17 | B | `marketing_integrations` grava `selected_accounts: 0` em toda conexão e nunca atualiza; uma linha por BM com `external_account_id` | `meta.functions.ts:363-379` |
| MB-18 | B | Um "Atualizar agora" de 1 dia faz o agendado de 7 dias pular aquele dia (o critério é "algum run nas últimas 23 h") | `meta.functions.ts:854-864` |
| MB-19 | B | Contas novas atribuídas ao Usuário do Sistema só aparecem ao colar o token de novo: não há redescoberta no agendado | — |
| MB-20 | B | Nenhum teste cobre `meta.functions.ts` (conectar, selecionar, desconectar, worker). Hoje só há `meta-api-version.test.ts` e `meta-sync-rows.test.ts` | `src/lib/` |

### 3.2 Experiência (designer UX)

| ID | Sev. | Achado | Onde |
|---|---|---|---|
| UX-01 | A | **Não existe "Adicionar BM".** O único caminho é "Atualizar chave de acesso" → "Atualizar credencial", que sugere substituir a chave atual. Quem tem uma segunda BM não descobre que pode somar | `meta-connection.tsx:420-431,357-360` |
| UX-02 | A | **A lista de contas é plana**: sem BM, busca, "selecionar todas" por BM, moeda destacada, fuso, última leitura ou próxima sincronização. Com 3 BMs e 30 contas, ninguém sabe o que está marcando | `meta-connection.tsx:518-569` |
| UX-03 | M | **A seleção não salva se perde.** O `useEffect` reescreve `selectedIds` sempre que `accounts` muda; durante uma sincronização, o polling de 30 s muda o `sync_status` e descarta as marcações não salvas. Também não há aviso de alterações pendentes | `meta-connection.tsx:270-272`; `meta-summary.ts:59` |
| UX-04 | M | **O passo 3 ("Validar acesso") nunca fica concluído** e não corresponde a uma ação do usuário: o indicador de progresso mente | `meta-connection.tsx:278,298-324` |
| UX-05 | M | **Erro de conta escondido** num `title` (tooltip só de mouse): no celular e no teclado o motivo não aparece | `meta-connection.tsx:551-567` |
| UX-06 | M | **Desconectar não diz o que se perde**: nem qual BM, nem quantas contas param de sincronizar, nem o que acontece com uma conta compartilhada | `meta-connection.tsx:580-614` |
| UX-07 | M | **Abrir o formulário de token esconde as conexões.** Não dá para consultar qual BM já está conectada enquanto se cola a chave | `meta-connection.tsx:355,418` |
| UX-08 | M | **Membros sem permissão veem todos os botões** e só descobrem a restrição pelo erro (depois do MB-02) | — |
| UX-09 | M | **Conta em USD sem aviso na seleção.** O gasto dela fica fora do ROAS, mas isso só aparece depois, no painel | — |
| UX-10 | B | O guia de preparação tem 4 frases, sem links do Business Manager e sem o caso "várias BMs / contas de parceiro" | `meta-connection.tsx:338-353` |
| UX-11 | B | O toast "N conta(s) encontrada(s)" conta todas, inclusive as que já existiam; não diz quantas BMs nem quantas contas são novas | `meta-connection.tsx:83-86` |
| UX-12 | B | O status do cabeçalho mistura casos: uma conexão em erro pinta "erro" mesmo com outras 3 BMs saudáveis | `meta-connection.tsx:279-283` |

### 3.3 Qualidade (QA)

- Não há teste de contrato com fixtures da Graph API, de integração da fila (PGlite) nem E2E da aba.
- Não há ambiente Meta de teste com mais de uma BM, conta compartilhada por parceiro e conta em USD.
  Sem ele, os blocos A, C e G da seção 7 não podem ser aceitos com dados reais.
- O caminho feliz nunca rodou em produção (0 runs). O primeiro uso real será o aceite.

## 4. Decisões

| ID | Pergunta | Recomendação |
|---|---|---|
| D1 | **O que é uma "conexão"?** Uma por BM dona (hoje) ou uma por token (Usuário do Sistema + app)? | **Uma por token.** A BM vira atributo da conta e serve para agrupar na tela. Resolve MB-08 e MB-09, e o token deixa de ser copiado em N linhas. Sem clientes conectados, a migração é trivial |
| D2 | **Conta acessível por dois tokens:** qual token sincroniza? | Tabela de acesso N:N. Sincroniza pelo token saudável validado mais recentemente; se ele falhar, tenta o outro na hora. A conta só sai da seleção quando nenhum token a alcança mais |
| D3 | **Quem mexe na conexão?** | Admin da casa e super admin (`requireTenantAdmin`, como na Short.io). Os demais papéis veem tudo em modo leitura. Se o papel "gestor" do D8 da AL existir até lá, entra junto |
| D4 | **Backfill ao selecionar** | 90 dias, em blocos de 30 dias, com prioridade sobre o agendado |
| D5 | **Política do agendado** | A cada hora, 3 dias, para todas as contas selecionadas. Uma vez por dia (madrugada BRT), 28 dias, com redescoberta de contas |
| D6 | **SLA de vazão** | 150 contas (todas as casas) drenadas em 1 hora; nenhuma casa espera mais de 15 min pelo primeiro job |
| D7 | **Filtro por BM no Aquisição e LTV** | Sim, um filtro "BM / conta" no painel (MB4-04). Casas com várias BMs costumam ser operadas por agências diferentes |
| D8 | **Conta em USD** | Manter a regra da AL1-03 (gasto separado, fora do ROAS) e avisar na seleção. Câmbio fica fora |
| D9 | **Ambiente de teste** | A Betleads cria uma BM de teste com 2 Usuários do Sistema, uma conta compartilhada por parceiro com uma segunda BM e uma conta em USD. Pré-requisito do aceite |

## 5. Modelo alvo

```
meta_connections            1 linha por token (app_id + meta_user_id), status connected|error|disabled
  └─ meta_ad_account_access N:N  (connection_id, account_id, last_seen_at, last_error, revoked_at)
meta_ad_accounts            1 linha por (tenant, conta) — business_id/name da BM dona, selected, sync_*
meta_sync_jobs              + preferred_connection_id, kind ('backfill'|'recent'|'weekly'|'manual'), window since/until
```

- Índice único de `meta_connections`: `(tenant_id, app_id, meta_user_id) where status <> 'disabled'`.
  `business_id` deixa de fazer parte da identidade (a BM do Usuário do Sistema, quando conhecida,
  fica em `owner_business_id` só para exibição).
- `meta_ad_accounts.connection_id` vira derivado (o token preferido), ou é removido em favor do
  `meta_ad_account_access`.
- A saúde fica em três níveis: **token** (expirado, revogado, sem `ads_read`) na conexão; **acesso**
  (perdeu a conta) na linha N:N; **leitura** (rate limit, timeout, sem dados) na conta.
- `meta_ad_accounts` e `marketing_integrations`: só SELECT para `authenticated`; escrita via server
  function com `service_role`.

## 6. Fases

Esforço: **P** até 1 dia, **M** 2 a 3 dias, **G** 4 a 5 dias (uma pessoa).

### MB0 — Segurança e destravamento (2 a 3 dias, antes de qualquer casa conectar)

| ID | Item | Fecha | Critério de aceite | Esf. |
|---|---|---|---|---|
| MB0-01 | `requireTenantAdmin` em conectar, selecionar, testar, desconectar e "Atualizar agora"; `assertTenantNotDemo` em `enqueueMetaSync` | MB-02, MB-16 | Teste H: matriz papel × ação; membro recebe erro claro | P |
| MB0-02 | Migration: revogar INSERT/UPDATE/DELETE de `authenticated` em `meta_ad_accounts` e `marketing_integrations` (só SELECT); o worker exige `account.tenant_id = connection.tenant_id` | MB-03 | Teste G via PostgREST: membro não altera `selected` nem `connection_id` | P |
| MB0-03 | Zerar `access_token` das conexões `legacy_oauth` e remover o fallback de texto puro do código | MB-04 | Consulta antes e depois anexada; grep de `connection.access_token` = 0 | P |
| MB0-04 | **Reaper**: no claim, um job `running` com lock vencido na última tentativa vira `failed`; o run é fechado por `refreshMetaSyncRun`. Lock renovado a cada conta processada | MB-01 | Teste E: lock vencido na tentativa 3 → job `failed`, run fechado, um run novo da casa roda | M |
| MB0-05 | Worker ignora casas suspensas ou bloqueadas por cobrança (`assertTenantCanOperate`) | MB-16 | Teste E: casa suspensa não tem job reclamado | P |

### MB1 — Modelo multi-BM correto (cerca de 1 semana)

| ID | Item | Fecha | Critério de aceite | Esf. |
|---|---|---|---|---|
| MB1-01 | Migration do modelo da seção 5 (D1, D2): conexão por token, `meta_ad_account_access`, índices novos. A conexão legada é preservada como `disabled` | MB-07, MB-08, MB-09 | Teste I: um token com contas de 3 BMs = 1 conexão + 3 grupos; dois tokens com a mesma conta = 1 conta + 2 acessos | M |
| MB1-02 | **Conectar via RPC transacional** (`meta_connect_token`): o servidor chama a Meta, e a gravação de conexão, contas, acessos, auditoria e `marketing_integrations` é uma transação só. Reconectar o mesmo token só atualiza; um token novo do mesmo Usuário do Sistema substitui a chave sem duplicar | MB-09, MB-10, MB-17 | Teste: falha simulada no meio não grava nada; reconectar não duplica | M |
| MB1-03 | **Seleção via RPC transacional** com diff (marcadas e desmarcadas). Contas recém-marcadas geram jobs de backfill de 90 dias em blocos de 30 (D4), fora da regra "um run ativo por casa" | MB-06, MB-10 | Teste: marcar uma conta cria 3 jobs de backfill; o painel mostra dados em < 1 h (SLA D6) | M |
| MB1-04 | **Desconectar** remove o token e os acessos dessa conexão. A conta só sai da seleção se nenhum outro acesso ativo restar; caso contrário passa para o outro token | MB-07 | Teste G: conta com dois tokens continua sincronizando após desconectar um | P |
| MB1-05 | **Escolha do token no worker**: `preferred_connection_id` → outro acesso saudável → falha. Erro de acesso numa conta marca só a linha N:N daquela conta | MB-05 | Teste B: permissão perdida em 1 conta não para as outras contas do token | M |
| MB1-06 | **Redescoberta**: o agendado diário relê `/me/adaccounts` de cada token, cria contas novas (não selecionadas) e marca acessos revogados | MB-19 | Teste: conta nova atribuída aparece na tela no dia seguinte, com selo "nova" | P |

### MB2 — Sincronização robusta (cerca de 1 semana; pode correr em paralelo com a MB1)

| ID | Item | Fecha | Critério de aceite | Esf. |
|---|---|---|---|---|
| MB2-01 | `MetaApiError` com `code`, `subcode`, `type` e `fbtrace_id`. Tabela de retentáveis (1, 2, 4, 17, 32, 613, 80000–80014) e permanentes (190, 200, 10, 2635). Backoff com jitter que respeita `estimated_time_to_regain_access`; rate limit não consome tentativa. A regex sai | MB-12, MB-05 | Teste C com uma fixture por código | M |
| MB2-02 | Token no header `Authorization: Bearer`; timeout em toda chamada, inclusive na paginação; um único `fetchMetaPage` para insights, anúncios e contas | MB-13 | Grep nos logs de teste não acha o token; teste de timeout na página 2 | P |
| MB2-03 | `debug_token` ao conectar, ao testar e diariamente: preenche `token_expires_at` e `data_access_expires_at`, recusa token de usuário comum (`type != SYSTEM_USER`) e confere o `app_id` | MB-14 | Teste A: token de usuário recusado com mensagem clara; expiração na tela | P |
| MB2-04 | "Testar acesso" só rebaixa para `error` em erro permanente; timeout e rate limit mostram aviso sem mudar o status. Uma conexão em `error` volta a `connected` sozinha quando o diário consegue validar | MB-15, MB-05 | Teste B: timeout no teste não para o sync | P |
| MB2-05 | **Vazão e justiça**: cron a cada minuto; claim de até 10 jobs com no máximo 2 por casa e 3 por app; processamento com concorrência 3 e orçamento de 50 s por tick (o que sobrar volta para a fila) | MB-11 | Teste E8: 150 contas de 5 casas drenadas em < 1 h; nenhuma casa espera > 15 min pelo primeiro job | M |
| MB2-06 | **Política de agendamento D5** (3 dias por hora, 28 dias por dia); o manual não substitui o agendado | MB-06, MB-18 | Teste F: ajuste em D-2 e D-20 refletido | P |
| MB2-07 | Insights assíncronos (`async=true` + polling) para janelas acima de 30 dias ou contas com mais de 500 anúncios | — (AL2-04) | Teste D: 90 dias × 500 anúncios sem timeout | M |

### MB3 — Experiência (cerca de 1 semana; começa com a MB1-01 mergeada)

Estrutura nova da aba Meta Ads:

```
┌ Meta Ads ──────────────────────────────── [● 3 BMs · 12 contas · atualizado há 8 min] ┐
│ [Adicionar Usuário do Sistema]   [Sincronizar agora]                                   │
│                                                                                        │
│ ▸ Chave "Mídia Interna" (app Betleads Ads · …a3f9)  ● ok · expira nunca   [Testar] [⋯] │
│ ▸ Chave "Agência X"     (app AgX · …77c1)           ▲ 1 conta sem acesso   [Testar] [⋯] │
│                                                                                        │
│ Contas de anúncio                       [buscar…]  [mostrar: todas ▾]                   │
│ ▾ BM Sorte Alta (4 de 6 marcadas)                       [marcar todas]                 │
│   ☑ SA - Captação 01   act_123  BRL  America/Sao_Paulo  ● dados até ontem 23h          │
│   ☑ SA - Retarget      act_456  USD ⚠ fora do ROAS      ● sincronizando 2/3            │
│   ☐ SA - Antiga        act_789  BRL  …                  ○ sem leitura                  │
│ ▾ BM Agência X (parceira) (2 de 2)                                                     │
│   ☑ AX - Casa          act_999  BRL  …  via 2 chaves    ▲ sem acesso pela chave AgX    │
│                                                                                        │
│                                 2 alterações não salvas   [Descartar] [Salvar contas]  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

| ID | Item | Fecha | Critério de aceite | Esf. |
|---|---|---|---|---|
| MB3-01 | **Conexões como lista de chaves**, com nome editável, app, final da chave, Usuário do Sistema, BMs alcançadas, contas, validade e status. Botão primário **"Adicionar Usuário do Sistema"** abre o formulário num painel lateral (as conexões continuam visíveis). "Trocar chave" fica no menu `⋯` da conexão, com o texto "substitui a chave desta conexão" | UX-01, UX-07 | Roteiro de usabilidade: conectar a segunda BM sem ajuda | M |
| MB3-02 | **Contas agrupadas por BM**, com marcar e desmarcar por grupo, busca, filtro (marcadas, com erro, novas), moeda com aviso de USD fora do ROAS, fuso, "dados até", "via N chaves" e o erro em texto visível (não em tooltip) | UX-02, UX-05, UX-09 | Teste de componente: 3 BMs, busca e marcar grupo | M |
| MB3-03 | **Rascunho da seleção** que não é sobrescrito pelo polling; barra fixa "N alterações não salvas · Descartar · Salvar"; aviso ao sair da aba com alterações | UX-03 | Teste: polling durante a edição não perde marcações | P |
| MB3-04 | **Progresso real** no lugar dos 3 passos: Conectar → Escolher contas → Primeira leitura (com % do backfill) → Pronto, que leva ao Aquisição e LTV | UX-04 | Os 4 estados cobertos por teste de componente | P |
| MB3-05 | **Desconectar com impacto**: "Esta chave alcança 6 contas em 2 BMs. 4 vão parar de sincronizar; 2 continuam pela chave 'Mídia Interna'. Os dados já importados ficam." Exige digitar o nome da conexão quando houver contas marcadas | UX-06 | Teste: o texto reflete o caso compartilhado | P |
| MB3-06 | **Modo leitura** para quem não é admin: ações escondidas e a faixa "Só o administrador da casa altera a conexão" | UX-08 | Teste H na UI | P |
| MB3-07 | **Status do cabeçalho por agregado** ("3 BMs · 1 com atenção") e banner por conexão para token expirando em 7 dias, revogado ou sem `ads_read`, com "Trocar chave" | UX-12 | Token revogado no teste aparece em linguagem clara | P |
| MB3-08 | **Guia de preparação** com links diretos (Configurações do negócio → Usuários do sistema; Atribuir ativos; Gerar token com `ads_read`), o caso "várias BMs = um Usuário do Sistema por BM, ou contas de parceiro atribuídas a um só" e o aviso de que um token de usuário comum expira | UX-10 | Revisão com uma pessoa da casa piloto | P |
| MB3-09 | **Resultado da conexão**: "Chave 'Agência X' conectada: 2 BMs, 5 contas (3 novas)". As novas aparecem destacadas | UX-11 | Teste de componente | P |
| MB3-10 | Acessibilidade: grupos com `role="group"` e `aria-label`, checkbox de grupo com estado `mixed`, status com texto (não só cor), foco no painel lateral; 375 px sem rolagem horizontal | — | axe sem erros críticos | P |

### MB4 — Observabilidade e uso dos dados (3 a 4 dias)

| ID | Item | Fecha | Critério de aceite | Esf. |
|---|---|---|---|---|
| MB4-01 | Histórico de execuções na aba: últimos 10 runs com contas, linhas, erros e duração | — | Visível sem acesso ao banco | P |
| MB4-02 | Alertas no canal de operação: run parado > 2 h, conta em erro > 24 h, token expirando em 7 dias, casa sem sincronização há > 26 h | — (AL2-13) | Alerta disparado em homologação | M |
| MB4-03 | Super admin: visão de todas as casas com conexões, contas, último sucesso e erros (Admin → Integrações) | — | Lista as casas conectadas em 1 tela | P |
| MB4-04 | Filtro "BM / conta" no Aquisição e LTV (`marketing_overview` com `_ad_account_ids`) (D7) | — | Os números filtrados somam o total | M |

## 7. Plano de testes

**U** unitário vitest; **C** contrato com fixtures da Graph API (`src/lib/__fixtures__/meta/*.json`,
`fetch` mockado); **I** integração PGlite (padrão `crm-results.db.test.ts`); **E2E** Playwright no
demo com a Meta mockada; **R** manual com a BM de teste real (D9).

| Bloco | Casos | Tipo |
|---|---|---|
| A. Conectar | 1 BM; 3 BMs num token; contas de parceiro; dois tokens da mesma BM; mesmo token duas vezes; sem `ads_read`; token de usuário comum; token de outro app; 0 contas; falha no meio (nada gravado) | C+I+R |
| B. Token e acesso | Erro 190 → conexão `error`, sem retry; permissão perdida em 1 conta → só ela; timeout no "Testar" → status mantido; recuperação automática no diário | C+I |
| C. Contas | BRL + USD; fusos diferentes; conta desativada; conta sem gasto; homônimos em BMs diferentes → `ambiguous` | C+I+R |
| D. Volume | 3 páginas; timeout na página 2; códigos 4, 17, 613, 80004; 90 dias × 500 anúncios (assíncrono) | C+I |
| E. Fila | Claim concorrente; reaper nas tentativas 1 e 3; justiça entre casas; orçamento de 50 s; casa suspensa; demo; tick sem secret; 150 contas em < 1 h | I |
| F. Janela | Backfill em 3 blocos; ajuste em D-2 (hora) e D-20 (dia); manual × agendado | I |
| G. Isolamento | Duas casas com a mesma conta; conta com dois tokens e desconexão de um; `connectionId` de outra casa; PostgREST de membro em `meta_ad_accounts` | I |
| H. Papéis | Admin, membro e super admin × conectar, selecionar, testar, desconectar, sincronizar; UI do membro | I+E2E |
| UX | Rascunho durante o polling; grupo `mixed`; desconectar com impacto; 375 px; axe | E2E |

Aceite real (R) com a BM de teste: conectar 2 tokens, marcar contas das 3 BMs, ver o gasto no painel em
< 1 h, revogar o acesso a 1 conta na Meta e ver só ela em erro, desconectar um token e ver a conta
compartilhada continuar. **Conferência do gasto contra o Gerenciador ≤ 1% em 3 períodos.**

## 8. Sequência, esforço e riscos

```
MB0 (2-3 d) ──┬─> MB1 (≈1 sem) ──┬─> MB3 (≈1 sem) ──┐
              └─> MB2 (≈1 sem) ──┴─> MB4 (3-4 d) ───┴─> aceite real (1-2 d) → casa piloto
D1–D9 respondidas antes do MB1. BM de teste (D9) pronta antes do aceite.
```

- **Uma pessoa:** cerca de 4 semanas. **Duas** (back + front): cerca de 2,5 semanas.
- A MB0 é pequena e pode ir para produção sozinha; recomendo que vá antes da primeira casa conectar.

| Risco | Mitigação |
|---|---|
| Sem BM de teste com parceiro e USD, o aceite fica só com mocks | D9 como pré-requisito; quem cuida é o responsável pela conta Meta da Betleads |
| Limite de chamadas por app quando várias casas usam o mesmo app | Concorrência por app (MB2-05) e leitura dos headers de uso (MB2-01) |
| Mudança de versão da Graph API | `meta-api-version.ts` já tem piso; acompanhar o changelog a cada trimestre |
| Casa conecta antes da MB0 | Segurar a liberação da aba até a MB0 estar em produção |

## 9. Definição de pronto

1. Uma casa conecta duas BMs sem ajuda e vê o gasto de 90 dias de todas as contas marcadas em até 1 hora.
2. Uma conta compartilhada entre dois tokens continua sincronizando quando um deles sai.
3. Um erro numa conta não para as outras; um token revogado aparece em linguagem clara e alerta a operação.
4. Nenhuma casa fica sem sincronizar por run preso; 150 contas drenam em 1 hora.
5. Só o admin da casa altera a conexão; nenhum membro escreve pelo PostgREST; o demo nunca chama a Meta.
6. O gasto bate com o Gerenciador (≤ 1%) em 3 períodos.
7. Os blocos A–H e UX da seção 7 estão verdes no CI, e o aceite real (R) foi registrado aqui.

## 10. Relação com o ESCOPO_AQUISICAO_LTV

| Item AL | Passa a ser fechado por |
|---|---|
| AL2-01 Reaper | MB0-04 |
| AL2-02 `MetaApiError` | MB2-01 |
| AL2-03 Erro de uma conta não derruba a BM | MB1-05, MB2-04 |
| AL2-04 Insights assíncronos, timeout, token no header | MB2-02, MB2-07 |
| AL2-05 Política de sync e backfill | MB1-03, MB2-06 |
| AL2-06 Vazão | MB2-05 |
| AL2-07 Validade do token | MB2-03 |
| AL2-08 Papéis | MB0-01, MB3-06 |
| AL2-09 RLS | MB0-02 |
| AL2-10 Casas bloqueadas e demo | MB0-01, MB0-05 |
| AL2-11 Seleção atômica | MB1-03 |
| AL2-12 Tokens legados | MB0-03 |
| AL2-13 Observabilidade | MB4-01, MB4-02 |
| AL3-03 Wizard completo (parte da conexão) | MB3-01 a MB3-09 |
| AL3-04 Banner de token expirado | MB3-07 |

## 11. Fora deste escopo

- Login com Facebook / app Betleads único com App Review (AL5-01).
- Conversions API (AL5-02).
- Conversão de câmbio para gasto fora de BRL.
- Google, TikTok e Kwai (AL5-04).

## 12. Status

| ID | Status | Commit | Evidência | Data |
|---|---|---|---|---|
| — | proposto | — | Leitura em produção em 30/10/2026: 0 conexões por token, 0 runs, token legado em texto puro, `authenticated` com escrita em `meta_ad_accounts` | 30/10/2026 |
| MB0 | em produção | `0a368c2` + migration `20261116100000` | Admin-only nas ações da Meta, sem token em texto puro, reaper da fila, membros só com SELECT em contas e integrações. Conferido em produção após aplicar | 30/10/2026 |
| MB1 | em produção | `f056e37` + migration `20261118100000` | Conexão por token (D1), `meta_ad_account_access` N:N (D2), RPCs transacionais de conectar/selecionar/desconectar/revogar, backfill de 90 dias em blocos de 30 (D4), redescoberta diária, erros por nível (chave × conta × nova tentativa), orçamento de 40 s por tick e cron com timeout de 55 s. Duas revisões independentes; `npm test` 3969/3970 (a falha é a de SMS já existente na main) | 30/10/2026 |
| MB2 | em produção | `756ea40` + migration `20261127100000` | Cliente Graph único (`meta-graph.server.ts`: token só no header, cabeçalhos de uso, `debug_token`, insights assíncronos > 7 dias); recusa só token de usuário comum com validade; checagem de saúde diária com recuperação automática; limite de chamadas sem gastar tentativa (até 3 esperas de até 60 min); cron a cada minuto, claim justo (2 por casa, 3 por app), até 6 jobs por tick; agendamento 3 dias/hora e 28 dias de madrugada. A confirmar com a BM de teste (D9): o `type` devolvido pelo `debug_token` para Usuário do Sistema. `npm test` 4073/4074 (falha de SMS já existente na main) | 30/10/2026 |
| MB3 | implementado, aguarda produção | branch `feat/meta-mb3` (sem migration) | Tela de Integrações → Meta Ads refeita: cartão por chave (validade, saúde, Renomear/Trocar chave/Desconectar), painel lateral "Adicionar Usuário do Sistema" com guia, progresso Conectar → Escolher contas → Primeira leitura (%) → Pronto, contas agrupadas por BM com busca, filtros, grupo misto, aviso de USD e motivo visível, rascunho com merge de 3 vias e barra "alterações não salvas", aviso ao sair, diálogo de desconectar com impacto e confirmação digitada, modo leitura e demo. Lógica pura em `meta-connection-model.ts`. Revisão independente feita e corrigida; `npm test` 4219/4220 (falha de SMS já existente) + 13 arquivos que não carregam por falta do pacote `sanitize-html` na pasta de dependências local. Não verificado em navegador | 30/10/2026 |
| MB3 | em produção | `b775950` (sem migration) | Ver linha acima | 31/10/2026 |
| MB4 | implementado, aguarda produção | branch `feat/meta-mb4` + migration `20261127200000` | Histórico das sincronizações na aba Meta (detalhe por conta); alertas da Meta para a operação (Sentry/log/heartbeat `meta_sync`): sincronização parada, conta em erro há 48 h, chave com erro, chave expirando, casa sem leitura há 26 h; painel "Meta Ads por casa" no Admin com "Testar alerta"; filtro "BM / conta" no Aquisição e LTV (com filtro, só jogadores atribuídos às contas). Revisão independente feita e corrigida; `npm test` 4288/4289 + 13 arquivos sem `sanitize-html` local. Heartbeat exige `BETTERSTACK_HEARTBEAT_META_SYNC` (período ≥ 15 min) na VPS | 31/10/2026 |
