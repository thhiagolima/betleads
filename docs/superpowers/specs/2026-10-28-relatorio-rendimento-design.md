# Relatório de rendimento (expert e equipe) — desenho

Data: 2026-10-28 · Status: rascunho para aprovação
Base: Área do Expert, fases 1–3, em produção (`main` d055404). Spec original: `docs/superpowers/specs/2026-10-23-area-expert-design.md` (seções 6, 7 e 7.1).

## 1. Intenção e porquê

Experts e gestores com perfil de rendimento são comissionados sobre o **total depositado creditado** a eles. A comissão é paga fora do sistema. No fechamento do mês, a pessoa e o admin precisam olhar **os mesmos números** e responder perguntas como:

- quantos FTDs, quantos redepósitos e quanto foi creditado;
- se o resultado melhorou em relação ao período anterior;
- se a pessoa converte as conversas em depósito;
- quais leads trouxeram o resultado e por que um depósito não contou.

Hoje o expert vê um resumo no Início e o admin vê ranking e detalhe em `/experts`. O gestor com perfil vinculado não tem nenhuma tela com os próprios números.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos**
- Uma página única, **Relatório de rendimento**, igual para a pessoa (só os números dela) e para o admin (qualquer pessoa da casa).
- Uma página do admin, **Rendimento da equipe**, com os totais da equipe e o ranking.
- O histórico de cada lead com aquela pessoa, incluindo os depósitos **não creditados** e o motivo.

**Não-objetivos**
- Saques. Ficam de fora, por decisão da usuária.
- Calcular o valor da comissão. O sistema entrega a base e o extrato.
- Mudar a regra de crédito (fase 3). Esta entrega só lê `expert_deposit_credits` e as tabelas existentes.
- Consumo e retorno das campanhas do expert (fase 4).

**Anti-objetivos**
- A pessoa ver números diferentes dos que o admin vê para o mesmo período.
- Um expert ou gestor ver números, leads ou histórico de outra pessoa.
- Um número que não bate com o extrato (por exemplo, um total do cartão diferente da soma do CSV do mesmo período).
- O histórico esconder por que um depósito não contou.

## 3. Quem usa e onde encontra

| Quem | Onde | O que vê |
|---|---|---|
| Expert (papel `expert`) | Menu do expert: item novo **"Rendimento"** (`/expert/rendimento`), ao lado de Início, Leads e Modelos. O Início ganha o atalho "Ver relatório completo". | O próprio relatório |
| Gestor/admin/membro com perfil vinculado (fase 3, §7.1) | Menu da casa: item **"Meu rendimento"**, visível só para quem tem perfil ativo na casa atual | O próprio relatório |
| Admin da casa | Seção Resultados: item **"Rendimento da equipe"**. Clicar numa pessoa abre o relatório dela. | Totais da equipe, ranking e o relatório de qualquer pessoa da casa |

- A tela **Experts** (em Jogadores) volta a ser só cadastro e configuração: criar, editar, convidar, vincular, ativar/desativar, excluir, regras de crédito e "IDs de afiliado sem expert". O ranking e o detalhe com números saem de lá. *(decisão minha: a rota `/experts/$expertId` passa a redirecionar para o relatório da pessoa, para não haver duas telas com os mesmos números.)*
- Períodos em todas as páginas: Hoje, Ontem, 7, 30 e 90 dias, Este mês e Mês passado (os mesmos de `src/lib/expert-period.ts`). Padrão: Este mês. *(decisão minha: no fechamento o natural é o mês; os painéis da fase 3 usam 30 dias)*

## 4. Relatório de rendimento (uma pessoa)

O cabeçalho traz nome, tipo ("Expert restrito", "Expert total" ou "Equipe (Gestor)"), casa, seletor de período e "Exportar CSV" (o extrato da fase 3). Para o admin, aparecem também "Editar" e "Desativar", que abrem os diálogos existentes.

**Bloco 1. Resultado do período**, com a variação em relação ao período anterior de mesmo tamanho.

