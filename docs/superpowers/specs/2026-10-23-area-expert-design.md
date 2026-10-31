# Área do Expert — desenho

Data: 2026-10-23 · Status: aprovado (2026-10-23)

## 1. Intenção e porquê

O expert é uma pessoa que trabalha **para a casa** convertendo e reativando leads por conversa direta no WhatsApp dele (fora da plataforma), oferecendo bônus, descontos e cashback. Hoje o sistema só sabe "de quem é o lead" por um texto (`players.expert`) e, para dar login a um expert, cria uma casa separada (CRM_EXPERT) que recebe cópia dos leads. Não há métrica de rendimento, não há como o expert gerar um link rastreado para mandar no WhatsApp dele e não há como o admin comparar experts.

Queremos que o expert:
- entre no CRM da casa e veja **só os leads que pode ver e o próprio painel**, sem administrar nada da casa;
- gere, na ficha do lead, um **link encurtado e rastreado** a partir do link de bônus que ele criou no backoffice da casa, e mande pelo WhatsApp dele;
- tenha **fluxos e campanhas próprios**;
- tenha **rendimento medido** (cliques, depósitos atribuídos, reativações, FTD) que o admin vê e compara.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos**
- Papel "expert" dentro da casa, em dois tipos:
  - **Restrito:** vê só os próprios leads (os que chegaram pelos IDs de afiliado dele).
  - **Acesso total:** vê todos os leads da casa.
- Ficha do lead para o expert, com as 7 ações (seção 5).
- Atribuição de depósito ao expert (seção 6) e painéis do expert e do admin (seção 7).
- Campanhas e fluxos do expert, pagos pela casa, com consumo registrado por expert, modo livre ou com aprovação, e teto (seção 8).
- Aposentar o modelo de casa CRM_EXPERT (seção 9).

**Não-objetivos**
- Integrar com o WhatsApp do expert. A conversa acontece fora da plataforma; o CRM só abre o `wa.me` com o texto pronto.
- Gerar o bônus no backoffice da casa. O expert faz isso lá e cola o link no CRM.
- Pagar comissão ao expert. O sistema mede o rendimento e entrega o extrato (seção 7.1); quanto se paga fica fora do sistema.
- Carteira própria do expert. Quem paga é sempre a casa.

**Anti-objetivos (seria fracasso mesmo funcionando)**
- O expert restrito conseguir ver, por qualquer caminho (tela, export, API, IA), um lead que não é dele. A restrição tem que valer no banco (RLS), não só na tela.
- O expert conseguir mexer em algo da casa: configurações, integrações, saldo, jornadas da casa, campanhas de outros, usuários.
- O expert estourar o saldo da casa: o teto tem que bloquear de verdade, não só avisar.
- Crédito em dobro: um mesmo depósito contado para dois experts.

## 3. Restrições e contexto do sistema atual

- Ligação lead→expert hoje: o webhook lê o ID de afiliado do payload, procura em `experts (affiliate_id, nome, tenant_id)` e grava `players.expert` (texto) e `players.affiliate_id` (`src/lib/webhook-process.server.ts:151-170, 316, 380-384`). Não há `expert_id`.
- `app_role` hoje: `admin, user, super_admin, owner, member, gestor`. O acesso é por casa via `accessible_tenant_ids()` (`supabase/migrations/20261015090000_consolidate_tenant_rls.sql`). Não há filtro por pessoa dentro de uma casa.
- Tela `/experts` (`src/routes/experts.tsx`): CRUD de afiliado + nome. Está fora do menu desde a decisão do redesign ("Experts: oculto por enquanto").
- Rastreamento de links (Short.io): `createShortioLink`, `prepareTrackedText`, `tracked_links` e `link_dispatches` (`recipient_player_id`, `source_type`, `source_id`, `channel` ∈ sms/whatsapp/email). O clique passa por `/api/public/click/$token` e grava em `click_events`.
- Atribuição de conversão existente: `conversion_attributions` com modelo `last_tracked_click`, janela de 7 dias (direta) ou 14 dias (assistida), e `source_type` ∈ campaign/journey (`src/lib/conversion-attribution.server.ts`).
- Notas de contato existentes: `lead_followups (player_id, alerta_tipo, acao enum, notes, created_by)`, usado em `/alertas`.
- Consumo e cobrança: a casa paga SMS, voz e e-mail pelo saldo único (decisões de billing; consumo PG3 em `feat/pg3-consumo`).
- Variáveis `{expert}` e `{nome_expert}` já existem nos modelos de mensagem.
- Insights de IA por jogador já existem (`supabase/functions/ai-player-insights`).

