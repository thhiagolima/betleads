# Tutorial do CRM: tour guiado + painel de ajuda — design

Data: 2026-11-05 · Branch: `feat/tutorial-crm` (a partir de `origin/main` fece91b)

## 1. Por que

Boa parte dos usuários das casas (gestores, admins, experts) não tem conhecimento técnico. O caso que motivou isto: um gestor travou ao configurar o domínio e a campanha de e-mail e precisou chamar a equipe no WhatsApp. Esse padrão se repete em várias telas.

**Sucesso** é o usuário conseguir fazer as tarefas do CRM sozinho, sem chamar ninguém no WhatsApp. O pedido explícito é que o tutorial seja **muito detalhado e que nada fique de fora: nenhum elemento, nenhum botão**.

## 2. Objetivos, não-objetivos, antiobjetivos

**Objetivos**
- Toda tela real do CRM (fora as de super admin) tem um **artigo** que explica cada seção e cada elemento interativo: botões, campos, seletores, abas, filtros, chaves, diálogos e seus campos, estados vazios e mensagens de erro relevantes.
- Toda tela tem um **tour guiado** curto que apresenta as áreas principais.
- Há **guias passo a passo** para tarefas que atravessam várias telas, mostrando o progresso real da casa.
- Há um **glossário** dos termos de jargão, acessível também por um "i" ao lado do termo nas telas.
- O tutorial **se mantém atualizado**: um teste no build impede que uma tela ou um elemento marcado fique sem explicação.
- Corrigir na própria tela os pontos em que só texto de ajuda não resolve (seção 7).

**Não-objetivos**
- Telas e partes de super admin: `/admin`, `/grupos`, a seção Administração do menu, ProviderAuthBanner, o seletor "Ver:" do Financeiro, as partes de super admin de `/tenants` e "Domínios removidos".
- Rotas que só redirecionam: `/jornadas`, `/regras`, `/relatorios/conversao`, `/sms/templates`, `/creditos-sms`, `/automacoes/*`, `/links`, `/links/configuracoes`, `/experts/$expertId`.
- `/whatsapp`, que é inalcançável porque redireciona no `beforeLoad`.
- `/alertas` (Oportunidades), que não tem link em nenhum lugar.
- Uma página "Ajuda" no menu lateral, que foi descartada (o acesso é pelo "?" do cabeçalho).
- Vídeos.
- Ferramenta externa de conteúdo (CMS, Intercom etc.).

**Antiobjetivos** (o projeto fracassa se acontecer, mesmo funcionando)
- Usar jargão técnico sem explicar. O texto é para quem nunca ouviu falar em DNS.
- O tour atrapalhar o trabalho: aparecer de novo depois de dispensado, travar a tela ou não poder ser pulado.
- O conteúdo ficar desatualizado em relação à tela. Isso é pior que não ter conteúdo.
- O tour quebrar quando um elemento muda de lugar. Um passo cujo alvo não existe é pulado em silêncio e nunca dá erro na tela.
- Cobrir só os caminhos felizes e deixar de fora botões, diálogos ou estados.

## 3. Decisões do usuário

1. **Duas peças**:
   - **tour guiado na tela**, que escurece o fundo, destaca um elemento por vez e mostra um balão com texto simples, "Próximo", "Pular tour" e "Saiba mais";
   - **painel de ajuda lateral** com o artigo da tela.
2. **Um único "?" no cabeçalho** (`src/components/app-layout.tsx`, perto do seletor de casa e do menu da conta). Ele abre o painel lateral com:
   - **Nesta tela:** propósito, "Fazer o tour desta tela", "Ver todos os botões e campos" (o artigo completo, seção por seção).
   - **Guias passo a passo**, com o progresso real da casa ("2 de 4 feitos", "concluído ✓"). Guias que exigem admin aparecem como "só admin" para os outros perfis.
   - **Glossário** e **busca na ajuda**.
3. O **tour começa sozinho na primeira visita a cada tela** e depois só quando pedido. Esta foi uma proposta minha, e o usuário aceitou o desenho como estava. Isso vale **para todos os usuários, inclusive os que já usam o CRM**. No primeiro acesso depois do deploy, todos veem os tours, sem distinção entre usuário novo e antigo. A opção global "Não mostrar tours automaticamente" é a saída para quem não quer.
4. **Manutenção feita pelo Claude junto com cada mudança de código.** O conteúdo mora no repositório e vai para o ar no mesmo deploy da tela.
5. **Fase 1**: domínio (encurtador e e-mail), remetente, campanha de e-mail e **Jornadas** (o usuário destacou Jornadas como muito importante).

