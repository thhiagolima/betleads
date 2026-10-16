# Escopo — funil de conversão por campanha e jornada

**Data:** 08/10/2026  
**Status:** proposto para implementação  
**Objetivo:** cada campanha e cada jornada deve possuir um relatório próprio, de acesso direto, que apresente seu funil de conversão e receita atribuída.

## Resultado esperado

Ao abrir uma campanha ou jornada, o operador deve encontrar uma página de relatório com:

- funil visual horizontal, inspirado na referência aprovada;
- totais e taxas entre as etapas;
- recorte por canal e etapa da jornada;
- valor de depósitos aprovados e receita recuperada atribuídos;
- período, modelo de atribuição e data da última atualização visíveis;
- acesso simples a partir da listagem, sem procurar métricas numa tela global.

O relatório não deve atribuir conversões por suposição. Quando não houver vínculo determinístico, deve indicar que a conversão está fora da atribuição, em vez de inflar o resultado.

## Escopo funcional

### Funis padrão

Os funis são escolhidos conforme o objetivo e podem ser reduzidos quando uma etapa não se aplicar.

| Objetivo | Etapas do funil | Resultado de negócio |
| --- | --- | --- |
| Aquisição | Enviado → Entregue → Clique → Cadastro → Primeiro depósito aprovado | novos depositantes e valor de FTD |
| Conversão | Enviado → Entregue → Clique → Cadastro → Depósito aprovado | depósitos e receita atribuída |
| Reativação/recuperação | Enviado → Entregue → Clique → Login ou jogo → Depósito aprovado | depositantes recuperados e receita incremental |
| Jornada multietapa | Entrada → Envios por etapa → Cliques → Evento de saída/conversão → Depósito aprovado | conclusão, conversão e receita recuperada |

- **Enviado** é obrigatório para SMS/e-mail.
- **Entregue** só aparece quando o provedor tiver callback confiável; enquanto não existir, o relatório explicita que a etapa está indisponível.
- **Clique** é calculado por links rastreados individuais. Um destinatário conta uma vez por etapa/link, mesmo que gere vários cliques.
- **Cadastro, login, jogo, FTD e depósito aprovado** vêm dos eventos/webhooks já recebidos pela plataforma.
- Para voz não há clique; o relatório mostra entregas/atendimentos e conversões atribuídas por evento, sem inventar a etapa de link.

## Modelo de atribuição

### Regra inicial (P0)

O modelo será **último clique rastreado, determinístico, com janela de 7 dias**:

1. cada URL elegível recebe um `tracking_token` único por destinatário e envio;
2. o token é mantido no destino como `utm_content`;
3. cadastro ou evento recebido com esse token é vinculado ao respectivo `link_dispatch`;
4. a conversão pertence à campanha ou jornada indicada na origem do dispatch;
5. na ausência de token, não há atribuição direta; ela pode ser apresentada posteriormente como assistida, separada do resultado principal;
6. um mesmo evento de conversão só pode ser atribuído uma vez dentro da mesma regra/modelo.

A janela, o modelo e o fuso (`America/Sao_Paulo`) ficam explícitos no relatório. Alterações futuras de modelo não podem reescrever silenciosamente os valores históricos.

### Requisitos de dados

Será necessário criar uma camada de atribuição de conversões, por exemplo `conversion_attributions`, contendo:

- `tenant_id`, `source_type` (`campaign` ou `journey`) e `source_id`;
- `link_dispatch_id`, `tracking_token` e `player_id`;
- `event_type`, `event_id`, `occurred_at` e valor monetário quando aplicável;
- modelo/janela de atribuição, classificação (`direct` ou futura `assisted`) e timestamps de auditoria;
- chave única de idempotência para impedir dupla contagem de webhook/reprocessamento.

Também será necessária uma definição de funil por origem (`conversion_funnel_definitions` ou configuração equivalente), com objetivo, etapas habilitadas e janela de atribuição. O padrão pode ser aplicado automaticamente, mas a campanha/jornada deve manter seu snapshot para garantir histórico reproduzível.

