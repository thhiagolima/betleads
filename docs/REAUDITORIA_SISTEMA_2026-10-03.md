# Reauditoria do Betleads — 03/10/2026

## Objetivo deste documento

Este arquivo é o ponto de continuidade do projeto. Ele compara a auditoria inicial com o estado atual, separa o que está entregue do que ainda precisa ser validado e organiza os próximos trabalhos por prioridade.

> Regra de status: código existente não equivale a entrega concluída. Um item só é concluído após migration (quando houver), build, reinício, teste funcional e teste de isolamento por conta.

Legenda: `[x]` concluído e validado · `[~]` implementado parcialmente ou aguardando validação · `[ ]` pendente.

## Leitura executiva

O sistema deixou de ser um conjunto de telas desconectadas e ganhou uma base de multi-conta, públicos, gamificação, campanhas e automações. Ainda não deve ser tratado como pronto para operação plena: há riscos relevantes em ingestão financeira, conciliação de métricas, performance do banco, execução real de canais e validação final de segurança.

O foco daqui em diante não deve ser criar novas telas antes de estabilizar dados, jobs, integrações e observabilidade.

## Situação do repositório no momento da auditoria

- Histórico principal contém entregas até a correção de contadores contextuais de Players.
- Há alterações locais em andamento e ainda não confirmadas como commitadas/aplicadas:
  - atualização de métricas de dashboard por intervalo;
  - limites diários, cooldown e delays de SMS;
  - lista de supressão/opt-out SMS;
  - elegibilidade unificada de canais;
  - ajustes de dispatcher/orquestrador;
  - sincronização segura da exportação da base.
- Migrations locais a confirmar no Supabase:
  - `20261003113000_refresh_dashboard_metrics_range.sql`;
  - `20261003120000_add_sms_flow_delivery_controls.sql`;
  - `20261003123000_create_sms_suppressions.sql`;
  - `20261003124500_add_sms_flow_delay_hours.sql`.

Antes de deploy, conferir `git status`, `supabase migration list`, build e health check. Não misturar essas alterações com correções não relacionadas.

## Comparativo com a auditoria inicial

| Frente | Avanço realizado | Estado |
|---|---|---|
| Multi-conta e superadmin | Contexto operacional, papéis, gestão e auditoria foram estruturados. | `[~]` falta teste negativo completo de RLS, RPCs e service role. |
| Sidebar e navegação | Sidebar fixa e reorganização por áreas. | `[~]` WhatsApp e Ligações ainda aparecem sem escopo operacional completo. |
| Players, Públicos e Gamificação | Públicos CRUD, níveis por conta e filtros por nível/situação integrados. | `[~]` faltam regras comportamentais combináveis completas. |
| Campanhas e canais | Campanhas virou a entrada central, inclusive para envio individual. | `[~]` canais ainda precisam de saúde, relatórios e falhas completos. |
| SMS | Variáveis, públicos e estrutura de réguas avançaram. | `[~]` teste fim a fim bloqueado pela liberação de IP da Short Brasil. |
| E-mail | Editor limitado a blocos executáveis e fluxos centralizados. | `[~]` há mocks/trechos sem backend e falta teste SMTP real. |
| Webhooks | Webhook por conta, deduplicação e processamento receberam melhorias. | `[~]` logs registraram timeout e duplicidade; falta estabilização. |
| Dashboard | Cache e snapshots foram iniciados. | `[~]` métricas ainda exigem fonte única e conciliação. |
| Meta | Token criptografado e conexão por conta foram iniciados. | `[~]` falta conexão real, permissões, sync e reconciliação. |
| Banco/performance | Cache inicial introduzido. | `[ ]` Supabase apontou Disk I/O e consultas lentas. |
| UX global | Melhor direção de estados; não há uso encontrado de `alert()`/`confirm()` nativos. | `[~]` faltam padronização global, scrollbars e responsividade. |

## Entregas já realizadas

- [x] Sidebar fixa e reorganização inicial de navegação.
- [x] Contexto de conta, superadmin, papéis e gestão administrativa estruturados.
- [x] Públicos personalizados integrados a Campanhas.
- [x] Níveis da Gamificação tratados como públicos prontos.
- [x] Configuração de Gamificação por conta.
- [x] Filtros de Players por situação e nível.
- [x] Contadores contextuais para nível + situação.
- [x] Campanhas como ponto central de criação/disparo.
- [x] Ação de usar público abre campanha com público selecionado.
- [x] Base central de automações SMS/e-mail.
- [x] Webhook com token por conta e rota legada bloqueada.
- [x] Cache inicial por conta/recorte, com invalidação por eventos.
- [x] Criptografia dedicada de token Meta via `META_TOKEN_ENCRYPTION_KEY`.
- [x] Base de conexão Meta por conta, em substituição ao app compartilhado do CRM.
- [x] Plano operacional inicial criado em `docs/PLANO_DE_ENTREGAS.md`.

## Backlog priorizado