Os modelos aprovados estão em `docs/superpowers/specs/2026-11-05-tutorial-crm-mockups/`. Valem as peças 1 e 2 de `ajuda-formatos.html`; a peça 3, "Central de ajuda", foi descartada como página própria, e o conteúdo dela foi para o painel. O painel final está em `ajuda-header-v2.html`. Os modelos são referência visual, não especificação de pixel.

## 4. Como funciona

### 4.1 Conteúdo no repositório

Fica em `src/help/`, em TypeScript tipado (não MDX), para o teste conseguir validar tudo:

- `src/help/screens/<id>.ts`: um artigo por tela. Contém:
  - `route`: o padrão de rota, o mesmo de `ROUTE_META` em `src/lib/navigation.ts`;
  - `title` e `purpose`;
  - `roles`: quem vê a tela;
  - `sections[]`, cada seção com `items[]`. Cada item tem `anchor` (o valor de `data-tour`), `label` (o texto que aparece na tela), `what` (o que faz), `when` (quando usar), `notes?` (cuidados, erros comuns, o que acontece depois) e `roles?` (quando o item só aparece para alguns perfis);
  - `states[]`: estados vazios, de erro e de bloqueio, e o que fazer em cada um;
  - `tour[]`: os passos do tour, entre 5 e 8, cada um com `anchor`, `title` e `body`.
- `src/help/guides/<id>.ts`: guias multi-tela. Cada passo tem `route`, `anchor?`, o texto e `done(ctx)`, a regra que diz se o passo já foi feito na casa.
- `src/help/glossary.ts`: termo, definição curta e definição longa. Termos que já têm explicação no código devem ser reaproveitados e unificados:
  - `src/components/finance/definitions.ts` (o "Como calculamos" do Financeiro);
  - o "Como ler" de Resultados.

**Tom:** português simples, frases curtas, segunda pessoa ("você"). Cada sigla é explicada na primeira vez que aparece. Os exemplos usam os nomes reais da tela e valores plausíveis (por exemplo `mail.suacasa.bet.br`).

### 4.2 Âncoras nas telas

- Todo elemento descrito num artigo ganha `data-tour="<tela>.<seção>.<elemento>"`. Hoje não há `data-testid` em nenhuma tela, e os ids existentes são parciais, então não dá para depender deles.
- **Elementos que aparecem duas vezes:**
  - O seletor de casa e a tabela de Jogadores (versões de desktop e celular).
  - O tour mira a cópia **visível**: o primeiro elemento com a âncora que tenha caixa não vazia (`getClientRects().length`).
- **Conteúdo que abre fora da página** (diálogos, gavetas e popovers do Radix):
  - Os passos que explicam o que há dentro deles ficam só no artigo.
  - O tour não abre diálogo sozinho, salvo onde o passo diz explicitamente "clique em X". Nesse caso o tour espera o alvo aparecer, por até alguns segundos, e senão segue adiante.
- **Âncoras que variam por item da lista:** quando o elemento se repete por linha ("Remover" de cada remetente, por exemplo), a âncora vai só no **primeiro** item.

### 4.3 Tour

- **Biblioteca:** fica a critério de quem construir, desde que seja leve, sem dependência de framework e licenciada como MIT. A sugestão é `driver.js`; um componente próprio com Radix Popover também serve.
- **Visual:** tema escuro, como o resto do CRM (que só tem tema escuro).
- **Celular:** o tour funciona no celular. O balão fica embaixo, em largura total.
- **Primeira visita:** o tour inicia sozinho na primeira visita de cada usuário a cada tela, desde que:
  - não haja diálogo aberto;
  - não haja o onboarding em tela cheia (`OnboardingGate`, `z-50`). O tour não compete com ele: espera o usuário sair do onboarding.
