# Manutenção do tutorial do CRM (tour + painel de ajuda)

**Atualizado em:** 05/11/2026
**Para quem é:** quem (humano ou Claude) for alterar a UI do CRM depois da fase 1 do tutorial.

## A regra

**Toda mudança de UI atualiza o artigo da tela em `src/help/screens/` e marca os elementos novos com `tourAnchor()`.**

Isso vale para qualquer controle interativo novo, inclusive dentro de diálogos e gavetas. Se a tela ainda não tem artigo, ver "Telas novas" abaixo. O teste `src/help/-coverage.test.ts` é o que garante isso: ele falha sozinho se um artigo citar uma âncora que não existe no código, se existir uma `tourAnchor()` no código que nenhum artigo cita, ou se aparecer um `data-tour` escrito à mão fora de `src/help/anchor.ts`.

## Estrutura de `src/help/`

- **`types.ts`** — os tipos do conteúdo: `HelpScreen` (um artigo), `HelpSection`, `HelpItem`, `HelpState`, `TourStep`, `GlossaryTerm`. Dados puros, sem MDX, para o teste de cobertura conseguir percorrer tudo.
- **`screens/*.ts`** — um arquivo por artigo, cada um exportando um `HelpScreen` default (ex.: `screens/webhooks.ts`, `screens/shell.ts`). Cada artigo tem `sections` (os controles, agrupados), `states` (vazio/erro/bloqueio) e `tours` (um `TourStep[]` por aba, chave `"default"` quando a tela não tem abas). Tela com abas cujos tours são todos por aba (sem `"default"`) declara `defaultTab`: a aba que a rota mostra quando a URL não tem `#` (ex.: `"casa"` em `/configuracoes/casa`). Sem isso, a URL de entrada não acharia tour nenhum; com isso, `/configuracoes/casa` e `/configuracoes/casa#casa` usam o mesmo tour e a mesma chave de progresso (`effectiveTab`, em `resolve.ts`).
- **Abas na query string (`tabSearchParam`).** Por padrão a aba é o hash (`/configuracoes/casa#email`). Tela cuja rota guarda a aba num parâmetro de busca declara `tabSearchParam` com o nome do parâmetro — hoje `/resultados` (`"aba"`, `?aba=origens`), `/financeiro` (`"tab"`, `?tab=lancamentos`) e `/rendimento/equipe/$expertId` (`"aba"`, `?aba=campanhas`). O mesmo valor vai em `HELP_TAB_SEARCH_PARAMS` (`registry.ts`), porque `resolveHelpScreen` precisa dele antes de o artigo carregar; o teste de cobertura confere que os dois batem. Nessas telas: a aba vem só da query (o hash é ignorado); as chaves de `tours`, os `section.tab` e o `defaultTab` são valores que a rota aceita de fato (a lista da própria rota — `TABS` em `crm-results/search.ts`, `FINANCE_TABS` em `lib/finance/search.ts` — ou, sem lista exportada, a documentada no cabeçalho do artigo, como em `rendimento-pessoa.ts`); a chave de progresso continua `tour:<rota>#<aba>`, no mesmo formato; a busca e os guias navegam para `?param=aba` (`helpTabLocation`, em `resolve.ts`), não `#aba`; e trocar a query reavalia o tour como trocar o hash (a supressão do início automático e a visita — `claimAutoStart`/`autoStartVisitId` — seguem valendo, porque `location.key` muda com a query). Tela nova com abas na query: declare `tabSearchParam`, acrescente a rota em `HELP_TAB_SEARCH_PARAMS` e a lista de abas aceitas em `-coverage.test.ts`.
- **`guides.ts`** — os "Guias passo a passo" do painel (ex.: "Configurar o encurtador de links"). Cada `GuideStep` aponta para uma rota/aba/âncora e um `signal` (um booleano vindo do banco) que diz se o passo já foi concluído.
- **`glossary.ts`** — o `GLOSSARY`: um registro por termo/sigla (`id`, `term`, `short`, `long?`), usado pelo componente `<Term id="...">` (`src/components/help/term.tsx`) e por `screen.terms`.
- **`registry.ts`** — `HELP_SCREEN_LOADERS`: um `import()` por artigo, chaveado pela rota exata de `ROUTE_META` (`src/lib/navigation.ts`) ou por um id de `VIRTUAL_SCREENS`. É o único lugar que registra um artigo — sem entrada aqui, a tela não tem artigo nenhum, mesmo que o arquivo em `screens/` exista. O artigo carregado precisa ter `route` igual à chave (o painel só mostra o artigo quando `screen.route` bate com a rota resolvida): um mesmo artigo em duas rotas exporta uma cópia com a outra `route` (ex.: `editScreen` em `screens/jornada-editor.ts`, para `/jornadas/$journeyId`), com o mesmo `id` — a busca indexa cada `id` uma vez só — e `tourRoute` apontando para a rota original, para as duas rotas dividirem a mesma chave de progresso do tour (`screenTourKey`, em `tour-logic.ts`; sem `tourRoute`, a chave continua `tourKey(route, aba)`).
- **`coverage-config.ts`** — a classificação de toda rota de `ROUTE_META`:
  - `PENDING_ROUTES`: tela ainda sem artigo (com o motivo/fase em comentário). Pode ser a rota inteira ou `"/rota#aba"` para pendência só de uma aba/seção.
  - `EXCLUDED_ROUTES`: tela que nunca vai ter artigo (super admin, rota só de redirect, endpoint não-UI). Toda entrada aqui precisa ser uma rota real de `ROUTE_META`.
  - `VIRTUAL_SCREENS`: artigos sem rota própria (hoje `"onboarding"` e `"shell"`), carregados direto pelo painel.
  - `ANCHORS_PENDING_ARTICLE`: âncoras que já existem no código (`tourAnchor(...)`) mas nenhum artigo cita ainda — fica vazia na prática; só existe para uma janela curta entre criar a âncora e escrever o artigo.