## 4. Papel e acesso

- Existe um novo papel **expert** por casa, com um atributo de tipo: `restrito` ou `total`.
- O cadastro do expert liga: usuário (login) + casa + nome + tipo + lista de IDs de afiliado + modo de envio (livre ou com aprovação) + teto mensal + ativo/inativo.
- **Entrada:** o admin da casa convida por e-mail e escolhe o tipo. *(decisão minha)*
- **Expert restrito vê:** os leads cujo ID de afiliado está na lista dele.
- **Expert de acesso total vê:** todos os leads da casa.
- **Os dois tipos veem:** só os próprios links, notas, retornos, fluxos, campanhas e métricas. Não veem os de outros experts. Exceção: na linha do tempo do lead ele vê que outro expert tem o lead assumido (seção 5.5).
- A restrição vale no banco (RLS) e em todas as superfícies: listas, ficha, export CSV, busca, IA e server functions.
- **Menu do expert:** Início, Leads, Links, Fluxos e campanhas, Modelos de mensagem. Nada mais da casa.
- **Expert em mais de uma casa:** usa o seletor de casa do cabeçalho que já existe. *(decisão minha)*
- **Expert desativado:** perde o acesso na hora. O histórico dele (links, atribuições, consumo) continua nas métricas do admin.
- **Papel por casa:** *(decisão minha)* o papel é resolvido pela casa selecionada. A mesma pessoa pode ser admin na casa A e expert na casa B, mas não admin e expert na mesma casa. Todas as checagens de permissão, o menu e a RLS usam o papel da casa atual.
- **ID de afiliado:** *(decisão minha)* é único por casa. Dois experts não compartilham o mesmo ID; a migração do CRM_EXPERT avisa se houver colisão.
- **Registros atuais de `/experts` sem login:** *(decisão minha)* viram experts "sem acesso", com usuário vazio. Eles contam nas métricas e no crédito por afiliado e aparecem no ranking. O admin pode convidar depois, e o convite liga o login ao registro existente.

## 5. Ficha do lead (visão do expert)

**O que ele vê:**
- nome e telefone;
- origem (se veio pelo afiliado dele);
- nível do lead e selo de situação (ativo, em risco, inativo);
- dias sem depositar, total depositado, número de depósitos, ticket médio, último depósito (valor e data), total sacado;
- bônus e cashbacks já recebidos;
- **linha do tempo**: depósitos, links que ele enviou (com o clique), mensagens que a casa já mandou para o lead (campanhas e jornadas, para ele não repetir oferta), notas e retornos.

**As 7 ações (todas aprovadas):**

