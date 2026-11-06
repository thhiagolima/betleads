# Tutorial do CRM: fase 2 (plano de implementação)

> **Para agentes:** sub-skill obrigatória: superpowers:subagent-driven-development (recomendada) ou superpowers:executing-plans. Os passos usam checkboxes (`- [ ]`) para acompanhamento.

**Objetivo.** Escrever os artigos e os tours das telas da fase 2 (spec §5) usando a infraestrutura da fase 1, que já está em produção.

**Abordagem.** Cada tarefa segue sempre o mesmo ciclo:
1. reinventariar a tela pelo código;
2. marcar os elementos com `tourAnchor()`;
3. escrever o artigo em `src/help/screens/`;
4. registrar o artigo em `HELP_SCREEN_LOADERS`;
5. tirar a rota de `PENDING_ROUTES`.

O teste de cobertura (`src/help/-coverage.test.ts`) confirma a consistência.

**Stack.** TanStack Start/Router, React, Radix/shadcn, Supabase e vitest (só `renderToStaticMarkup`, sem jsdom). A fase não tem migração nem dependência nova.

**Spec.** `docs/superpowers/specs/2026-11-05-tutorial-crm-design.md`, em especial §2, §4.1, §4.2, §5 e §6. O plano da fase 1 (`docs/superpowers/plans/2026-11-05-tutorial-crm-fase1.md`) mostra a infraestrutura. Leia também `docs/AJUDA_MANUTENCAO.md`.

## Restrições globais

- **Público.** Gestores e admins das casas, sem formação técnica.
- **Cobertura.** Exigência do usuário: "nada fique de fora, nenhum elemento ou botão". Entram:
  - todo controle interativo, inclusive dentro de diálogos e gavetas;
  - todo estado vazio, de erro ou de bloqueio;
  - toda mensagem de erro visível ao usuário e os rótulos dos botões de confirmação, citados ao pé da letra (ruling R9 da fase 1).
- **Agrupamentos.** Controles que se repetem por linha são descritos uma vez. Números só de leitura (KPIs, gráficos, colunas) são explicados em grupo.
- **Texto.** pt-BR simples, em segunda pessoa e com frases curtas. Toda sigla é explicada na primeira vez que aparece. Os rótulos são os que aparecem na tela.
- **Âncoras.**
  - Formato `tela.seção.elemento`, em minúsculas e com hífen.
  - Sempre via `tourAnchor("…")`, com string literal.
  - Controles repetidos por linha recebem a âncora só no primeiro item.
  - Nunca escreva o atributo cru.
- **Tours.**
  - De 5 a 8 passos por aba (ou `default`) e só elementos visíveis.
  - Nunca abra diálogos e nunca troque de aba.
  - Abas quase só de leitura podem ter menos passos, mas âncoras não podem ser inventadas (ruling R10).
  - Telas com abas declaram `defaultTab` quando os tours são todos por aba.
- **`<Term>`.** Só em rótulos de verdade na tela, nunca dentro do texto dos artigos. Quando importar `<Term>` quebrar o teste de um componente, use um mock passthrough de `@/components/help/term`.
- **Fora de escopo.** Telas e partes só de super admin, e a área do Expert e de Grupo (fase 4).
- **Comportamento.** Não mude o comportamento das telas além de acrescentar âncoras e `<Term>`.
- **Verificação.** Rode no foreground:
  - `npx vitest run src/help src/components/help`, mais os testes de cada componente tocado;
  - `npx tsc --noEmit`;
  - `npm run lint` (0 erros);
  - `npm run build`.

## Foco da revisão

1. **Controles que só aparecem num estado.** Exemplos: casa sem integração, saldo zero, mensalidade vencida, jogador sem telefone. Esses controles também precisam de item no artigo.
2. **Diálogos de confirmação e importação.** O CSV de Consentimentos e "Adicionar pessoa" precisam ter os campos, os erros e os botões citados.
3. **Partes misturadas por papel.** Em `/tenants`, `/webhooks` e `/plano-e-creditos`, o que é só de super admin não entra, e o que é só de admin leva `roles: ["admin"]`.
4. **Desktop e celular.** A tabela de Jogadores e os cartões no celular exigem a âncora na versão visível. `pickVisible` cuida disso, mas a âncora precisa existir nas duas versões.
5. **Telas compartilhadas.** `/sms` e `/ligacoes` usam o shell `canal.*` e o `historico.*` da fase 1. Reutilize e cite essas âncoras em vez de duplicar.

---

## Procedimento comum de cada tarefa

1. **Reinventariar pelo código.** Leia o componente da rota e tudo o que ele renderiza: diálogos, gavetas e sub-diálogos. Liste cada controle, estado, aviso e mensagem de erro.
2. **Marcar com `tourAnchor()`.** Marque cada controle que o artigo citar com `anchor`. No mínimo, todos os controles usados nos tours.
3. **Escrever `src/help/screens/<id>.ts`.** Use `export default` de um `HelpScreen`, no mesmo nível de profundidade de `configuracoes-casa.ts`, que é a referência:
   - uma seção por bloco visual, com `tab` quando houver abas;
   - um item por controle, com `roles` quando o controle depender do papel;
   - `states` com os estados da tela;
   - `tours` por aba;
   - `terms` com os termos de jargão.