- **Não se repete:** depois de concluído ou pulado, o tour daquela tela não inicia sozinho de novo. "Pular tour" vale só para a tela atual. Há também a opção "Não mostrar tours automaticamente", no painel, que vale para todas as telas.
- **Onde o estado fica guardado** (decisão minha): por usuário, **no servidor**, numa tabela nova `help_progress (user_id, key, status, updated_at)`. O motivo é que o gestor usa mais de um aparelho. O RLS segue o padrão das tabelas por usuário; ver a seção 8 para a migração.
- **Casa demo:** o tour também roda na casa demo.
- **Um tour por aba** (decisão minha): em telas com abas (`PageTabs`, hash na URL), cada aba tem o próprio tour. Ele começa na primeira vez que a aba é aberta. A chave de "visto" é `tour:<rota>#<aba>`. O tour nunca troca de aba sozinho. "Nesta tela" no painel mostra o artigo da tela inteira, já rolado até a seção da aba atual.
- **Onboarding** (decisão minha): o `OnboardingGate` aparece no lugar do layout, então o "?" do cabeçalho não está disponível nele.
  - O assistente ganha um "?" próprio no topo. Esse botão abre o mesmo painel, com o artigo do onboarding.
  - Cada passo do assistente (Casa, Encurtador, E-mail) tem um mini-tour próprio, que começa na primeira vez que o passo é exibido.
  - O provider de ajuda fica montado **acima** do `OnboardingGate`, para funcionar nos dois casos.
- **Sem migração aplicada, nada começa sozinho.** Enquanto `help_progress` não existir no banco, ou se a leitura falhar, o auto-start fica desligado. O tour e o painel continuam funcionando quando pedidos. Isso impede o tour de reaparecer em toda visita.

### 4.4 Painel de ajuda

- Abre ao clicar no "?" do cabeçalho:
  - no desktop, como `Sheet` à direita;
  - no celular, como bottom sheet.
- A seção "Nesta tela" é resolvida pela rota atual, com a mesma lógica de `ROUTE_META`/`patternMatches`.
- Cada item do artigo tem um link "mostrar na tela" que fecha o painel e destaca o elemento, quando ele está visível.
- **Busca:** é local, no próprio navegador, sobre títulos, rótulos, textos e glossário. Não precisa de backend.
- **Filtro por perfil:**
  - o painel mostra só as telas e os itens que o perfil logado enxerga;
  - os guias que exigem outro perfil aparecem com o rótulo "só admin" e não são escondidos.

### 4.5 "i" nos termos

Um componente `<Term id="ggr">GGR</Term>` mostra o termo com um "i" ao lado e abre a definição curta. O `InfoTip` existente (`src/components/crm-results/shared.tsx`) pode ser a base.

**Fase 1:** aplicar o `<Term>` nas telas da fase. Nas demais, conforme cada fase chega.

### 4.6 Guias e progresso

**Guias da fase 1:**
1. **Configurar o encurtador de links**: adicionar o domínio, colar os registros DNS, aguardar a verificação, definir como padrão.
2. **Enviar seu primeiro e-mail**:
   - adicionar o domínio de e-mail;
   - colar os registros DNS;
   - aguardar a verificação;
   - criar o remetente;
   - criar o template;
   - montar a campanha;
   - mandar um envio de teste antes.
3. **Criar sua primeira jornada**: gatilho, público e reentrada, etapas, saída, limites, ativar, acompanhar no relatório.

**Progresso:** `done(ctx)` lê o estado real da casa, por exemplo:
- domínio com status `verified`;
- remetente existente;
- template de e-mail publicado;
- campanha de e-mail enviada;
- jornada ativa.

Os dados vêm de uma server function nova, que agrega essas contagens da casa ativa e respeita o RLS. Os dados de domínio já existem em `computeSetupChecklist` (`src/lib/house-config.functions.ts`).

**Passos sem sinal no sistema** (decisão minha). Exemplos: "colar os registros DNS", as partes do editor de jornada que são salvas juntas, "acompanhar no relatório", e "envio de teste" caso não seja registrado à parte. O tratamento é:
- Cada guia é reescrito para que **cada passo contado** tenha um sinal real.
- Os passos sem sinal viram **subpassos explicativos** dentro de um passo com sinal. Por exemplo, "Colar os registros e aguardar" só conta quando o domínio fica verificado. "Montar a jornada", que inclui gatilho, público, etapas e saída, conta quando existe uma jornada salva.
- Um passo posterior concluído marca os anteriores como feitos.
- Não há marcação manual de passos.
- A contagem "N de M feitos" usa só os passos com sinal.

### 4.7 Conteúdo para registradores

Os guias de DNS explicam, em texto e passo a passo, onde colar os registros em:
- **Registro.br**;
- **Cloudflare**;
- **GoDaddy**;
- **Hostinger**.