1. **Gerar link rastreado.** Ele cola a URL do bônus que gerou no backoffice e dá um nome à oferta ("Bônus 100%"). O sistema cria um link curto rastreado, ligado ao expert, ao lead e à oferta, e mostra um botão copiar. Cada geração é um envio próprio no rastreamento, com canal `whatsapp` e uma origem nova (ex.: `expert_manual`) identificando o expert.
2. **Abrir no WhatsApp com mensagem pronta.** Abre o `wa.me` do lead com o texto de um modelo do expert, com `{nome}`, `{link}` e as demais variáveis já preenchidas. O link usado é sempre o rastreado da ação 1.
3. **Registrar contato e resultado.** O expert marca um resultado (chamei, respondeu, prometeu depositar, sem interesse) e pode escrever uma nota livre. A marcação vai para a linha do tempo e para as métricas de contato. *(decisão minha: reaproveitar ou estender `lead_followups`)*
4. **Agendar retorno.** O expert escolhe a data e o lead aparece em "Para chamar hoje" no painel dele quando a data chega.
5. **Assumir o lead (só expert de acesso total).** Marca o lead como "em atendimento por Fulano" por um prazo. Enquanto isso, os outros experts veem o aviso. *(decisão minha: prazo padrão de 3 dias, configurável pelo admin; os outros podem continuar vendo e mandando, só são avisados, sem bloqueio)*
6. **Colocar num fluxo dele.** Inscreve o lead num fluxo ou campanha do expert, respeitando aprovação e teto.
7. **Sugestão de abordagem (IA).** Usa os insights de IA existentes para sugerir oferta e texto a partir do histórico do lead, restrito ao que o expert pode ver.

## 6. Regra de crédito (atribuição ao expert)

Um depósito aprovado conta para um expert por um destes caminhos:

1. **Clique:** o lead clicou num link rastreado do expert (gerado na ficha ou enviado por fluxo ou campanha dele) e depositou dentro da janela de clique.
2. **Afiliado:** o lead tem o ID de afiliado do expert, não há clique de nenhum expert dentro da janela e o depósito aconteceu **depois do cadastro do expert** no sistema. Os depósitos anteriores ao cadastro não contam e não há preenchimento retroativo do histórico. *(decidido pelo usuário)* Não há prazo a partir do cadastro do lead.

No ranking e nos painéis, o depositado atribuído aparece separado em **"por clique"** e **"por afiliado"**, além do total, para comparar de forma justa experts restritos e experts de acesso total.

**Desempates:**
- Clique recente vence afiliado.
- Entre experts, vence o último clique dentro da janela.
- Um depósito nunca conta para dois experts.
- *(adendo de 2026-10-30, rule_version 2 — `20261125100000_expert_hardening.sql`)* O clique de um expert não leva o depósito de um lead cujo ID de afiliado pertence a **outro** expert elegível no momento do depósito (o dono do afiliado fica com ele; só os cliques do próprio dono contam para esse lead). Os créditos guardam a versão da regra e o recálculo dos crons cobre só os últimos 8 dias, então créditos antigos mantêm a versão 1.

**Janela:** 72 horas por padrão, configurável por casa. *(o sistema atual usa 7 dias para campanhas e jornadas; a janela do expert é separada)*

**Relação com o crédito da casa:** se o mesmo depósito também cair numa campanha ou jornada da casa, o crédito do expert não apaga o da casa. São visões diferentes (rendimento do expert × resultado do CRM). *(decisão minha)*

**Métricas derivadas, por expert e período:**
- links gerados e cliques;
- leads contatados (pelas notas);
- leads que depositaram e total depositado atribuído;
- **reativações:** depósito de lead que estava há N dias sem depositar. *(decisão minha: usar o mesmo critério de "em risco/inativo" que a casa já usa)*
- **FTD:** primeiro depósito da vida do lead;
- consumo (seção 8) e retorno = depositado atribuído ÷ consumo.

**Implementação:** *(decisão minha)* estender o mecanismo existente de atribuição (`conversion_attributions` / `last_tracked_click`) com origem expert, em vez de criar um motor paralelo.

## 7. Painéis

**Início do expert** (só os números dele; filtro de período, padrão 30 dias):
- cartões: depositado atribuído, reativados, FTDs, cliques/links;
- **Para chamar hoje:** retornos agendados para hoje, leads dele que entraram em risco, leads que clicaram no link dele e não depositaram nas últimas 24h;
- **Meu consumo:** usado × teto no mês e campanhas aguardando aprovação.

