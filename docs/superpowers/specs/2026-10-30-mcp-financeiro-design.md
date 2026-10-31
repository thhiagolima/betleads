# MCP do Financeiro — design

Data: 2026-10-30
Status: proposta (branch feat/mcp-financeiro)
Base: o Financeiro da casa e do grupo (`2026-10-24-grupos-de-casas-design.md`) e o painel de
resultado (`2026-10-27-financeiro-painel-design.md`), já no main.

## 1. Intenção

Os admins que idealizaram o CRM querem conversar com o financeiro pelo Claude: perguntar
"quanto a Pixreals lucrou em outubro contra setembro?", "quais casas do grupo estão com dias sem
GGR?" e também **lançar** valores ("lança anúncios de R$ 3.200 e GGR de R$ 12.345,00 no dia 15
da Pixreals") sem abrir o painel.

Para isso o CRM ganha um **servidor MCP** (Model Context Protocol), um endpoint que o Claude
chama como "ferramentas". É de **uso interno**: só admins escolhidos pelo super admin conectam, e
cada um vê e altera pelo Claude **exatamente o que já vê e altera no painel**.

Sucesso é o admin conectar o Claude uma vez e, a partir daí, consultar e lançar o financeiro das
casas e grupos dele pela conversa, com os mesmos números do painel e sem conseguir tocar em nada
que o painel não deixaria.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**
- Um endpoint MCP remoto no próprio app que funciona no **Claude no navegador (claude.ai), no
  Claude Desktop e no Claude Code**.
- Conexão por **login OAuth** no CRM, que é o que os três clientes suportam como conector remoto.
- **Liberação por admin**, feita pelo super admin: sem acesso, só leitura, ou leitura e escrita.
- Ferramentas de **leitura**: escopos, resumo do período com comparação, mês de uma casa e metas.
- Ferramentas de **escrita**: valores do dia (Anúncios e GGR), GGR do mês, outros custos (criar,
  editar, excluir) e metas.
- Toda escrita passa por **prévia e confirmação** no servidor.
- Auditoria de **toda chamada**, e as escritas também no `tenant_audit_logs`, com origem `mcp`.

**Não-objetivos (v1)**
- Taxas (`setFinanceRates`) e quem pode ver o financeiro (`setFinanceViewer`). São alterações raras
  e sensíveis e continuam só no painel.
- Qualquer ação de cobrança do super admin (preço, desconto, baixa manual, bloqueio, cancelar
  fatura) e gerar Pix (`payInvoice`, `createCreditTopup`). Essas RPCs dependem de `auth.uid()` do
  login real e mexem direto em dinheiro.
- Leitura de saldo da carteira e faturas. *Decisão minha:* essas leituras usam o cliente Supabase
  do usuário (`ctx.supabase`, `resolveTenantForBilling`), que não existe numa chamada MCP. Entram
  numa fase própria.
- Outros assistentes além do Claude.
- Dados de players. O financeiro não precisa deles e as ferramentas não os expõem.

**Anti-objetivos** (seria um fracasso mesmo funcionando)
- O Claude mostrar um lucro, GGR ou ROI diferente do painel para o mesmo escopo e período.
- Qualquer caminho do MCP que leia ou grave tabelas do financeiro sem passar pela checagem de
  permissão do painel.
- Uma escrita gravada sem prévia confirmada, ou uma confirmação que grava algo diferente da prévia.
- Um admin ver ou alterar, pelo MCP, uma casa ou grupo que não vê no painel.

## 3. Restrição central: permissões são checadas em TypeScript

As leituras e escritas do financeiro usam o `supabaseAdmin` (`db()` em
`src/lib/finance/finance-data.server.ts`), que **ignora o RLS**. Quem protege é a checagem feita no
código antes de cada operação: `requirePermission(fn, userId, tenantId)` / `can(...)` (RPCs
`finance_can_*`) e `group_ids_managed_by` para grupos.

Por isso, a regra que vale para o projeto inteiro é: **as ferramentas do MCP chamam somente as
funções internas `*For(ctx, data)` que o painel já usa**, com `ctx.userId` vindo do token. Nenhuma
ferramenta consulta tabela do financeiro direto. Hoje essas funções são:

| Ferramenta | Função existente | Permissão (checada dentro dela) |
|---|---|---|
| resumo do período | `getFinanceDashboardFor` (`finance-dashboard.functions.ts`) | `finance_can_view` / grupo gerenciado / super admin |
| mês da casa | `getTenantFinanceMonthFor` (`finance.functions.ts`) | `finance_can_view` |
| metas da casa | `getTenantGoalsFor` | `finance_can_view` |
| lançar dias | `saveFinanceDaysFor` | `finance_can_edit_values` + casa não demo |
| GGR do mês | `setMonthlyGgrFor` | `finance_can_edit_values` + casa não demo |
| salvar custo | `saveOtherCostFor` | `finance_can_edit_values` + casa não demo |
| excluir custo | `deleteOtherCostFor` | `finance_can_edit_values` + casa não demo |
| meta | `setTenantGoalFor` | `finance_can_manage_goals` + casa não demo |

**Exceção — `listar_escopos`.** `listDashboardScopesFor` é só do super admin e deixa a demo de fora,
e `getTenantSwitcherFor` depende de `ctx.supabase`/`activeTenantId`, que uma chamada MCP não tem.
*Decisão minha:* uma função nova e pequena, `listFinanceScopesFor(userId)`, que só **lista**, usando os
mesmos helpers SQL do painel (`finance_can_view` por casa e `managedGroupIds`). Ela não concede nada:
toda ferramenta que recebe um id checa a permissão de novo dentro da função `*For`. O super admin
recebe todas as casas, com demo e inativas marcadas. Os demais recebem as casas onde têm
`finance_can_view` e os grupos que gerenciam.

Validação de entrada: as ferramentas reaproveitam os schemas zod existentes (`saveDaysInput`,
`setMonthlyGgrInput`, `saveOtherCostInput`, `deleteOtherCostInput`, `setGoalInput`). Os que ainda
não são exportados passam a ser.

## 4. Quem pode usar e o que alcança

- **Elegível:** qualquer usuário que hoje veja o financeiro de pelo menos uma casa ou gerencie um
  grupo, e o super admin.
- **Liberação:** o super admin escolhe, por usuário, `sem acesso` (padrão), `leitura` ou
  `leitura e escrita`. Sem liberação, o login OAuth recusa com uma mensagem clara.
- **Alcance:** igual ao painel. Casas via `finance_can_view`, grupos via `group_ids_managed_by`, e o
  escopo "todas as casas" só para o super admin. Num grupo, a escrita é sempre numa casa e a
  permissão é checada nessa casa.
- **Escrita exige as duas coisas:** a liberação `leitura e escrita` e a permissão da casa no painel
  (`finance_can_edit_values` ou `finance_can_manage_goals`). Um admin com `leitura` não escreve
  pelo MCP, mesmo que possa editar no painel.
- **Casa demo:** aparece na leitura marcada como demo. A escrita já é recusada por
  `assertTenantNotDemo`.
- **Casa suspensa, cancelada ou bloqueada por cobrança** (decisão do usuário): a **leitura continua
  liberada**, para consultar o histórico, e a **escrita é recusada**, com mensagem dizendo o motivo.
  No painel, esse bloqueio só existe na tela (`TenantStatusGate`/`BillingLock`), e as funções `*For`
  não o checam. Por isso o MCP checa na camada dele, antes de `preparar_*` e de novo em
  `confirmar_alteracao`: `tenants.status` suspenso ou cancelado, ou `isBillingLockedFor(tenantId,
  userId)` (`src/lib/billing/billing-state.server.ts`). O **super admin fica isento**, como já
  acontece no `billingView`. As funções do painel não mudam.
- **Revogar** a liberação ou desconectar um cliente invalida os tokens na hora (na próxima
  chamada).

## 5. Conexão: OAuth no CRM

Os três clientes Claude conectam a servidores MCP remotos por OAuth 2.1 com PKCE, seguindo a
especificação de autorização do MCP. O CRM faz o papel de **servidor de autorização** e de
**servidor de recurso**.

*Decisão minha:* um servidor OAuth mínimo dentro do próprio app, com tokens opacos guardados como
hash no banco. Assim revogação e liberação ficam sob nosso controle e não dependem de recurso beta
de terceiros. O builder pode avaliar o OAuth server do Supabase Auth como alternativa, mas só deve
trocar se ele cobrir revogação imediata, liberação por usuário e os três clientes.

Peças:
- `/.well-known/oauth-protected-resource` e `/.well-known/oauth-authorization-server` (metadados).
- **Registro dinâmico de cliente** (o claude.ai, o Desktop e o Code se registram sozinhos). Só são
  aceitos redirect URIs do claude.ai/Claude e de `localhost`/`127.0.0.1` (Claude Code).
