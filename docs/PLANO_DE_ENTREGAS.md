# Plano de entregas do Betleads

Este é o checklist operacional do projeto. Use `[x]` ao finalizar uma entrega e mantenha uma nota curta com a evidência: rota testada, migration aplicada, PR/commit ou cenário validado.

Legenda: `[x]` concluído · `[ ]` pendente · `[~]` em andamento ou parcialmente entregue.

## Prioridade 0 — Confiabilidade dos dados

- [~] **Webhooks financeiros completos**
  - Norte: normalizar eventos de cadastro, login, depósito, saque, cashback e seus estados (`pendente`, `aprovado`, `recusado`, `estornado`). Salvar o payload bruto, o evento normalizado e o resultado do processamento por conta.
  - Validar: enviar um payload de cada tipo, repetir o mesmo `eventId` e confirmar que não duplica valores nem jogadores.

- [~] **Idempotência e recuperação de falhas de webhook**
  - Norte: toda gravação deve usar a chave única do provedor/evento; erros devem entrar em uma fila reprocessável, sem derrubar o endpoint.
  - Validar: consultar logs de webhook, simular timeout/duplicidade e reprocessar uma falha sem criar dados duplicados.

- [~] **Reconciliação de dados da casa**
  - Adiada por decisão do produto em 03/10/2026; nenhuma escrita de sincronização foi aplicada.
  - Norte: importar e sincronizar a exportação da pasta `base` com Players, depósitos e saques; gerar relatório de registros ausentes, divergentes e duplicados antes de qualquer escrita definitiva.
  - Validar: comparar totais, usuários únicos, depósitos e saques por período contra a origem.

- [ ] **Correção de divergências de métricas**
  - Norte: consolidar uma fonte de verdade para cadastro, FTD, depositantes, valor depositado, saque e redepósito; dashboards e relatórios devem consumir as mesmas regras.
  - Validar: comparar Hoje, 7 dias e 30 dias contra a fonte da casa para uma conta de teste.

## Prioridade 1 — Automação segura e útil

- [~] **Central de réguas e criação inicial**
  - Norte: a central lista réguas de SMS e e-mail; o modal cria um rascunho com nome, canal e gatilho e abre o editor correspondente desligado.
  - Validar: em `/automacoes`, criar rascunho SMS/e-mail, confirmar o preenchimento do editor e verificar que cancelar não cria uma régua.

- [~] **Editor de régua SMS**
  - 03/10/2026: validação, teste controlado, limite diário e cooldown por régua implementados; aguarda migration aplicada e cenário com destinatário autorizado.
  - Norte: simplificar o editor para gatilho, público, mensagens, esperas, saída, janela de envio, limite diário, cooldown, prévia e teste controlado.
  - Validar: criar uma régua inativa, salvar, testar em um destinatário autorizado e conferir a fila e o log.

- [~] **Editor de régua de e-mail**
  - 03/10/2026: construtor limitado a blocos executáveis (enviar, espera e encerramento); preserva template, remetente, prévia e teste. Aguarda validação com SMTP autorizado.
  - Norte: deixar visíveis apenas blocos que o motor realmente executa; suportar template, remetente, espera, saída, teste e prévia.
  - Validar: criar e-mail de teste, conferir SMTP/remetente, envio, abertura/clique quando disponível e log da régua.

- [~] **Elegibilidade única para SMS e e-mail**
  - 03/10/2026: entrada do orquestrador passou a centralizar contato inválido e opt-out de e-mail; lista de opt-out de SMS e motivo `sms_opt_out` foram preparados em migration.
  - Norte: centralizar opt-out, contato inválido, consentimento, cooldown, limite diário, saída por conversão e motivo de bloqueio.
  - Validar: testar cada bloqueio e garantir que SMS e e-mail exibam o mesmo motivo de não elegibilidade.

- [ ] **Fila, cron e reprocessamento por conta**
  - Norte: exibir fila por régua, última execução, falhas, tentativas, itens bloqueados e reprocessamento idempotente; o cron deve processar apenas a conta correta.
  - Validar: pausar uma régua, criar itens elegíveis, retomar, processar e acompanhar cada transição na tela de saúde.

