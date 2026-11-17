# MCP do grupo — operação (fase 1, só leitura)

Data: 2026-11-17
Status: aprovado para implementar (branch feat/mcp-grupo)
Base: MCP do financeiro (`2026-10-30-mcp-financeiro-design.md`, já no main) e grupos de casas
(`2026-10-24-grupos-de-casas-design.md`).

## 1. Intenção

Hoje o MCP só conversa com o financeiro. O dono de um grupo quer perguntar ao Claude sobre a
**operação de todas as casas do grupo de uma vez**: como estão cadastros e FTDs, quais experts
trazem mais depósito, o que um `affiliate_id` gerou, como foram as campanhas e jornadas e o que
precisa de atenção hoje.

Sucesso é o gestor do grupo perguntar "como foi a semana das casas do grupo?" ou "o que o
afiliado 4512 trouxe em outubro?" e receber, numa chamada, os números por casa e o total. Os
números são os mesmos que cada casa vê no painel, e ele nunca vê uma casa que não deveria.

## 2. Decisões do usuário

1. **Quem vê a operação:** o super admin vê todas as casas. O **gestor do grupo** vê as casas do
   grupo que gerencia, e o **admin da casa** vê a casa dele. Gestor (papel `gestor`) e membro da
   casa não veem.
2. **Só leitura.** Esta fase não cria nenhuma escrita. As escritas do financeiro que já existem
   continuam como estão.
3. **Afiliado** = `players.affiliate_id`. A consulta funciona por **qualquer** id, ligado ou não
   a um expert. O vínculo com o expert, quando existe, aparece como informação.

## 3. Não-objetivos e anti-objetivos

**Não-objetivos:** escritas operacionais, comissão de afiliado (paga fora do sistema), dados
individuais de jogador, fluxos legados (`flows`, `sms_flows`, `email_flows`, `call_flows`; só as
jornadas entram), WhatsApp.

**Anti-objetivos** (seria fracasso mesmo funcionando):
- Telefone, e-mail, CPF, nome ou id de jogador saindo por qualquer ferramenta. Tudo é agregado.
  Ids de expert, campanha, jornada e `affiliate_id` podem sair.
- O gestor de grupo ganhar acesso operacional fora do MCP. `has_tenant_access`,
  `accessible_tenant_ids`, `managed_tenant_ids` e `current_tenant_id` **não mudam** (regra do
  §8 da especificação de grupos).
- Somar valores de casas com moedas diferentes.
- Uma casa com erro derrubar a resposta do grupo inteiro.

## 4. Permissão: um caminho só

### 4.1 No banco

Uma função nova, `mcp_ops_tenant_ids(_user uuid) returns setof uuid`, `security definer`, com
execução só para `service_role`. Ela devolve:
- todas as casas, se `is_super_admin(_user)`;
- senão, a união de:
  - casas onde `_user` tem `user_roles.role = 'admin'`;
  - `group_tenant_ids(g)` para cada `g` em `group_ids_managed_by(_user)`.

E `mcp_ops_can_view(_user, _tenant) returns boolean`, que é `exists` sobre a função acima. Nada
mais usa essas funções além do MCP.

### 4.2 No TypeScript

Um módulo `src/lib/mcp/ops/scope.server.ts` com
`resolverEscopoOps(userId, escopo): Promise<{ casas: CasaOps[]; rotulo: string }>`. É **a única
porta**: toda ferramenta de operação chama essa função e só consulta as casas que ela devolve.

- `escopo` é `{tipo: "casa", id}`, `{tipo: "grupo", id}` ou `{tipo: "todas"}`.
- **casa:** `mcp_ops_can_view`. Se falhar: "Você não tem acesso à operação desta casa."
- **grupo:** o grupo está em `managedGroupIds(userId)` (o super admin já recebe todos), e as casas
  vêm de `tenant_group_tenants`.
- **todas:** todas as casas de `mcp_ops_tenant_ids`, **sem as demo**. Para o super admin isso
  significa todas as casas reais. *Diferença consciente* do `resumo_financeiro`, onde "todas" é só
  para o super admin: aqui é "todas as casas que você vê".
- Uma casa demo aparece quando é pedida direto (casa) ou quando o grupo é demo.
- `CasaOps = { id, nome, moeda, status, isDemo, grupo: {id, nome} | null }`, com a moeda vinda de
  `toTenantCurrency`.
- **Limite:** no máximo `MAX_OPS_TENANTS = 60` casas por chamada. Acima disso: "Escopo grande
  demais; consulte por grupo."

### 4.3 Liberação por área

`mcp_access` ganha a coluna `areas text[] not null default '{financeiro}'`, com check de que é
subconjunto de `{financeiro, operacao}` e não vazio. Linhas existentes ficam só com financeiro,
então quem já está liberado **não** ganha a operação sem o super admin ligar.

- `McpIdentity` ganha `areas`, lidas do banco a cada chamada como o nível.
- Ferramentas financeiras exigem a área `financeiro`. As de operação exigem `operacao`. Sem a
  área: "Seu acesso ao MCP não inclui {área}."