## Estado atual e lacunas identificadas

| Capacidade | Estado atual | Lacuna a fechar |
| --- | --- | --- |
| Link individual por envio | Implementado para SMS e e-mail via Short.io | Tornar obrigatório quando a campanha/jornada declara CTA rastreável |
| Token e UTMs | Implementados no destino | Propagar e resolver o token nos eventos posteriores ao clique/cadastro |
| Cliques | Sincronizados em agregado pelo Short.io | Consolidar por destinatário/etapa e diferenciar clique de bot quando o dado estiver disponível |
| Campanhas de e-mail | `source_type=campaign` e `source_id=campaignId` | Criar agregação e tela de relatório |
| Campanhas de SMS | Origem usa texto de gatilho | Passar/persistir UUID da campanha como `source_id` estruturado |
| Jornadas | Origem e métricas básicas já existem | Agregar cliques e conversões por jornada, etapa e canal |
| Depósitos/FTD | Dados de player e depósitos existem | Vincular o evento recebido ao dispatch/token e preservar idempotência |
| Navegação | Listagens mostram cards e métricas resumidas | Criar rota própria de relatório e CTA “Ver relatório” |

## Navegação e experiência

### Campanhas

- Em cada card/linha de campanha, incluir **Ver relatório** como ação primária após a finalização do primeiro envio.
- Rota proposta: `/campanhas/$campaignId/relatorio`.
- Cabeçalho com nome, canal, status, período de envio, público, objetivo, janela de atribuição e botão de voltar.
- Abas: **Funil**, **Por canal/etapa**, **Envios** e **Conversões**.

### Jornadas

- Em cada card/linha da jornada, incluir **Ver relatório** ao lado de Editar.
- Rota proposta: `/jornadas/$journeyId/relatorio`.
- Funil geral e tabela por etapa: posição, canal, enviados, cliques, conversões, depósitos e receita.
- A tela de edição mantém o resumo atual, com link para o relatório completo; não deve virar um dashboard extenso.

### Princípios de UX

- O funil abre com valores absolutos e percentuais sobre a primeira etapa aplicável.
- Estados vazios explicam a causa: sem envio, sem link, sincronização pendente, callback indisponível ou sem conversões.
- Filtros mínimos: período, canal e etapa; filtros avançados apenas quando houver volume que os justifique.
- O usuário vê a origem dos números por tooltip/legenda, sem termos técnicos desnecessários.
- O link global “Links rastreados” permanece como diagnóstico técnico, não como substituto do relatório de uma origem.

## Prioridades de implementação

### P0 — integridade da atribuição e base navegável

1. **Normalizar a origem de todo envio rastreado.**
   - Adicionar `source_type` e `source_id` explícitos no caminho de envio SMS.
   - Garantir `campaignId` para campanhas SMS e e-mail e `journeyId` para toda etapa de jornada.
   - Critério de aceite: 100% dos novos dispatches de campanhas/jornadas têm origem UUID válida.

2. **Definir e persistir o funil da origem.**
   - Adicionar objetivo, etapas, janela de 7 dias e snapshot na criação/publicação.
   - Definir padrão por objetivo e impedir edição retroativa que altere resultados históricos.
   - Critério de aceite: todo novo item possui definição de funil reproduzível.

3. **Criar atribuição determinística de eventos.**
   - Resolver `utm_content`/token em cadastro, login, jogo, FTD e depósito aprovado recebidos por webhook.
   - Gravar `conversion_attributions` idempotentemente e respeitar tenant, player e janela.
   - Critério de aceite: teste ponta a ponta de link → cadastro → depósito produz uma única conversão e valor correto.