### P0 — Confiabilidade de dados e segurança

- [ ] **Estabilizar ingestão financeira e idempotência**
  - Norte: endpoint de webhook responde rápido, persiste o evento bruto e normalizado, deduplica por provedor/evento e envia erros para reprocessamento.
  - Evidência atual: logs mostraram timeout em `record_financial_webhook_event` e violações de chave única de evento.
  - Aceite: enviar cada tipo de evento, repetir o mesmo `eventId` e comprovar que não duplica valores, players ou saques.

- [ ] **Conciliar exportação da casa com o CRM**
  - Norte: comparar Players, depósitos, saques, status e datas; gerar relatório de ausentes, divergentes e duplicados antes de qualquer escrita definitiva.
  - Aceite: totais e usuários únicos por período conferem com a fonte de origem.

- [ ] **Definir fonte única de métricas**
  - Norte: Dashboard, Players, Públicos, Gamificação, Campanhas e Mídia/LTV usam a mesma regra para cadastro, FTD, depósito, saque, redépósito e saldo.
  - Aceite: Hoje, 7 dias e 30 dias batem com a casa em uma conta de teste.

- [ ] **Revisão final de RLS e funções privilegiadas**
  - Norte: testar usuário comum, gestor, admin e superadmin; revisar RPCs e server functions com `service_role`.
  - Aceite: tentativa de ler/escrever IDs de outra conta falha em todas as áreas.

- [ ] **Recuperação de sessão/login**
  - Norte: refresh token inválido deve limpar sessão, mostrar mensagem clara e redirecionar ao login sem loop.
  - Aceite: simular sessão expirada/revogada em navegador novo e em aba existente.

### P1 — Banco, performance e observabilidade

- [ ] **Otimizar consultas lentas e Disk I/O**
  - Norte: índices compostos por `tenant_id`, data, status, player e evento; paginação e RPCs sem leitura global desnecessária.
  - Aceite: comparar as consultas lentas no Supabase antes/depois e remover timeouts da ingestão.

- [ ] **Mover alertas pesados de Players para o servidor**
  - Norte: filtros de alerta devem usar RPC/consulta paginada, não carregar a base inteira no navegador.
  - Aceite: abrir alertas em base grande sem travamento ou consumo excessivo de memória.

- [ ] **Criar saúde operacional central**
  - Norte: uma tela para cron, filas, webhooks, SMS, SMTP, Meta, sync, atrasos e falhas recentes.
  - Aceite: simular indisponibilidade de cada integração e validar orientação/reprocessamento.

- [ ] **Instrumentar o cache**
  - Norte: registrar hit/miss, duração, invalidação e risco de dado desatualizado.
  - Aceite: comprovar redução de chamadas sem ocultar evento novo.

### P2 — SMS, E-mail e automações

- [ ] **Aplicar e validar controles locais de SMS**
  - Norte: aplicar migrations de supressão, limite diário, cooldown e delay; versionar o código local.
  - Aceite: build, migration aplicada, regra inativa, teste autorizado e fila/log conferidos.

- [ ] **Fechar SMS fim a fim**
  - Norte: provider, créditos, fila, entrega, falha, reenvio, opt-out, variáveis, custo e relatório.
  - Dependência: liberar IP do servidor na Short Brasil.
  - Aceite: envio individual e em massa com variável renderizada, entrega/falha e descadastro bloqueando novo envio.

- [ ] **Fechar E-mail fim a fim**
  - Norte: SMTP, remetente, template, histórico, falha, reenvio, descadastro e métricas reais.
  - Aceite: envio de teste, descadastro e tentativa posterior bloqueada; abertura/clique quando suportados.

- [ ] **Fila, cron e reprocessamento por conta**
  - Norte: mostrar pendências, tentativas, bloqueios, última execução e reprocessamento idempotente.
  - Aceite: pausar, enfileirar, retomar e acompanhar toda transição na tela.

- [ ] **Jornadas multicanal reais**
  - Norte: permitir SMS → espera → e-mail, com cooldown e saída globais.
  - Aceite: conversão ou opt-out encerra toda a jornada.

- [ ] **Atribuição de automações**
  - Norte: ligar envio, entrega, conversão, custo e receita à regra/campanha correta.
  - Aceite: confrontar logs e eventos financeiros em período fechado.

### P3 — Segmentação, campanhas e UX

- [ ] **Filtros comportamentais combináveis**
  - Norte: compor nível + situação + saldo + atividade com AND/OR explícito, removendo apenas combinações impossíveis.
  - Aceite: estimativa antes de aplicar igual à tabela final.

- [ ] **Contadores contextuais completos**
  - Norte: busca, período e comportamento também recalculam chips e estimativas.
  - Aceite: nenhum contador excede o recorte ativo.

- [ ] **Preview de público e explicação de regras**
  - Norte: mostrar quem entra, quem fica de fora, conflitos e estimativa antes de salvar.
  - Aceite: público salvo corresponde ao preview e mantém ícones/cores da Gamificação.