- A ferramenta só é **registrada** se a identidade tem a área, para o Claude nem ver o que não
  pode usar. A checagem no handler continua mesmo assim.
- O painel do super admin ([mcp-access-panel.tsx](../../../src/components/admin/mcp-access-panel.tsx))
  ganha duas caixas por usuário: Financeiro e Operação. A mudança é auditada como hoje.
- Elegibilidade para liberar a área de operação: super admin, admin de alguma casa ou gestor de
  algum grupo.

## 5. Ferramentas (todas `readOnlyHint: true`)

Formato comum:
- Entrada: `escopo` (§4.2) e, quando há período, `periodo` igual ao do financeiro
  (`{preset}` ou `{inicio, fim}`, mesmo `presetRange`, dias no horário de Brasília).
- Saída: `{ rotulo, periodo, casas: [...linha por casa], totais_por_moeda: [...], casas_com_erro:
  [{id, nome, erro}] }`. Dinheiro é número com ponto, sempre na moeda da casa. Nunca há total
  entre moedas: `totais_por_moeda` traz um total por moeda.
- **Execução por casa** com no máximo 6 em paralelo. Uma casa que falha entra em `casas_com_erro`
  com mensagem curta, e o resto segue. Se **todas** falharem, a ferramenta devolve erro.
- Listas têm `limite` (padrão 20, máximo 100) e devolvem `truncado: boolean`.

### 5.1 `listar_escopos` (ampliada)

Mantém o resultado atual e soma:
- `areas` da identidade;
- `operacao: { casas: CasaOps[], grupos: [{id, nome, isDemo, casas: n}] }`, presente só com a
  área `operacao`.

### 5.2 `visao_geral(escopo, periodo, comparar?)`

Por casa: cadastros, FTDs, depósitos (quantidade e valor), depositantes, saques (quantidade e
valor) e ticket médio, com `anterior` quando há comparação. Inclui também a base por estado
(`crm_lifecycle_snapshot`: ativo, esfriando, dormindo, perdido, sem_ftd), que é um retrato de
agora e não do período. E o CRM do período (`finance_activity_days`: enviados, cliques, conversões
diretas e receita direta), mais o custo de envios em BRL (`fetchSendUsage`).

Fonte dos KPIs: `dashboard_summary_v2` por casa, com as mesmas datas e o mesmo `_reset_at` que
`getDashboardSummary` usa. O mapeamento é o `mapDashboardRpc` já existente. **GGR e lucro não
entram**, porque são do financeiro (já em `resumo_financeiro`).

### 5.3 `comparar_casas(escopo, periodo)`

O que a tela de comparação de casas já mostra: cliques, conversões, ROI do CRM, custo, base por
estado, funil cadastro→FTD e 2º depósito. Extrair o miolo de `getTenantComparison`
(`src/lib/tenant-comparison.functions.ts`) para `getTenantComparisonFor(tenantIds, range)`. A
server function do painel passa a chamá-la, sem mudar o comportamento dela. A permissão continua
fora do miolo: o painel usa `comparableTenants` e o MCP usa `resolverEscopoOps`.

### 5.4 `ranking_experts(escopo, periodo, ordenar?, limite?)`

Uma linha por expert, com a casa: nome, tipo, ativo e, de `expert_metrics`: depositado,
depositado por clique, depositado por afiliado, depósitos, depositantes, FTDs, reativações, links,
cliques e contatos. Também o teto mensal e o uso do mês corrente (`expert_monthly_usage`), quando
existem. Por casa, a fatia do expert no total depositado da casa (`house_deposit_totals`).

`ordenar`: `depositado` (padrão), `ftds` ou `cliques`. O ranking é por moeda: experts de casas em
moedas diferentes não se misturam numa ordem única. A saída agrupa por moeda.

### 5.5 `detalhe_expert(casa, expert, periodo)`

As métricas do expert (as mesmas do 5.4), os `affiliate_id` vinculados a ele (`expert_affiliates`),
as campanhas do expert no período (`sms_campaigns`, `email_campaigns` e `expert_voice_campaigns`
com `expert_id`: id, canal, nome, status, enviados e falhas), o uso do teto
(`listExpertUsageForAdminCore`) e os alertas de teto abertos (`expert_cap_alerts`). Escopo é uma
casa, checada por `resolverEscopoOps({tipo: "casa"})`, e o expert tem que ser dela.

### 5.6 `afiliados(escopo, periodo, affiliate_id?, so_sem_expert?, ordenar?, limite?)`

Uma RPC nova, `mcp_affiliate_metrics(_tenants uuid[], _from timestamptz, _to timestamptz,
_affiliate text default null)`, só para `service_role`. Por (casa, `affiliate_id`) ela devolve:
- jogadores na base (total, sem período);
- cadastros no período;
- FTDs no período (`ftd_em` no período);
- depósitos aprovados no período (quantidade e valor) e depositantes;
- primeiro e último cadastro;
- `expert_id` e nome do expert vinculado (via `expert_affiliates`), ou null.

Jogadores sem `affiliate_id` não entram. Precisa do índice `players (tenant_id, affiliate_id)`
(hoje só existe em `affiliate_id`).