- [ ] **Jornadas multicanal reais**
  - Norte: permitir uma mesma régua combinar SMS e e-mail em sequência, preservando saídas e cooldown globais.
  - Validar: criar SMS → espera → e-mail e confirmar que conversão/opt-out encerra a jornada inteira.

- [ ] **Métricas e atribuição de automações**
  - Norte: consolidar enviados, entregues, falhas, respostas, saídas, conversões, depósitos recuperados, custo e retorno por régua/canal.
  - Validar: confrontar logs de envio e depósitos atribuídos em um período fechado.

## Prioridade 2 — Segmentação e CRM

- [~] **Públicos e Gamificação integrados**
  - Norte: níveis configurados na Gamificação já são públicos prontos; públicos salvos podem ser usados em campanhas e respeitam a conta atual.
  - Validar: criar público por nível/situação, usá-lo em uma campanha e conferir a estimativa de jogadores.

- [~] **Contadores de filtros contextuais em Players**
  - Norte: contadores avançados consideram situação e nível selecionados; por exemplo, VIP dentro de `Esfriando + Ouro` não pode exceder o tamanho desse recorte.
  - Validar: em `/players` → `Mais filtros`, combinar situação e nível e conferir os contadores em até 30 segundos.

- [ ] **Filtros de comportamento combináveis**
  - Norte: substituir o único campo de filtro por regras compatíveis combináveis (AND/OR), impedir combinações impossíveis e recalcular a estimativa antes de aplicar.
  - Validar: combinar nível + situação + saldo + atividade e comparar a estimativa com a tabela final.

- [ ] **Contadores contextuais completos**
  - Norte: fazer busca, período e regras de comportamento também influenciarem todos os contadores; o próprio chip não deve ser aplicado ao contar alternativas exclusivas.
  - Validar: alterar busca/período/comportamento e confirmar que os valores mudam sem ultrapassar o recorte atual.

- [ ] **Redução de cálculos de alertas no navegador**
  - Norte: mover filtros locais de alertas para consultas/RPCs paginadas no servidor, sem carregar a base completa no browser.
  - Validar: abrir cada alerta operacional em bases grandes e medir tempo/memória no navegador.

## Prioridade 3 — Canais e campanhas

- [~] **Arquitetura de Campanhas e Canais**
  - Norte: Campanhas é a entrada omnichannel e também concentra o envio individual; `/sms` e `/email` são telas de saúde, histórico e relatórios do canal.
  - Validar: criar campanha e envio individual a partir de Campanhas; conferir que SMS e e-mail mostram status e histórico sem duplicar o construtor.

- [ ] **Fechamento do escopo de SMS**
  - Norte: concluir saúde do provider, créditos, fila, histórico, falhas, reenvio, opt-out, variáveis permitidas, custo e relatório de campanha.
  - Validar: executar envio individual e em massa com provedor autorizado, conferir variável renderizada, entrega, falha e opt-out.

- [ ] **Fechamento do escopo de e-mail**
  - Norte: concluir saúde SMTP, remetentes, templates, histórico, falhas, reenvio, descadastro e relatório de campanha.
  - Validar: envio de teste, descadastro e tentativa posterior bloqueada.

- [ ] **Relatórios de campanha**
  - Norte: mostrar público inicial, elegíveis, bloqueados por motivo, enviados, entrega, abertura/clique quando disponível, conversão, custo e receita atribuída.
  - Validar: comparar os totais com logs do canal e eventos financeiros do período.

## Prioridade 4 — Meta, mídia e LTV

- [~] **Base de conexão Meta por conta**
  - Norte: substituir o app compartilhado por credenciais/token do app pertencente à própria conta Meta; armazenar token criptografado e isolado por conta.
  - Validar: conectar duas contas diferentes e garantir que nenhuma lista contas/anúncios/gastos da outra.