*Decisão minha:* o período anterior tem a mesma duração e termina no mesmo ponto relativo, para não comparar um período parcial com um inteiro:
- **Hoje** (00:00 até agora): ontem, de 00:00 até a mesma hora.
- **Ontem:** anteontem, o dia inteiro.
- **7, 30 e 90 dias:** a faixa `[de − N dias, até − N dias)`. O período parcial de hoje fica espelhado.
- **Este mês** (dia 1 até agora): o mês anterior, do dia 1 até o mesmo dia e a mesma hora. Se o mês anterior for mais curto, a comparação vai até o fim dele.
- **Mês passado:** o mês anterior a ele, inteiro.

A função de período devolve os dois pares `de`/`até` (atual e anterior), e todas as telas usam essa mesma função.

O bloco tem quatro cartões:

- **Depositado creditado:** total, com o detalhe "clique R$ X · afiliado R$ Y".
- **FTDs:** quantidade e valor somado dos primeiros depósitos.
- **Redepósitos:** quantidade, valor e ticket médio. Redepósito é todo depósito creditado que não é o primeiro da vida do lead (`is_ftd = false`).
- **Reativados:** quantidade de depósitos com `is_reativacao`. O cartão explica: "leads que estavam dormindo".

A variação aparece em percentual (▲ verde / ▼ vermelho). Sem base no período anterior, aparece "—".

**Bloco 2. Do contato ao depósito**, no período:
- links gerados;
- **leads que clicaram:** leads distintos com clique humano nos links da pessoa, e o percentual sobre os leads que receberam link;
- **depositaram em até {janela}h:** leads distintos com crédito por clique, e o percentual sobre os que clicaram;
- contatos registrados.

**Bloco 3. Evolução por dia:** barras empilhadas FTD × redepósito (valor) e uma linha com os depositantes distintos do dia.

**Bloco 4. Leads que mais depositaram:** top 10 por valor creditado no período, com nome, valor, número de depósitos e origem. Cada linha abre o histórico do lead (bloco 6).

**Bloco 5. Extrato:** o da fase 3, sem mudanças, com paginação, total e CSV. O total do bloco 1 é igual ao total do extrato no mesmo período.

**Bloco 6. Leads do período:**
- a carteira da pessoa: todos os leads com ao menos um crédito para ela no período;
- colunas: Lead, Creditado, Depósitos, Origem (clique, afiliado ou ambos), 1º crédito, Último depósito, Último contato (resultado e data);
- marcas **FTD** (o lead fez o primeiro depósito no período com crédito) e **Reativado**;
- busca por nome ou telefone, filtros "Só FTD" e "Só reativados", ordenação por creditado (decrescente);
- paginação de 50 por página e CSV da carteira. *(decisão minha)*

**Histórico do lead com a pessoa:** um painel lateral que abre ao clicar num lead dos blocos 4 ou 6.
- **Cabeçalho:** creditado à pessoa (total, não só do período), número de depósitos creditados e "desde" (data do primeiro crédito).
- **Linha do tempo,** da mais nova para a mais antiga, juntando:
  - links que a pessoa enviou a esse lead;
  - cliques do lead nesses links (só humanos);
  - contatos registrados pela pessoa, com resultado e nota;
  - **todos os depósitos aprovados do lead** dentro do período de relacionamento. Esse período vai do primeiro link enviado ou do primeiro crédito, o que vier antes, até hoje. *(decisão minha)*
- Cada depósito aparece como:
  - **creditado:** com o motivo ("clique em {data hora}" ou "afiliado");
  - **creditado a outra pessoa:** sem dizer quem, só "contou para outro membro da equipe";
  - **não creditado:** com o motivo provável. Os motivos possíveis são:
    - "sem clique seu nas {janela}h anteriores";
    - "perfil desativado na data";
    - "ID de afiliado não era seu na data";
    - "antes do seu cadastro".
- Os depósitos não creditados aparecem em cinza.
- **Limite:** *(decisão minha)* a linha do tempo carrega os 100 itens mais recentes. O botão "Carregar mais" pagina por data (cursor = data do último item). Isso evita uma lista enorme para leads antigos e muito ativos.
- Link "Abrir ficha do lead": para o expert, `/expert/leads/$playerId`; para a equipe e o admin, a ficha da casa.
- **Escopo:** o histórico mostra só o que é da pessoa (os links, cliques e contatos dela) e os depósitos do lead. Nunca mostra notas, links ou contatos de outra pessoa.