- Com `affiliate_id`: só esse id, em todas as casas do escopo, mesmo **sem expert**. Se nenhuma
  casa tiver o id: `encontrado: false`, não é erro.
- `so_sem_expert: true` lista só os ids sem vínculo.
- `ordenar`: `depositado` (padrão), `cadastros` ou `ftds`.

### 5.7 `campanhas(escopo, periodo, canal?, status?, limite?)`

Campanhas criadas **ou** disparadas no período, nos canais `sms`, `email`, `voz` (`voice_campaigns`)
e `webpush`. Por campanha: casa, canal, id, nome, status, criada em, agendada ou enviada em, total,
enviados, falhas e `expert_id` (quando a tabela tem). Os resultados vêm de `crm_results_daily`
(`source_type = 'campaign'`, `source_id` = id da campanha): custo, cliques humanos, conversões
diretas e receita direta. O resumo por casa e canal traz quantidade, enviados, custo, cliques e
conversões.

*O builder confere* as colunas de status e de data de envio de cada tabela e se `source_id` liga
mesmo à campanha do canal. Onde a ligação não existir, o resultado vem null, nunca inventado.

### 5.8 `jornadas(escopo, status?, periodo?)`

Por jornada: casa, id, nome, status, gatilho, limite diário e as métricas de `list_journey_metrics`
(inscritos por status). Com período, também enviados, custo, cliques e conversões de
`crm_results_daily` (`source_type = 'journey'`).

### 5.9 `alertas(escopo)`

"O que precisa de atenção agora", em uma lista com `{casa, tipo, gravidade: alta|media, mensagem,
ref?}`:
- casa suspensa, cancelada ou bloqueada por cobrança (`alta`);
- saldo da carteira (`tenant_wallets`) abaixo do consumo médio de 3 dias de envios (`alta` se
  zerado, `media` se baixo);
- campanha com status de falha, ou com falhas acima de 20% do total, nos últimos 7 dias (`media`);
- jornada ativa sem nenhum envio nas últimas 48 h, quando enviava antes (`media`);
- expert com alerta de teto aberto (`media`);
- casa sem cadastro e sem depósito ontem e hoje, segundo `tenant_daily_metrics`, que indica
  integração parada (`alta`).

Ordenada por gravidade e depois por casa. Cada regra é uma função pequena e testada isoladamente.
Os limites (20%, 48 h, 3 dias) ficam em constantes.

## 6. Robustez e infraestrutura

- **Servidor:** renomear para `betleads` e reescrever as `instructions` cobrindo as duas áreas. A
  operação começa por `listar_escopos` e é só leitura.
- **Log:** `mcp_call_log` ganha `args jsonb` (argumentos da chamada, sem nada de jogador; a
  ferramenta já não recebe dado pessoal) e `scope jsonb` (`{tipo, id, casas: n}`). `logCall`
  recebe os dois. O argumento é cortado em 4 KB.
- **Limite de chamadas:** continua em 60 por minuto. As ferramentas de operação contam peso 1, já
  que resolvem o grupo inteiro numa chamada.
- **Texto da ajuda** ([src/help/screens/mcp.ts](../../../src/help/screens/mcp.ts)): corrigir "URL
  própria desta casa", porque a URL é uma só. Incluir a área de operação.
- **Nada novo de cliente:** tudo sob `src/lib/mcp/ops/*.server.ts`. Rodar `npm run build` antes do
  push para pegar `*.server` vazando para o bundle.

## 7. Migração

`supabase/migrations/20261231101400_mcp_grupo_operacao.sql`, idempotente, contendo:
1. `mcp_access.areas`;
2. `mcp_call_log.args` e `scope`;
3. `mcp_ops_tenant_ids`, `mcp_ops_can_view` e `mcp_affiliate_metrics`, com `revoke` de
   public/anon/authenticated e `grant` a `service_role`;
4. índice `players (tenant_id, affiliate_id) where affiliate_id is not null`.

Aplicar no banco **antes** do push para o main, porque o deploy segue o main.

## 8. Testes que importam

- O gestor do grupo A não vê casa do grupo B, nem passando o id direto. O admin da casa X não vê
  a casa Y. Gestor e membro não veem nenhuma.
- Usuário sem a área `operacao` não vê as ferramentas de operação e, se chamar mesmo assim, recebe
  o erro de área.
- "todas" para um admin com 2 casas devolve só as 2. Para o super admin, todas sem as demo.
- `afiliados` com um `affiliate_id` sem expert devolve os números e `expert: null`. Com um id
  inexistente, devolve `encontrado: false`.
- Uma casa que falha vai para `casas_com_erro` e as outras voltam.
- Duas moedas no escopo dão dois totais e nenhuma soma entre elas.
- Nenhuma saída de ferramenta contém as chaves `telefone`, `email`, `cpf` ou `player_id` (teste de
  forma sobre os resultados).
- `visao_geral` de uma casa bate com `getDashboardSummary` da mesma casa e do mesmo período.
- `getTenantComparison` do painel devolve o mesmo resultado de antes da extração.