- **Tela de autorização** no CRM. A sessão do Supabase fica no navegador (`persistSession`, storage
  próprio em `src/integrations/supabase/client.ts`), não em cookie, então um `/authorize` renderizado
  no servidor não sabe quem está logado. Por isso o `/authorize` é uma **rota do cliente**: se não
  houver sessão, manda para o login e volta. Com sessão, chama uma server function com o Bearer do
  usuário (`requireSupabaseAuth`), que confere a liberação e emite o código de autorização.
  A tela Mostra "Claude quer acessar o financeiro de: [casas e grupos]", o nível liberado
  (leitura, ou leitura e escrita) e os botões Permitir/Cancelar.
- **Tokens:** access token curto (1 h) e refresh token com rotação (30 dias), os dois guardados só
  como hash e ligados a uma **conexão** (usuário + cliente OAuth). *Decisão minha:* esses prazos.
- **O nível não fica no token.** A cada chamada o servidor lê no banco a liberação vigente do
  usuário e a conexão. Baixar de `leitura e escrita` para `leitura`, ou revogar, vale na chamada
  seguinte, sem esperar o token expirar.
- **PKCE S256 obrigatório**, `state` checado e código de autorização de uso único com 10 minutos.

## 6. Ferramentas

Nomes e descrições em pt-BR, porque é o que os admins vão ler nas permissões do Claude. Cada
ferramenta recebe ids (de casa e de grupo) que vêm de `listar_escopos`. Os valores em dinheiro
entram e saem como **número em reais com ponto decimal** (`12345.00`). Na prévia e nos textos, o
servidor também os formata em pt-BR (`R$ 12.345,00`), para o admin conferir.

**Leitura**
1. `listar_escopos`: casas e grupos do usuário (id, nome, se é demo) e o nível de acesso dele.
2. `resumo_financeiro(escopo, periodo, comparar)`: o mesmo resultado do painel (totais, linhas por
   casa, KPIs, dias pendentes, metas). O período segue o filtro do painel: `PeriodPreset`/`DateRange`
   e `CompareMode`.
3. `mes_da_casa(casa, mes)`: dias lançados, outros custos, taxas em vigor (só leitura), GGR do mês e
   pendências. A lista de visualizadores (`viewers`) e qualquer e-mail de usuário **não** saem.
4. `metas_da_casa(casa)`: metas em vigor.

**Escrita** (sempre em duas etapas)
5. `preparar_lancamento_dias(casa, entradas[{data, anuncios?, ggr?}])`: no máximo 31 entradas por
   chamada. *Decisão minha:* 31, já que o schema atual permite 62. Campo ausente mantém o valor e
   `null` apaga, igual ao painel.
6. `preparar_ggr_mensal(casa, mes, ggr | null, atualizado_ate)`.
7. `preparar_custo(casa, {id?, data, descricao, valor, categoria?, repetir_todo_mes})`: cria ou
   edita.
8. `preparar_exclusao_custo(casa, id, modo: excluir | pular_mes | encerrar_serie)`.
9. `preparar_meta(casa, metrica, direcao, valor_diario | null, a_partir_de?)`.
10. `confirmar_alteracao(codigo)`: aplica a prévia.

## 7. Prévia e confirmação

- Cada `preparar_*` valida a entrada com o schema real, **checa a permissão** (para recusar já na
  prévia) e lê os valores atuais. Não grava nada no financeiro.