- [ ] **Limpar rotas sem operação real**
  - Norte: ocultar ou identificar WhatsApp e Ligações como indisponíveis enquanto não houver motor, fila, saúde e relatório.
  - Aceite: nenhum item do menu leva a dados fictícios ou tela sem ação.

- [ ] **Padronizar loading, vazio, erro e responsividade**
  - Norte: skeletons, toasts, dialogs, scrollbars e tabelas/modais/drawers coerentes em desktop e mobile.
  - Aceite: testar Players, Públicos, Campanhas, SMS, E-mail, Integrações e telas sem dados/erro.

### P4 — Meta, Mídia e LTV

- [ ] **Concluir conexão Meta por conta**
  - Norte: fluxo guiado para app próprio, permissões, token, ativos e conta de anúncio.
  - Aceite: conectar duas contas sem vazamento de anúncios, ativos ou gastos.

- [ ] **Sincronizar e reconciliar mídia**
  - Norte: gasto e métricas por conta/anúncio/criativo, com última execução e diagnóstico de cobertura.
  - Aceite: gasto diário bate com Ads Manager em período fechado.

- [ ] **Concluir atribuição e LTV**
  - Norte: origem/UTM/criativo → cadastro → FTD → receita, incluindo dados sem marcação.
  - Aceite: rastrear uma amostra de jogadores até criativo e receita.

## Riscos e melhorias identificados nesta reauditoria

- [ ] **Endpoints públicos de diagnóstico**: proteger, restringir ou remover em produção; cron/dispatch já usam segredo, mas diagnósticos precisam de revisão individual.
- [ ] **Token no caminho da URL do webhook**: manter token por conta, mas preferir assinatura HMAC em header quando suportado, rotação e mascaramento de logs.
- [ ] **Pasta `base/` com dados sensíveis**: ela não está rastreada, mas também não está ignorada. Adicionar ao `.gitignore` e manter exportações em local controlado/criptografado.
- [ ] **Testes automatizados**: o projeto possui build/lint, mas não possui suíte unitária, integração ou E2E. Priorizar matriz de testes para sessão, RLS, webhook, métricas e envio.
- [ ] **Limite de SMS concorrente**: limite diário precisa de reserva atômica no banco; contagem seguida de envio pode ultrapassar a cota com workers paralelos.
- [ ] **Contrato versionado de webhook**: registrar versão de parser, payload bruto, evento normalizado e resultado de cada tentativa.
- [ ] **LGPD e retenção**: definir retenção/anonimização de dados pessoais, payloads financeiros, exportações, auditoria de acesso e backup/restauração.
- [ ] **Acessibilidade**: revisar foco de modais/drawers, teclado, contraste, labels e estados que dependem somente de cor.
- [ ] **Deploy seguro**: obrigar branch limpa, build, migrations alinhadas, backup, health check e rollback documentado.
- [ ] **Matriz de permissões na interface**: deixar claro o que gestor, admin e superadmin podem ver/alterar para reduzir confusão com bloqueios de acesso.

## Roteiro recomendado de retomada

1. Não iniciar nova funcionalidade visual antes de resolver P0 de webhooks, métricas e RLS.
2. Aplicar, validar e versionar as migrations locais de SMS somente em ambiente controlado.
3. Tratar consultas lentas/timeouts antes de ampliar cron, importações ou envios em massa.
4. Executar reconciliação somente em modo leitura/relatório antes de qualquer escrita na base produtiva.
5. Depois, fechar SMS e e-mail com testes reais de provider/SMTP.
6. Por último, concluir Meta, relatórios e acabamento UX.

## Checklist obrigatório para encerrar qualquer item

- [ ] Código revisado e sem alterações locais não relacionadas.
- [ ] Migration aplicada e confirmada no ambiente correto, quando aplicável.
- [ ] `npm run build` executado com sucesso.
- [ ] Projeto reiniciado.
- [ ] Cenário funcional validado com caminho, conta e resultado registrados.
- [ ] Isolamento por conta validado para leitura e escrita, quando houver dados.
- [ ] Erro, estado vazio e loading verificados.
- [ ] Commit/push criado e referenciado no item correspondente.

## Prompt de continuidade para equipe ou novo chat

> Estamos trabalhando no repositório `C:\\Users\\Carol\\Desktop\\betleads`. Leia primeiro `docs/REAUDITORIA_SISTEMA_2026-10-03.md` e `docs/PLANO_DE_ENTREGAS.md`. Não assumir que código local não commitado está entregue; conferir `git status` e `supabase migration list`. A prioridade atual é P0: estabilizar webhooks financeiros, conciliar dados/métricas e validar RLS/service role. Toda alteração deve respeitar isolamento por conta, superadmin auditável, sem `alert()`/`confirm()` nativos, com scrollbar no padrão visual. Antes de iniciar cada etapa, resumir o objetivo; ao finalizar, fazer build, reiniciar, informar onde testar, listar pendências e só então marcar o checklist.