**Tela Experts do admin** (volta ao menu na área de admin):
- ranking por período com tipo, depositado, reativações, FTD, cliques, consumo e retorno;
- botão de convidar expert;
- **ao abrir um expert:**
  - os mesmos números do painel dele, com evolução por dia;
  - configuração: tipo, IDs de afiliado, modo de envio, teto, prazo de "assumir";
  - fila de aprovação das campanhas dele;
  - atividade: links, contatos e leads assumidos;
  - desativar.

Os mockups estão em `.superpowers/brainstorm/` (`ficha-lead-expert.html`, `paineis-expert-admin.html`).

### 7.1 Perfil de rendimento para membros da equipe (adendo de 2026-10-27)

Há gestores que também convertem conversando direto com os leads. Eles vão passar a ser comissionados sobre o rendimento, com a comissão paga por fora do sistema. Por isso:

- **O perfil de rendimento fica separado do papel de acesso.** O admin cria um perfil na tela Experts e o vincula a alguém da equipe (admin, gestor ou membro), em vez de convidar. A pessoa continua com o papel dela. O perfil só mede e não muda o acesso.
- **Link rastreado na ficha da casa.** Quem tem perfil vinculado ganha, na ficha do jogador da casa, o botão "Gerar link rastreado". O crédito segue a mesma regra da seção 6.
- **No ranking,** essas pessoas aparecem como "Equipe (gestor)" (ou o papel delas), junto dos experts.
- **Base da comissão: total depositado** pelos leads creditados no período. O sistema não calcula o valor da comissão.
- **Extrato de créditos por pessoa e período,** exportável em CSV, com uma linha por depósito: data, lead, valor, por clique ou afiliado, oferta do link e hora do clique. Serve para conferir e defender a comissão.
- **Estabilidade:** cada crédito guarda a janela e a versão da regra usadas. Recálculos só alcançam os últimos 8 dias. Um perfil com créditos não pode ser excluído, só desativado, para não apagar histórico de comissão.

## 8. Campanhas e fluxos do expert

- O expert usa os mesmos editores de campanha e fluxo da casa. O que ele cria fica com ele como dono.
- **Entidades na v1:** *(decisão minha)* campanhas de SMS (`sms_campaigns`), campanhas de e-mail (`email_campaigns`), fluxos de SMS (`sms_flows`) e fluxos de e-mail (`email_flows`). Ficam de fora as jornadas (`journeys`), os fluxos de ligação (`call_flows`) e os `flows` genéricos. Quem implementar deve confirmar quais editores a casa usa hoje para fluxo de SMS e e-mail e aplicar o dono só neles.
- **Aprovação de fluxo:** *(decisão minha)* o fluxo é aprovado quando é ativado. Se o expert editar um fluxo ativo, ele volta para "aguardando aprovação" e fica pausado até o admin aprovar. Envios individuais não passam por aprovação. Campanha avulsa é aprovada antes do disparo.
- **Modelos de mensagem:** *(decisão minha)* o expert vê e edita os modelos dele e vê os modelos da casa só para leitura, com a opção "copiar para os meus".
- **Público:** só leads que ele pode ver. O restrito manda para os leads dele; o de acesso total, para qualquer lead da casa.
- **Quem paga:** a casa, pelo saldo dela. Cada envio registra o expert dono, e o consumo por expert vira métrica.
- **Modo, por expert, definido pelo admin:**
  - **livre:** dispara direto;
  - **com aprovação:** a campanha fica pendente até o admin aprovar ou recusar.
- **Preço usado no teto e no consumo:** *(decisão minha)* o preço que a casa paga (o preço de venda cobrado do saldo dela), não o nosso custo. A checagem do teto fica dentro do caminho de cobrança. A fase 4 é construída depois do merge do `feat/pg3-consumo`. Se esse merge atrasar, a fase 4 sai só com SMS.
- **Teto:** valor em reais por mês, somando todos os canais. *(decisão minha: mensal, em R$, somando todos os canais)* Ao atingir o teto, novos envios do expert são bloqueados até o mês virar ou o admin aumentar o teto, e o admin é avisado. Envios já em andamento num fluxo também param no teto.
- O admin vê, pausa e arquiva qualquer campanha ou fluxo de expert.
- O expert não vê nem edita as jornadas, campanhas e fluxos da casa.
- **Canais:** *(decisão minha)* SMS e e-mail na primeira versão. Voz fica para depois.
- Os links nas mensagens do expert são rastreados com a origem dele, então os cliques contam para a regra de crédito da seção 6.