Explicam também:
- o que significa "Nome" quando aparece `@` ou só o primeiro pedaço (por exemplo `go`);
- que a propagação pode levar horas;
- que a verificação automática roda a cada 10 minutos nas primeiras 6 horas, depois de hora em hora até 72 horas, depois diariamente (ver `isDomainDueForCheck` em `src/lib/house-config.ts`);
- o que fazer quando o status é "Falhou".

Prints dos registradores ficam fora da fase 1. O texto precisa se sustentar sozinho, e o modelo de conteúdo deve aceitar uma imagem opcional por passo.

## 5. Cobertura: inventário e regra de "nada fica de fora"

Um levantamento feito em 2026-11-05 sobre `origin/main` fece91b encontrou:
- **38 telas reais** fora do super admin;
- **cerca de 1.200 elementos interativos**;
- **mais de 100 diálogos, gavetas e popovers**.

Os números são aproximados. **O código é a fonte da verdade:** quem construir deve reinventariar cada tela a partir dos componentes ao escrever o artigo dela.

**Regra:** todo controle interativo de uma tela coberta tem um item no artigo, e isso inclui o que está dentro de diálogos e gavetas. Os controles que se repetem por linha são descritos uma vez.

Os textos só de leitura (KPIs, gráficos, colunas) são explicados em grupo, cada número com o que significa.

### Perfis
- **admin da casa**;
- **gestor e membro**, que têm o mesmo menu;
- **expert**, restrito ou total;
- **gestor de grupo**;
- **flags** `can_view_finance`, `has_team_profile` e acesso MCP.

O artigo marca os itens que só aparecem para alguns perfis. As áreas desabilitadas para não-admin também são explicadas: por que estão desabilitadas e a quem pedir.

### Telas por fase

- **Fase 1:**
  - Shell e cabeçalho: seletor de casa, indicador ao vivo, menu da conta, faixas de aviso.
  - O próprio "?".
  - Onboarding: o assistente de primeiro acesso.
  - `/configuracoes/casa`: abas Casa, Encurtador e E-mail, mais o diálogo "Trocar domínio nos links".
  - `/email`: Visão geral, Templates, os dois editores (Rápido e Avançado) e o diálogo "Gerar com IA".
  - `/campanhas`: hub, compositor "Nova campanha" nos três canais, "Envio de teste" e confirmação em massa.
  - `/campanhas/$id/relatorio`.
  - `/automacoes`: todas as abas, incluindo Fluxos de voz e os diálogos Pausar, Ativar e Limites.
  - `/jornadas/nova`, `/jornadas/$id` (editor) e `/jornadas/$id/relatorio`.
  - `/webhooks#links`: Links curtos.
- **Fase 2:**
  - Início, `/players`, `/players/$id`, `/publicos`, `/eventos`.
  - `/sms` (com Templates e Histórico), `/ligacoes`, `/consentimentos`.
  - `/configuracoes` (Janela de envio).
  - `/tenants` como "Conta e equipe".
  - `/plano-e-creditos`, `/gamificacao`.
  - `/webhooks` nas abas Plataforma e Meta Ads.
- **Fase 3:**
  - `/resultados`, `/resultados/comparar`, `/midia-ltv`, `/financeiro`.
  - `/rendimento`, `/rendimento/equipe`, `/rendimento/equipe/$id`.
  - `/inteligencia`, `/treino-ia`, `/experts`, `/mcp`, `/mcp/autorizar`.
- **Fase 4:**
  - Área do Expert: `/expert`, `/expert/leads`, `/expert/leads/$id`, `/expert/modelos`, `/expert/rendimento`, e as versões de expert de `/campanhas` e `/publicos`.
  - Grupo: `/grupo`, `/grupo/casa`, `/grupo/metas`, `/grupo/pessoas`.

**Fora da ordem das fases:** `/u/$token` é a página pública de descadastro, sem usuário logado, e não tem tour nem painel.

**A infraestrutura entra inteira na fase 1:** tour, painel, glossário, `help_progress` e o teste. A fase 1 só termina com o shell, as telas da fase e os 3 guias completos.

## 6. Teste de cobertura (manutenção)

Um teste vitest, `src/help/-coverage.test.ts`, que roda com `npm test` e falha quando:

1. **Uma tela fica sem artigo.** Toda rota com UI listada em `ROUTE_META` precisa ter um artigo, exceto as de uma lista explícita de exclusões: super admin, rotas que só redirecionam, `/whatsapp` e `/alertas`. Telas de fases futuras entram numa lista `pending` que vai diminuindo. Uma rota nova que não esteja no artigo, nas exclusões nem em `pending` quebra o build.
2. **Um passo aponta para nada.** Todo `anchor` citado em artigos, tours e guias precisa existir como `data-tour="..."` em algum arquivo de `src/`. A busca é estática, sobre o texto do código-fonte.
3. **Um elemento fica sem explicação.** Todo `data-tour` que existe no código precisa ser citado por algum artigo.
4. **Um termo fica sem definição.** Todo `<Term id>` precisa existir em `glossary.ts`.

O teste não consegue provar que um botão novo **sem** `data-tour` foi documentado. Por isso existe a regra de processo: uma nota em `docs/` e no prompt de trabalho diz que "toda mudança de UI atualiza o artigo da tela e marca os elementos novos com `data-tour`". Ela também fica registrada na memória do Claude como regra do projeto.

## 7. Ajustes nas telas (fase 1)

Esses ajustes são pequenos e evitam chamados que só texto de ajuda não resolveria:

1. **Tabela DNS:** mostrar o estado de cada registro (ok ou pendente). O dado `verified` por registro já é buscado e não é exibido.
2. **Erro do domínio** (`last_error`): mostrar destacado, não em cinza pequeno.
3. **Mostrar quando será a próxima verificação automática** no cartão do domínio ("Próxima verificação automática em ~10 min").
4. **"Definir como padrão" desabilitado:** tooltip "Disponível depois que o domínio for verificado".
5. **Domínio de e-mail verificado e sem remetente:** aviso com o passo seguinte, "Agora crie um remetente", que leva ao formulário.
6. **`/email` → "Domínio do remetente: Não configurado":** link para Configuração da casa → E-mail.
7. **"Remover remetente" sem confirmação:** adicionar confirmação.
8. **Campos desabilitados para não-admin em Configuração da casa:** uma linha explicando "Só o administrador da casa pode alterar. Fale com {admin}" (ou um texto genérico).
9. **Erro com a palavra "tenant"** ("Sem permissão para gerenciar este tenant"): trocar por "casa".

Achados fora da fase 1, para registrar e não fazer agora:
- os links "Ver jogadores" de Gamificação não filtram por nível;
- Configurar IA não tem como editar exemplo;
- o estado vazio do teste de controle diz "Jornadas", mas o menu diz "Automações";
- arquivar template de SMS não pede confirmação.

## 8. Restrições

- **Stack:** TanStack Start/Router, Radix/shadcn, Supabase. O CRM é só tema escuro. O layout do celular é real, com barra inferior e gaveta.
- **Bundle:** o conteúdo de ajuda é texto e pode crescer. O painel e os artigos devem ser carregados sob demanda (dynamic import por tela), para não pesar na primeira carga.
- **`npm run build` antes do merge:** o build pega vazamentos de `*.server` para o bundle do cliente que o typecheck não pega.
- **Migração de `help_progress`:**
  - aplicar no banco de produção **só com autorização explícita** do usuário;
  - usar o pooler `aws-0-ca-central-1`;
  - conferir antes a numeração das migrações existentes (já houve colisão; ver o commit fece91b).
- **Casa demo:** os botões de escrita ficam bloqueados (`DemoDisabledTooltip`), mas o tour e o painel funcionam normalmente.

## 9. Decisões que ficam com quem construir

- A biblioteca do tour (driver.js ou um componente próprio).
- A estrutura exata dos tipos em `src/help/` e o formato da âncora, mantendo o padrão `tela.seção.elemento`.
- O texto de cada artigo e de cada passo, dentro do tom da seção 4.1.
- O visual fino do painel e do balão, seguindo os modelos aprovados e o design atual do CRM.
- Como o tour espera um alvo que demora a aparecer.

## 10. Decisões minhas (para conferir)

- Estado do tour guardado no servidor (`help_progress`), não no navegador.
- "Pular tour" vale só para a tela atual, e existe uma opção global "Não mostrar tours automaticamente".
- O tour não abre diálogos sozinho. O conteúdo de dentro dos diálogos fica no artigo.
- Fase 1 sem prints dos registradores, só texto.
- Os ajustes de tela da seção 7 entram na fase 1.
- Um tour por aba, que nunca troca de aba sozinho.
- O onboarding tem "?" e mini-tours próprios.
- O progresso dos guias conta só passos com sinal real, sem marcação manual.
- O auto-start fica desligado enquanto `help_progress` não existir.