- [ ] **Fluxo completo de conexão Meta**
  - Norte: orientar criação do app, permissões, token, conta de anúncio, seleção de ativos e diagnóstico de acesso/gasto indisponível.
  - Validar: conectar uma conta nova, listar ativos e importar gasto sem uso de app do CRM.

- [ ] **Sincronização e reconciliação de mídia**
  - Norte: sincronizar investimento e métricas por conta/anúncio/criativo, registrar última sincronização e evidenciar falhas de permissão ou cobertura.
  - Validar: comparar gasto diário do painel com Ads Manager em um período fechado.

- [ ] **Atribuição de aquisição e LTV**
  - Norte: vincular origem/UTM/criativo aos eventos de cadastro e depósito, deixando clara a cobertura e os dados sem marcação.
  - Validar: rastrear uma amostra de jogadores da URL até criativo, FTD e receita.

## Prioridade 5 — Segurança, desempenho e operação

- [~] **Isolamento por conta e superadmin**
  - Norte: políticas, RPCs e ações de servidor devem sempre resolver a conta operacional; superadmin pode alternar e consultar todas as contas com auditoria.
  - Validar: testar usuário comum, gestor, admin e superadmin em Players, Públicos, Campanhas, Webhooks, Automação e Meta.

- [ ] **Revisão final de RLS e funções privilegiadas**
  - Norte: auditar tabelas, views, RPCs e endpoints service-role, removendo qualquer possibilidade de leitura/escrita cruzada entre contas.
  - Validar: testes negativos com IDs de outra conta e revisão de logs/auditoria.

- [~] **Cache inicial de consultas**
  - Norte: consultas de leitura usam cache por conta e recorte, com invalidação por eventos relevantes.
  - Validar: abrir telas repetidamente, verificar queda de chamadas e confirmar atualização após webhook/importação.

- [ ] **Otimização de banco e consultas lentas**
  - Norte: revisar RPCs lentas, índices compostos por `tenant_id`/data/status, paginação e consultas que percorrem grandes tabelas; reduzir Disk IO.
  - Validar: medir as consultas mais lentas no Supabase antes/depois e manter latência aceitável sob carga.

- [ ] **Saúde operacional centralizada**
  - Norte: uma tela para cron, filas, webhooks, SMS, SMTP, Meta, falhas recentes, atrasos e ações de recuperação.
  - Validar: simular indisponibilidade de cada integração e conferir alerta e orientação de recuperação.

## Prioridade 6 — UX e acabamento

- [~] **Sidebar, navegação e estados de conta**
  - Norte: estrutura principal reorganizada e sidebar fixa; manter apenas entradas que representem funcionalidades operacionais.
  - Validar: revisar navegação em desktop, telas menores e perfis sem permissão.

- [ ] **Limpeza de rotas e itens sem operação**
  - Norte: esconder ou identificar como indisponíveis WhatsApp e Ligações enquanto não possuírem motor, fila, saúde e relatório próprios.
  - Validar: nenhum menu deve levar a uma tela sem ação ou com dados fictícios.

- [ ] **Estados de carregamento, vazio e erro padronizados**
  - Norte: usar skeleton, estados vazios, toasts e dialogs do sistema; não usar `alert()`/`confirm()` nativos.
  - Validar: desligar uma integração, esvaziar uma lista e forçar erro de rede em cada área principal.

- [ ] **Barras de rolagem e responsividade**
  - Norte: aplicar o padrão visual de scrollbar em toda a aplicação e revisar tabelas, modais e drawers em tamanhos menores.
  - Validar: navegar por Players, Públicos, Campanhas, SMS, E-mail e Integrações em desktop e mobile.

## Como encerrar um item

Antes de marcar como concluído:

1. Validar o cenário funcional descrito no item.
2. Validar isolamento por conta quando houver leitura ou escrita de dados.
3. Aplicar a migration, se existir, e registrar que foi aplicada.
4. Executar build e reiniciar o projeto.
5. Acrescentar abaixo do item uma nota curta com data, commit e resultado do teste.