### 8.1 Adendo de 2026-10-30 (entrega da fase 4)

Decisões do dono do produto que substituem partes desta seção. O registro completo está em `docs/superpowers/plans/2026-10-30-area-expert-fase4.md`.

- **Voz entra** junto com SMS e e-mail.
- **Fluxos saem** desta entrega: `sms_flows`, `email_flows`, aprovação na ativação, "parar fluxo no teto" e a ação 6 da ficha ("colocar num fluxo dele"). Os itens acima sobre fluxos ficam sem efeito até uma decisão nova.
- **Telas:** o expert usa as mesmas `/publicos` e `/campanhas` da casa, adaptadas ao papel, em vez de "Fluxos e campanhas" com editores próprios.
- **Públicos do expert:** ele cria públicos próprios dentro do escopo dele. O expert total também usa os públicos salvos da casa, só leitura; o restrito usa só os dele.
- **Teto:** vazio = sem teto; 0 = bloqueia os envios. O aviso ao admin é por e-mail, um por expert por mês.
- **Conteúdo:** livre, mas todo link precisa ser do site da casa ou de um domínio liberado pelo admin; sem lista configurada, link externo é recusado. O expert não manda para telefone, e-mail avulso ou lista externa.
- **Modo de envio:** continua por expert, sem padrão da casa.

## 9. Aposentar a casa CRM_EXPERT

- Para cada casa CRM_EXPERT, os IDs de afiliado em `metadata.expert_affiliate_ids` viram o cadastro de expert (restrito) na casa de origem, ligado ao usuário que hoje é admin da casa CRM_EXPERT.
- Os leads já existem na casa de origem (a casa CRM_EXPERT recebia cópias), então não há migração de leads.
- A cópia automática (`expertMirrorTargets` e o bloco de espelhamento em `webhook-process.server.ts`) é desligada.
- **Fluxos da casa CRM_EXPERT:** são recriados como fluxos do expert na casa de origem *(decisão minha)*. Os gatilhos ficam iguais (`lead_cadastrado`) e o público fica restrito aos leads dele.
- A casa CRM_EXPERT é arquivada: fica só leitura e deixa de rodar workers e envios. Ela não é apagada.
- A opção CRM_EXPERT sai do seletor de modelo de casa para novas casas.

## 10. Ordem de entrega sugerida

1. **Papel e acesso:** papel expert, cadastro e convite, RLS por tipo, menu do expert, tela Experts do admin (configuração), aposentadoria do CRM_EXPERT.
2. **Ficha do lead:** dados, linha do tempo e as 7 ações (link rastreado, WhatsApp, contato, retorno, assumir, fluxo, IA).
3. **Crédito e painéis:** regra de atribuição, painel do expert, ranking e detalhe no admin.
4. **Campanhas e fluxos do expert:** dono, público restrito, aprovação, teto, consumo por expert. *(Entregue em 30/10/2026 sem os fluxos; ver §8.1.)*

## 11. Deixado para quem implementar

- Modelo exato do banco: tabela de expert ligada a usuário, como o papel entra em `user_roles`/RLS, coluna de dono nas tabelas de campanha e fluxo, dimensão expert em `link_dispatches` e no consumo.
- Se `players.expert` (texto) vira `expert_id` com FK ou se permanece derivado do afiliado.
- Como a RLS do expert restrito se combina com `accessible_tenant_ids()` sem degradar a performance das listas de jogadores.
- Layout final das telas (seguindo o shell do redesign).
- Textos e estados vazios.