- **`anchor.ts`** — o único lugar que escreve o atributo `data-tour`. `tourAnchor(id)` retorna `{ "data-tour": id }`. Nunca escreva `data-tour="..."` à mão em outro arquivo — o teste de cobertura proíbe isso.
- **`resolve.ts`** / **`search.ts`** / **`tour-runner.ts`** / **`tour-logic.ts`** — lógica de runtime (qual artigo carregar pela rota atual, busca do painel, execução do tour, início automático). Não precisam mudar quando só o conteúdo de uma tela muda.

## Âncoras (`tourAnchor`)

- Formato: `"<tela>.<secao>.<elemento>"`, tudo minúsculo, hífen dentro de cada parte (ex.: `"casa.email.dns-table"`).
- Sempre pelo helper `tourAnchor("...")`, nunca `data-tour` escrito na mão.
- Em controle que se repete por linha (lista, tabela), a âncora vai só no primeiro item/linha — não em cada repetição.
- O id precisa ser um **literal de string** na chamada (`tourAnchor("tela.secao.item")`), porque o scanner (`coverage-scan.ts`, regex `tourAnchor\("([^"]+)"\)`) lê o código-fonte como texto, não executa nada. Uma âncora montada com variável/template string não é detectada e o teste de cobertura vai achar uma âncora "fantasma" citada no artigo sem `tourAnchor()` correspondente.

## Como adicionar uma tela nova

1. Crie `src/help/screens/<nome>.ts` exportando um `HelpScreen` default (`title`, `purpose`, `roles`, `sections`, `states`, `tours` e, se a tela tiver abas, `defaultTab`).
2. Registre em `registry.ts`, em `HELP_SCREEN_LOADERS`, com a rota exata de `ROUTE_META` (ou o id de `VIRTUAL_SCREENS`, se não houver rota).
3. Remova a rota (ou a entrada `"/rota#aba"`) de `PENDING_ROUTES` em `coverage-config.ts`.
4. Em cada controle interativo da tela, aplique `tourAnchor("tela.secao.elemento")` nas props do elemento e cite a mesma âncora no `HelpItem.anchor` do artigo (e no `TourStep.anchor` do tour, se o passo usar esse elemento).
5. Se a tela ainda não vai ganhar artigo nesta rodada, adicione a rota em `PENDING_ROUTES` com um comentário explicando a fase/motivo — nunca deixe uma rota de fora das três listas (`HELP_SCREEN_LOADERS`, `EXCLUDED_ROUTES`, `PENDING_ROUTES`), o teste de cobertura falha.
6. Rode `npx vitest run src/help` e ajuste até fechar verde.

## O que cada regra de cobertura checa (`-coverage.test.ts`)

1. Toda rota de `ROUTE_META` tem artigo, está em `EXCLUDED_ROUTES` ou em `PENDING_ROUTES`.
2. Nenhuma rota está em duas dessas três listas ao mesmo tempo.
3. Toda âncora citada por um artigo/tour/guia existe de fato como `tourAnchor("...")` em algum arquivo de `src/`.
4. Todo `tourAnchor("...")` existente em `src/` é citado por algum artigo, tour ou guia (sem âncora "órfã").
5. Nenhum `data-tour="..."` escrito à mão fora de `src/help/anchor.ts`.
6. Todo `<Term id="...">` usado em componentes e todo `screen.terms` tem definição em `GLOSSARY`.
7. Todo tour tem entre 1 e 8 passos, e todo passo tem `anchor` e `body` não vazios.
8. `GLOSSARY` não tem ids duplicados.
9. Toda entrada de `EXCLUDED_ROUTES`/`PENDING_ROUTES` é uma rota real de `ROUTE_META` (não uma rota inventada ou já removida).
10. Todo artigo de `HELP_SCREEN_LOADERS` tem `route` igual à sua chave.
11. Tela (não virtual) cujos tours são todos por aba declara `defaultTab`; e todo `defaultTab` é a aba de alguma seção do artigo ou está pendente como `"/rota#aba"` em `PENDING_ROUTES` (ex.: `/webhooks`, `defaultTab: "plataforma"`, sem tour ainda — o botão do tour some nessa aba).
12. Tela com `tabSearchParam` tem o mesmo valor em `HELP_TAB_SEARCH_PARAMS` (e vice-versa), e cada chave de tour (fora `"default"`), cada `section.tab` e o `defaultTab` são valores que a rota aceita naquele parâmetro.