4. **Registrar.** Inclua a tela em `HELP_SCREEN_LOADERS` e tire a rota (ou `rota#aba`) de `PENDING_ROUTES`. Termos novos vão para `src/help/glossary.ts`.
5. **Verificar.** Rode as verificações das restrições globais.
6. **Commit.** Use `docs(ajuda): artigo e tour de <tela>`, com o trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
7. **Relatório.** Inclua a tabela de inventário (controle → item que o cobre).

### Task 1: Início e Eventos

- **Arquivos.** `src/help/screens/inicio.ts` (rota `/`) e `src/help/screens/eventos.ts` (`/eventos`).
- **Código.** `src/routes/index.tsx`, `src/components/home/*`, `src/routes/eventos.tsx`.
- **O que cobrir.**
  - O período, com os 6 atalhos e "Datas".
  - O aviso "Domínio X verificado" (admin).
  - O checklist "Configure sua casa", incluindo o estado "aguardando DNS".
  - Os 4 KPIs, com FTD e conversão explicados.
  - O gráfico "Depósitos e saques".
  - O cartão "Recuperado pelo CRM", com a regra do clique humano + depósito em até 7 dias.
  - As 5 métricas secundárias.
  - O "Ao vivo", com o link para Eventos.
  - Os estados de erro e de vazio.
  - Em Eventos: "Mostrar mais N", "Tentar novamente" e o estado vazio com "Abrir Integrações".
- **Termos.** `ftd`, PIX gerado/pago e "pp".

### Task 2: Jogadores e ficha do jogador

- **Arquivos.** `src/help/screens/jogadores.ts` (`/players`, abas `lista` e `acompanhamento`; confirme o hash) e `src/help/screens/jogador.ts` (`/players/$playerId`).
- **Código.** `src/routes/players.tsx`, `src/routes/players.$playerId.tsx`, `src/components/players/*`.
- **O que cobrir na lista.**
  - Cabeçalho: "Usar na campanha" e "Mais ações" (Exportar CSV e Copiar IDs).
  - KPIs.
  - Busca, chips de Situação e de Nível, e chips ativos com "Limpar tudo".
  - Seleção em massa.
  - A ordenação no celular.
  - As colunas, que ordenam a lista.
  - A paginação.
  - A gaveta "Mais filtros", inteira: período, comportamento E/OU, os 6 + 11 chips e as Oportunidades.
  - A aba Acompanhamento e as filas.
  - Os diálogos "Enviar WhatsApp para X" (que dependem de sessão conectada) e "Histórico de contatos".
- **O que cobrir na ficha.**
  - Todos os cartões.
  - O "Link rastreado", que só aparece com perfil de equipe.
  - O selo "Grupo de controle".
  - As notas de 0 a 100.
  - Os campos de UTM e de mídia.
  - A linha do tempo.
- **Termos.** `grupo-de-controle` e UTM.

### Task 3: Públicos

- **Arquivo.** `src/help/screens/publicos.ts` (`/publicos`, versão da casa; a versão do expert fica para a fase 4).
- **Código.** `src/routes/publicos.tsx`, `src/components/audiences/*`.
- **O que cobrir.**
  - O editor inteiro: os chips liga/desliga, "Escolhas incompatíveis se substituem", os campos de dias e a prévia ao vivo.
  - Os cards "Seus públicos" e o menu "…" (Editar, Duplicar, Excluir com a confirmação).
  - Os públicos automáticos.
  - "Usar em jornada".
  - O "Público de seleção".

### Task 4: SMS

- **Arquivo.** `src/help/screens/sms.ts` (`/sms`, abas `visao-geral`, `templates` e `historico`; confirme o hash).
- **O que reutilizar.** As âncoras e a descrição de `canal.*` (shell do canal) e de `historico.*`, já citadas em `email.ts`. Cite as mesmas âncoras.
- **O que cobrir.**
  - Os KPIs, com "Créditos disponíveis… dá para cerca de N SMS".
  - "Saúde do canal".
  - O painel de templates: "Novo template", o formulário com o contador de caracteres e de partes, os chips de link, "Editar" e o menu "…" (Duplicar, Arquivar ou Reativar).
  - Os estados.
- **Termos.** `segmento-sms` e GSM/UCS.

### Task 5: Voz (Ligações)

- **Arquivo.** `src/help/screens/ligacoes.ts` (`/ligacoes`, abas Visão geral, Envio em massa, Áudios e roteiros, Histórico; confirme o hash).
- **O que cobrir.**
  - O shell `canal.*` e o `historico.*`, reutilizados.
  - "Envio em massa": fonte, seleção, busca de jogadores, números avulsos, chips, resumo, "Disparar N ligações" com a confirmação e o último disparo.
  - A biblioteca de áudios: upload (formatos e limite de 50 MB), busca, filtros, play, editar, arquivar e excluir.
  - Os roteiros e o diálogo de roteiro, com as configurações de voz explicadas em linguagem simples (Estabilidade, Similaridade, Estilo, Velocidade, Speaker boost) e a prévia.
  - A "Fila de ligações", com as ações de cada linha.