## 5. Rendimento da equipe (admin)

- **Topo:**
  - total creditado à equipe no período e o percentual sobre o total depositado aprovado na casa no mesmo período;
  - FTDs da equipe e o percentual sobre os FTDs da casa;
  - redepósitos;
  - reativados.
- **Ranking:**
  - uma linha por perfil da casa (experts e equipe, inclusive os inativos, marcados como tal);
  - colunas: Pessoa, Tipo, Creditado, Variação vs período anterior, FTD, Redepósitos, Reativados, Clique→depósito (%), Ticket médio;
  - ordenação por creditado (decrescente), com cabeçalhos clicáveis para reordenar;
  - clicar na pessoa abre o relatório dela;
  - CSV do ranking. *(decisão minha)*
- O botão "Regras de crédito" fica na tela Experts (configuração) e aparece também aqui, como atalho.

## 6. Acesso

- **Pessoa:** a página dela resolve o perfil pelo usuário logado na casa atual:
  - expert: `requireExpertContext`;
  - equipe: o perfil ativo vinculado, a mesma regra de `getMyTeamExpertProfile`.
  
  Ela nunca recebe um `expertId` vindo do cliente.
- **Admin:** a página dele recebe o `expertId` e valida a casa com `requireExpertAdminTenant` + `loadExpert`. Perfil de outra casa: "Expert não encontrado.".
- Cada consulta filtra pela casa e pelo `expert_id`. A linha do tempo do lead também filtra pela casa e pelo `player_id`, e só mostra os links, cliques e contatos do próprio `expert_id`.
- O admin vê o mesmo relatório que a pessoa, montado pela mesma função de servidor, com o mesmo resultado.

## 7. Consistência dos números

- Todos os valores de depósito vêm de `expert_deposit_credits`. O período usa `deposit_at` em dias de São Paulo, com o mesmo `periodRange` da fase 3.
- Total do bloco 1 = soma do extrato = soma da carteira do bloco 6, para o mesmo período. Deve haver um teste que garanta isso.
- O total depositado da casa (denominador do topo da equipe) vem de `deposits.status = 'aprovado'` e `created_at` no mesmo período. FTDs da casa: o mesmo critério de FTD da fase 3, aplicado a todos os depósitos da casa.
- Os números refletem o último cálculo do cron (até 10 minutos de atraso). A página mostra "Atualizado às {hh:mm}" a partir do maior `computed_at` dos créditos da casa. *(decisão minha)* Sem nenhum crédito na casa, mostra "Os créditos são calculados a cada 10 minutos.", em vez de uma hora.
- **"Clique→depósito"** tem a mesma definição no bloco 2 e no ranking da equipe *(decisão minha)*: leads distintos com crédito por clique no período ÷ leads distintos com clique humano nos links da pessoa no período. Os dois vêm da mesma função SQL.

## 8. Desempenho

- As casas grandes têm cerca de 35 mil jogadores e centenas de milhares de envios. As agregações devem ser feitas em SQL (funções security definer, só service role, como `expert_metrics`), não carregando linhas no servidor.
- O ranking da equipe deve sair de uma única chamada para todos os perfis.
- A carteira do bloco 6 é paginada no banco.

## 9. Fora do escopo desta entrega

- Saques e líquido.
- Comissão calculada.
- Notificações ou envio por e-mail do relatório.
- Metas por pessoa.

## 10. Deixado para quem implementar

- Desenho das funções SQL: uma `expert_report` (blocos 1–2, mais o período anterior), uma série diária com FTD/redepósito/depositantes, uma carteira paginada com busca e filtros, uma linha do tempo do lead e os totais da casa para o topo da equipe.
- Como derivar o "motivo provável" de não crédito a partir de `expert_affiliate_history`, `experts.desativado_em`, `experts.created_at` e `click_events` + `link_dispatches`.
- O componente do painel lateral (Sheet) e a reorganização dos componentes de `src/routes/experts.$expertId.tsx` para o relatório compartilhado.
- Textos de estado vazio e de carregamento.