## Como rodar o teste

```
npx vitest run src/help
```

Rode isso sempre depois de tocar em `src/help/`, em qualquer `tourAnchor(...)` do app, ou em `ROUTE_META`. Se mudar algo em `src/components/help/` (painel, `<Term>`), rode também os testes da pasta:

```
npx vitest run src/help src/components/help
```

## `<Term>` nunca dentro das strings do artigo

`<Term id="...">texto</Term>` é um componente React, usado dentro de JSX de telas reais (`.tsx`). As strings dos artigos (`label`, `what`, `when`, `notes` em `HelpItem`) são texto puro, renderizado como texto — colocar `<Term id="...">` ali não vira um componente, aparece literalmente como `<Term...>` na tela. Para explicar uma sigla/termo num artigo, escreva o texto direto (a convenção do projeto já é explicar toda sigla na primeira aparição) ou cite o termo em `screen.terms` para ele aparecer no glossário do painel.

## Um "i" por rótulo

Um rótulo que já tem um tooltip de explicação ("i") — o `InfoTip` dos Resultados, o "Como calculamos" do Financeiro — não ganha `<Term>`: seriam dois "i" lado a lado explicando a mesma coisa. Nesse caso o id do termo fica só em `screen.terms` (aparece no glossário do painel). O teste de cobertura falha quando um `<Term>` aparece colado a um `<InfoTip>`.

Também não ponha `<Term>` dentro de um `<label>`/`<Label>` sem `htmlFor`: o `<Term>` é um botão e tomaria o rótulo do campo. Dê um `id` ao campo e `htmlFor` ao rótulo (o teste de cobertura também confere isso), e não ponha a âncora do seletor de período numa `div` em volta — passe `{...tourAnchor(...)}` ao próprio `CentralPeriodPicker`.

## Como testar um tour manualmente

1. Acesse a tela/aba que você alterou, logado como um usuário que nunca visitou essa tela/aba antes (ou limpe o progresso dele — ver `help_progress` no banco).
2. O tour deve iniciar automaticamente, passo a passo, parando em cada `tourAnchor`. Um passo cujo alvo está ausente ou invisível na hora deve ser pulado em silêncio, sem travar o tour.
3. "Pular tour" encerra o tour atual e não deve fazer o tour começar de novo sozinho na mesma tela/aba.
4. Repita a visita (recarregando a tela) — o tour não deve iniciar de novo automaticamente (início automático é só na primeira visita por tela/aba, por usuário).
5. Ligue "Não mostrar tours automaticamente" (no painel de ajuda) e visite uma tela/aba nunca vista — o tour não deve iniciar; o botão de iniciar manualmente (dentro do painel) continua funcionando.
6. Abra o painel de ajuda e confira: o artigo da tela carrega, a busca encontra o termo esperado (ex.: buscar "dominio" deve achar os artigos que citam DNS/domínio), e os guias mostram o progresso real da casa.
7. No celular, confira que o balão do tour aparece embaixo, em largura total, e que trocar de aba ou abrir diálogo nunca acontece sozinho por causa do tour.

## Teste manual (checklist)

Rodar na casa demo, no desktop e no celular, antes de considerar uma rodada do tutorial pronta para produção:

- [ ] O primeiro acesso a cada tela e aba da fase 1 inicia o tour automaticamente.
- [ ] "Pular tour" encerra o tour e ele não volta a iniciar sozinho depois.
- [ ] Ligar "Não mostrar tours automaticamente" desliga o início automático em **todas** as telas, não só na atual.
- [ ] O painel de ajuda abre, a busca encontra "dominio", e os guias mostram o progresso real da casa demo.
- [ ] Com a migração `20261203100000_help_progress.sql` **não aplicada** no ambiente: nenhum tour inicia sozinho (falha ao ler `help_progress` desliga o início automático) e o painel de ajuda continua funcionando normalmente (artigo, busca, guias).

## Migração pendente

A migração `supabase/migrations/20261203100000_help_progress.sql` ainda não foi aplicada em produção. Sem ela, o início automático dos tours fica desligado para todo mundo (por design — ver regra "Início automático" em `constraints.md`), mas o painel de ajuda funciona normalmente. Não aplique essa migração sem autorização explícita.