4. **Entregar as duas rotas de relatório.**
   - `/campanhas/$campaignId/relatorio` e `/jornadas/$journeyId/relatorio`.
   - Funil, números absolutos, percentuais, receita atribuída, data de atualização e estados vazios.
   - Critério de aceite: o relatório é alcançável em um clique a partir de cada listagem e respeita isolamento por tenant.

### P1 — qualidade analítica e operação

1. **Detalhamento de jornada por etapa/canal.**
   - Mostrar performance de cada régua: enviados, entregues, cliques, conversões e receita.

2. **Callbacks de entrega e qualidade de clique.**
   - Consumir entrega quando disponível e armazenar cliques humanos/bots quando o Short.io oferecer o dado.
   - Não exibir “entregue” como fato sem callback do provedor.

3. **Drill-down auditável.**
   - Listar destinatários/conversões com acesso controlado, link de origem, evento, timestamp e valor.
   - Permitir exportação CSV apenas com permissão adequada.

4. **Observabilidade de dados.**
   - Alertar sobre sync atrasado, webhook sem token, token sem dispatch, origem inexistente e divergência de contagem.

### P2 — evolução de produto

1. **Funis customizáveis por objetivo**, mantendo presets seguros.
2. **Comparação de campanhas/jornadas** com períodos equivalentes, canal e audiência.
3. **Atribuição assistida e multi-toque**, sempre separada da receita diretamente atribuída.
4. **Experimentação/A-B** por template, CTA, canal e etapa de jornada.
5. **Relatório executivo consolidado**, derivado dos relatórios individuais — nunca substituindo-os.

## Fora de escopo desta primeira entrega

- Declarar causalidade sem token/evento correlacionado.
- Atribuição de conversão por voz baseada em clique.
- Reatribuir automaticamente histórico que não possua token ou origem confiável.
- Alterar os valores de relatórios já emitidos quando a regra de atribuição mudar.
- Habilitar WhatsApp no Short.io sem validar canal, provedor e política de consentimento.

## Plano de entregas

| Fase | Prioridade | Entregável | Dependência | Evidência de aceite |
| --- | --- | --- | --- | --- |
| 1 | P0 | Origem estruturada em todos os dispatches | migrations e ajuste dos senders | inspeção de novos `link_dispatches` |
| 2 | P0 | Definição/snapshot de funil | modelo de campanha e jornada | criação e publicação preservam o snapshot |
| 3 | P0 | Atribuição de webhook e idempotência | token presente no payload de origem | cenário automatizado e evidência de banco |
| 4 | P0 | Relatórios próprios e atalhos de navegação | consulta agregada por origem | campanha e jornada navegáveis em um clique |
| 5 | P1 | Etapas, entrega, drill-down e alertas | callbacks de provedores | testes de regressão e operação validada |
| 6 | P2 | Comparativos, assistida e experimentos | base histórica suficiente | decisão de produto com dados reais |

## Critérios globais de aceite

- Isolamento absoluto por tenant em tabelas, consultas, rotas e exportações.
- Nenhum evento ou depósito é contado duas vezes após retry de webhook ou worker.
- Um relatório apresenta claramente período, modelo, janela e data de atualização.
- Um usuário sem dados de conversão entende por que o funil está vazio e qual ação tomar.
- Campanhas e jornadas existentes não quebram: aparecem como “dados históricos sem atribuição” até terem origem/rastreio compatível.
- Testes automatizados cobrem token, janela, último clique, idempotência, fronteira temporal e autorização.
- Migrations possuem rollback/documentação e nenhuma credencial ou PII é exposta no relatório.

## Decisões necessárias antes do início da Fase 3

1. Confirmar que o site/plataforma de destino devolve `utm_content` (ou equivalente) nos webhooks de cadastro, login e depósito.
2. Confirmar se o evento de conversão primário por objetivo será cadastro, FTD, qualquer depósito aprovado ou receita incremental.
3. Validar a janela inicial de 7 dias e o modelo “último clique rastreado”.
4. Definir quem poderá consultar o drill-down de jogadores e exportar dados.