### Task 6: Consentimentos e Configurações (Janela de envio)

- **Arquivos.** `src/help/screens/consentimentos.ts` (`/consentimentos`, abas Base, Registrar, Histórico, Limites de voz) e `src/help/screens/configuracoes.ts` (`/configuracoes`).
- **O que cobrir em Consentimentos.**
  - Base: busca e "Registrar decisão".
  - Registrar: cada campo, incluindo "Base legal" (LGPD) explicada.
  - Importação em lote: o formato CSV exato, com as colunas e os valores em inglês (`channel,subject,status,reason`, `revoked`/`granted`), um exemplo e os erros.
  - Histórico.
  - Limites de voz.
  - Exportar CSV.
- **O que cobrir em Janela de envio.**
  - "Configurar", Início, Fim e os 7 dias.
  - "Janela ativa".
  - Cancelar e Salvar.
  - O campo de fuso horário: explique o formato `America/Sao_Paulo` e dê exemplos comuns.
  - O link "Abrir Conta e equipe".
  - Os números só de leitura.
- **Termos.** LGPD e fuso horário.

### Task 7: Conta e equipe, e Plano e créditos

- **Arquivos.** `src/help/screens/conta-equipe.ts` (`/tenants`, só a visão de quem não é super admin; abas conforme o hash da rota) e `src/help/screens/plano-creditos.ts` (`/plano-e-creditos`).
- **O que cobrir em `/tenants`.**
  - "Atualizar" e os 4 cartões.
  - Visão geral.
  - Equipe: o diálogo "Adicionar pessoa", o papel por linha e o remover com a confirmação.
  - Saldo SMS.
  - Cobrança.
  - Relatórios.
  - Histórico, com o "ver detalhes" explicado.
  - Configuração: o Nome editável e os campos desabilitados, com o motivo.
  - Partes só de super admin: não entram.
- **O que cobrir em `/plano-e-creditos`.**
  - A mensalidade.
  - O diálogo Pix nos 5 estados (QR, Copia e Cola, contagem regressiva, expirado com "Gerar outro").
  - O saldo e "Comprar créditos" (pacotes, outro valor de R$ 100 a R$ 50.000, "Gerar Pix").
  - O alerta de saldo baixo.
  - As faturas e o comprovante.
  - Consumo do mês, preços vigentes e extrato.
  - Os estados de bloqueio.
- **Termos.** Pix Copia e Cola e franquia mensal.

### Task 8: Níveis e fidelização

- **Arquivo.** `src/help/screens/gamificacao.ts` (`/gamificacao`).
- **Cobertura de rotas.** Mova `/regras` de `PENDING_ROUTES` para `EXCLUDED_ROUTES`, porque ela só redireciona; confirme no código.
- **O que cobrir.**
  - A faixa dos 6 níveis, com "Ver jogadores" (hoje sem filtro: documente como funciona).
  - "VIPs que pararam".
  - "Quem mais depositou": busca, nível, ordenação, "Só quem parou" e paginação.
  - "Faixas e regras": os 5 limites, Esfriando e Dormindo, "VIP a partir de" e Salvar.
  - Os estados.

### Task 9: Integrações (Plataforma, Meta Ads, Web push)

- **Arquivo.** Amplie `src/help/screens/webhooks.ts` com as abas `plataforma`, `meta` e `webpush`, e tire `"/webhooks#plataforma"`, `"/webhooks#meta"` e `"/webhooks#webpush"` de `PENDING_ROUTES`.
- **Código.** `src/routes/webhooks.tsx`, `src/components/integrations/*` e `src/components/integrations/meta/*`, além dos componentes de Web push.
- **O que cobrir em Plataforma** (admin).
  - Os 4 cartões.
  - Os endereços de integração (os 14 eventos, os selos e os botões de copiar).
  - "Últimos recebimentos" com os status e o diálogo de detalhes.
  - "Segurança avançada", com a assinatura explicada para quem vai repassar ao desenvolvedor da plataforma.
- **O que cobrir em Meta Ads.**
  - O guia de 4 passos.
  - A chave do Usuário do Sistema.
  - Os cartões de conexão e o menu "…".
  - O painel lateral.
  - A seleção de contas com a barra "N alterações não salvas" e o diálogo "Sair sem salvar?".
  - O histórico.
  - "Montar marcação".
  - Explicar BM, Usuário do Sistema e UTM.
- **O que cobrir em Web push.** O assistente de integração e as configurações do aviso, em tudo que não for só de super admin.
- **Observação.** O tour de `plataforma` passa a existir, e `defaultTab` continua `plataforma`.

### Task 10: Revisão final da fase

- **Atualize `docs/AJUDA_MANUTENCAO.md`** se surgir algum padrão novo.
- **Rode a verificação completa:** `npm test` (a falha conhecida é a de `seed-demo-finance`), tsc, lint e build.
- **Faça a revisão final** da branch inteira.