- A resposta traz a prévia legível, com uma linha por alteração no formato antes → depois
  (`15/10 Pixreals — GGR: R$ 12.000,00 → R$ 12.345,00`), avisos ("vai apagar o valor de
  Anúncios", "sobrescreve um valor existente") e um `codigo_confirmacao`.
- O código fica guardado no servidor com o usuário, o token, a ação, a entrada já validada e um
  retrato dos valores "antes". Vale **10 minutos** e é de **uso único**.
- `confirmar_alteracao(codigo)`:
  - só funciona com o mesmo usuário e a mesma **conexão** que geraram a prévia, e continua valendo
    se o access token for renovado no meio do caminho;
  - checa a permissão de novo e a liberação ainda vigente;
  - compara os valores atuais com o retrato da prévia e, se mudaram, recusa com "os valores
    mudaram desde a prévia, gere uma nova";
  - chama a função `*For` correspondente com a entrada guardada (nunca com dados novos vindos do
    Claude) e devolve o resultado.
- A descrição das ferramentas `preparar_*` instrui o Claude a mostrar a prévia ao usuário e só
  confirmar depois que ele aprovar. A garantia, porém, é o fluxo em duas etapas do servidor, não
  essa instrução.

## 8. Auditoria e limites

- **Log de chamadas MCP:** uma linha por chamada, com usuário, cliente, ferramenta, escopo/casa,
  sucesso ou erro, duração e, nas escritas, o código de confirmação. Os argumentos ficam
  guardados sem dados sensíveis, que no financeiro são basicamente só valores.
- **`tenant_audit_logs`:** as funções `*For` já gravam com before/after, e `auditTenant` já aceita
  `metadata`. Não existe um `ServerContext` compartilhado: cada arquivo declara o seu (em
  `finance.functions.ts` é `{ userId: string }`). O tipo local ganha um campo opcional
  `auditMetadata` (`origem: "mcp"`, id da conexão e código de confirmação). Cada chamada de
  `auditTenant` nas funções usadas pelo MCP passa a repassá-lo. Sem esse campo, como no painel, o
  comportamento é o atual.
- **Limites** (*decisão minha*, ajustável por constante): 60 chamadas por minuto por token e 30
  confirmações por hora por usuário. Acima disso, o erro é claro e o Claude consegue explicar.
- **Interruptor geral:** a variável `MCP_ENABLED`, desligada por padrão (mesmo padrão do
  `SIGNUP_ENABLED`). Desligada, o endpoint e o OAuth respondem 404.

## 9. Telas

- **Super admin — Acesso MCP:** lista os usuários elegíveis com o nível (sem acesso, leitura, ou
  leitura e escrita), os clientes conectados por usuário (nome do cliente, data da conexão, último
  uso) e as ações de revogar um cliente ou tudo de um usuário. Toda mudança é auditada.
- **Usuário liberado — Conectar ao Claude:** mostra a URL do MCP, o passo a passo para claude.ai,
  Desktop e Code, as conexões ativas dele e o botão desconectar.

O lugar exato dessas telas na navegação fica com o builder, seguindo o shell atual.

## 10. Técnica

- SDK oficial `@modelcontextprotocol/sdk` (TypeScript), transporte **Streamable HTTP sem sessão**
  (cada chamada traz o token e é independente). É uma dependência nova.
- Rota sob `src/routes/api/` (ex.: `/api/mcp`), no mesmo padrão das rotas de API existentes.
- O repositório tem Node (`Dockerfile`, `npm start`) e Workers (`wrangler.jsonc`). *Decisão minha:*
  o MCP é **agnóstico de runtime**: um handler de `Request`/`Response` padrão da web (o transporte
  Web Standard do SDK), Web Crypto para hash e PKCE, e limites de chamadas contados **no banco**,
  não em memória.
- Migrações novas: liberação por usuário, clientes OAuth, códigos de autorização, tokens (hash),
  prévias pendentes e log de chamadas. Todas com RLS ligado e sem acesso pelo cliente anon ou
  autenticado. Só o servidor (service role) lê e grava.
- `npm run build` antes do merge, para pegar `*.server` vazando para o bundle do cliente.

## 11. Testes que importam

- Admin A, com o token dele, não lê nem prepara nada na casa ou no grupo de B, nem passando o id
  direto.
- Admin com `leitura` recebe erro em `preparar_*` e em `confirmar_alteracao`. Baixar o nível
  de um admin conectado tira a escrita na chamada seguinte.
- Um código de confirmação: não funciona com outro usuário ou conexão, não funciona depois de 10
  minutos, não funciona duas vezes e é recusado se os valores mudaram desde a prévia.
- Revogar a liberação derruba o token já emitido na próxima chamada.
- `resumo_financeiro` devolve os mesmos totais que `getFinanceDashboardFor` para o mesmo escopo e
  período.
- Escrita na casa demo é recusada.
- Escrita numa casa suspensa, cancelada ou bloqueada por cobrança é recusada para um admin e
  aceita para o super admin. A leitura funciona para os dois.
- Escrita via MCP gera a linha no `tenant_audit_logs` com `origem: "mcp"`.
- OAuth: PKCE errado, `redirect_uri` fora da lista, código reutilizado e refresh token reutilizado
  (com rotação) são recusados.

## 12. Fica com o builder

- Formato exato do JSON de cada ferramenta: compacto e com nomes em pt-BR, sem repetir o payload
  inteiro do painel quando não for útil.
- Nomes das tabelas e numeração das migrações (depois da última no main).
- Lugar das telas na navegação.
- Se a liberação vira tabela própria ou coluna no perfil do usuário.
