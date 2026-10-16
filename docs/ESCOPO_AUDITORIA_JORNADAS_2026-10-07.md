# Auditoria e escopo de evolução — Jornadas e Automações

**Data:** 07/10/2026  
**Modo desta etapa:** auditoria e definição de escopo. Nenhuma implementação, migration, reinicialização, commit ou push faz parte desta etapa.  
**Áreas avaliadas:** UX, engenharia sênior, gestão de projeto e QA.

## 1. Decisão executiva

A área ainda não deve ser considerada pronta para uso operacional. Existem dois produtos paralelos usando os mesmos nomes:

1. `/automacoes` opera fluxos legados separados de SMS e e-mail, além de expor voz e WhatsApp;
2. `/jornadas` opera a nova estrutura multicanal baseada nas tabelas `journeys`, `journey_steps`, `journey_enrollments`, `journey_step_executions` e `journey_events`.

Os dois caminhos usam “régua”, possuem modais diferentes de criação e não compartilham lista, editor, estado ou dispatcher. A nova Jornada tem uma fundação relevante, porém seu worker não está agendado nas migrations de cron encontradas. Além disso, limite diário e cooldown são armazenados, mas não são aplicados pelo dispatcher de jornadas.

Há riscos P0 adicionais: edição destrutiva de etapas fora de transação, possibilidade de exclusão cross-tenant no caminho de atualização, entrada manual com comportamento automático inseguro, edição de uma jornada ativa sem voltar a rascunho e exposição de controles/erros de infraestrutura a usuários de tenant.

**Recomendação de produto:** “Automação” deve ser o nome da área/capacidade. “Jornada” deve ser o único nome do objeto criado pelo usuário. “Régua” deve ser removido da interface ou usado apenas como sinônimo editorial, nunca como uma terceira entidade.

## 2. Escopos e evidências revisados

Foram revisados os documentos existentes:

- `ESCOPO_REAUDITORIA_CANAIS_2026-10-06.md`;
- `ESCOPO_EVOLUCAO_UX_CANAIS_2026-10-07.md`;
- `ESCOPO_UX_COMPOSER_E_ENVIO_INDIVIDUAL_2026-10-07.md`;
- `ESCOPO_REMOCAO_BUSINESSCODE_INFOBIP_2026-10-06.md`;
- `ESCOPO_SHORTIO.md` e `PLANO_FECHAMENTO_SHORTIO.md`;
- `REAUDITORIA_SISTEMA_2026-10-03.md`, `PLANO_DE_ENTREGAS.md`, `MATRIZ_ACEITE_CANAIS.md`, evidências e roteiro de usabilidade.

Também foram revisados:

- rotas `/automacoes`, `/automacoes/*`, `/jornadas`, `/jornadas/nova` e `/jornadas/$journeyId`;
- editor, funções autenticadas, dispatcher, gatilhos e migrations de jornadas;
- crons, navegação, observabilidade de canais, mensagens de erro e permissões de infraestrutura;
- estado das migrations locais/remotas e qualidade técnica atual.

## 3. Definições de produto propostas

| Termo | Definição aprovada para o próximo ciclo | Não deve significar |
| --- | --- | --- |
| Campanha | Disparo pontual ou agendado para uma audiência definida. | Sequência recorrente por comportamento. |
| Automação | Capacidade do sistema de avaliar gatilhos e executar ações sem intervenção manual. É a área do produto. | Objeto duplicado da jornada. |
| Jornada | Objeto configurável que define entrada, público, sequência de passos, esperas, saídas, limites e estado por pessoa. | Um fluxo exclusivo de um único canal. |
| Etapa | Uma espera, mensagem SMS, e-mail ou outra ação certificada dentro da jornada. | Configuração global de provedor. |
| Canal | Meio de entrega disponível e certificado pela plataforma. | Unidade independente que o operador possa desligar sem entender o impacto nas jornadas. |

Decisão de nomenclatura na interface:

- sidebar: **Automações**;
- hub: **Jornadas**;
- CTA: **Nova jornada**;
- detalhe: **Editar jornada**;
- não usar simultaneamente “fluxo”, “régua” e “jornada” para o mesmo objeto.

## 4. Matriz consolidada: feito, parcial e pendente

Legenda: `[x]` implementado e verificável no código · `[~]` parcial ou não certificado · `[ ]` ausente/bloqueado.

| Item | Estado | Evidência e conclusão |
| --- | --- | --- |
| Modelo multicanal no banco | `[x]` | Tabelas, enums, índices, RLS e claim atômico existem nas migrations `20261005120000` e `20261005123000`. |
| Isolamento básico por tenant | `[~]` | Políticas RLS existem, mas as server functions usam service role; `saveJourney` remove etapas somente por `journey_id`, sem `tenant_id`, e não confirma que a jornada atualizada pertence ao tenant antes da exclusão. |
| Hub de Jornadas | `[x]` | Lista nova, filtros de estado, busca, fila e falhas existem em `/jornadas`. |
| Hub de Automações | `[~]` | Lista somente `sms_flows` e `email_flows`; não lista as novas `journeys`. O título “Fluxos multicanal” não corresponde ao conteúdo legado separado por canal. |
| Criação de jornada | `[~]` | Há dois modais “Nova régua”, com campos e destinos distintos. Um cria rascunho para os fluxos legados; o outro abre o editor novo. |
| Gatilho por evento | `[~]` | Predicados de gatilho existem, mas são avaliados por varredura de players, não por uma trilha de eventos versionada. |
| Gatilho de inatividade | `[ ]` | O modal oferece “quando nada acontece”, mas `entryMode` não é persistido no modelo nem consumido pelo editor/dispatcher. O mesmo seletor de eventos é usado nos dois modos. |
| Entrada manual/API | `[ ]` | Não há ação/API de matrícula manual. Se uma jornada com `trigger_type = manual` for ativada e o público não for `manual`, o dispatcher ignora a validação de gatilho e pode matricular automaticamente jogadores ativos. |
| Público manual | `[ ]` | Selecionar público manual faz o dispatcher ignorar todos os jogadores; não há mecanismo complementar de inclusão. |
| Editor de sequência | `[~]` | Adiciona espera, SMS, e-mail e voz e permite remover; não reordena, não duplica, não mostra resumo de publicação e usa segundos crus para espera. |
| SMS na jornada | `[~]` | Template e snapshot de SMS existem; falta certificação E2E específica da jornada e validação de limite/cooldown no motor. |
| E-mail na jornada | `[~]` | Seleciona template e envia via Infobip; não salva snapshot imutável do template na jornada e a busca do template no dispatcher não filtra explicitamente o tenant. |
| Voz na jornada | `[~]` | Upload/asset e dispatch Infobip existem, mas voz continua sem certificação operacional e sem cron geral validado. Mesmo assim o editor permite configurar/publicar a etapa. |
| WhatsApp | `[ ]` fora do produto atual | Não faz parte do schema novo de etapas, mas continua visível na sidebar, no hub de Automações, nos KPIs, controles globais, notificações e rota própria. Isso contradiz a decisão de não exibir o canal antes da integração. |
| Saídas globais | `[~]` | Depósito, primeiro depósito, login e retorno ao jogo são avaliados quando a matrícula volta ao worker; não há saída em tempo real nem cobertura automatizada. |
| Janela de envio | `[~]` | Existe cálculo básico, mas usa o relógio local do processo e não uma conversão explícita para `America/Sao_Paulo`; não há seleção de dias da semana. |
| Limite diário | `[ ]` | Campo é salvo e exibido, mas não é consumido pelo dispatcher de jornadas. |
| Cooldown | `[ ]` | Campo é salvo e exibido, mas não é consumido pelo dispatcher de jornadas. |
| Agendamento do worker | `[ ]` | A rota aceita `channel=journey`, mas nenhuma migration de cron encontrada agenda esse canal. |
| Idempotência | `[~]` | Há claim com `SKIP LOCKED` e chave de execução, mas o fluxo de falha/retry não está completo e não possui teste de concorrência. |
| Versionamento/publicação | `[ ]` | Colunas `version`, `published_version`, `approved_by` existem, mas não são atualizadas. Editar uma jornada ativa substitui etapas diretamente e a mensagem da UI diz incorretamente “salva como rascunho”. |
| Atualização segura | `[ ]` | A atualização apaga etapas e reinsere fora de transação. Falha na inserção deixa a jornada sem sequência. Há corrida possível com o dispatcher. |
| Estado e governança | `[~]` | Draft/active/paused/archived existem. Não há autorização por papel para criar, editar ou publicar; qualquer usuário autenticado do tenant alcança as server functions. |
| Controles globais por canal | `[ ]` inadequado | Os switches podem interromper operações sem mostrar jornadas/pessoas impactadas e pertencem à governança de infraestrutura. A proteção atual exige apenas autenticação. |
| Observabilidade para tenant | `[~]` | Métricas de fila/erros existem, mas a API retorna nomes de provedores, erro bruto e ações de pausar/reprocessar para usuário autenticado. |
| Erros seguros | `[~]` | Há utilitário de erro seguro em partes do composer, porém cliente Supabase, middleware e diversas telas ainda expõem nomes de variáveis, termos de infraestrutura ou mensagens brutas. |
| Métricas da jornada | `[~]` | Entradas, status, saídas, custo e recuperado existem; custo é estimativa fixa e consultas carregam todos os registros sem agregação/paginação. |
| Testes automatizados | `[ ]` para Jornadas | A suíte atual passou com 11 arquivos/30 testes, mas não foi encontrado teste específico de jornadas, triggers manuais, publicação, dispatcher, RLS ou concorrência. |
| Build e lint | `[~]` | Build passou e lint terminou sem erro bloqueante, mas com dívida relevante de warnings. Isso é baseline, não aceite funcional. |
| Migrations | `[x]` alinhadas | `supabase migration list` mostrou migrations locais e remotas alinhadas até `20261007150000`. Não há migration nova nesta auditoria. |
| BusinessCode | `[x]` no runtime atual | Não foram encontradas referências ativas no código de runtime; resíduos estão em migrations históricas, documentação histórica e um e-mail de usuário citado no deploy. |
| Short.io em jornadas | `[~]` | SMS/e-mail do dispatcher habilitam rastreamento por padrão, mas falta teste E2E da jornada e reconciliação com a origem correta. |

## 5. Acertos que devem ser preservados

### UX

- Separação inicial entre campanha pontual e jornada recorrente no texto do hub.
- Estado individual de jornada com rascunho, ativa, pausada e arquivada.
- Fila e falhas acessíveis no contexto de Jornadas.
- Uso de templates em vez de mensagem solta para SMS/e-mail.

### Engenharia

- Modelo de dados separado dos fluxos legados, permitindo migração gradual.
- Isolamento por `tenant_id` nas entidades e RLS habilitada.
- Claim atômico com `FOR UPDATE SKIP LOCKED`.
- Chave de idempotência por execução e trilha `journey_events`.
- Snapshot de template SMS.
- Integrações ativas de e-mail e voz concentradas em Infobip; SMS em Short Brasil.

### Gestão

- Documentos anteriores registram dependências externas e diferenciam “implementado” de “certificado”.
- Voz e aceite real de provedores já aparecem como gates, não como resultado presumido.
- Existe matriz de aceite por canal e protocolo de teste com operadores.

### QA

- Build, lint e suíte automatizada fazem parte do pipeline atual.
- Migrations estão alinhadas entre repositório e ambiente remoto consultado.
- Fluxos de consentimento, snapshots e rastreamento já oferecem componentes reutilizáveis para a futura jornada consolidada.

## 6. Problemas por perspectiva

### 6.1 Designer UX

1. Dois CTAs “Nova régua” abrem experiências diferentes.
2. “Automação”, “fluxo”, “régua” e “jornada” são usados como se fossem equivalentes.
3. Os cartões por canal reforçam um modelo separado, enquanto o produto anuncia multicanal.
4. Switch global de canal não informa quais jornadas, etapas e pessoas serão afetadas.
5. WhatsApp aparece como disponível mesmo estando fora do produto atual.
6. Voz aparece simultaneamente como “em preparação” e como etapa publicável.
7. Editor não protege alterações não salvas, não reordena etapas e não oferece preview/teste completo.
8. Campos de espera em segundos e número de origem são linguagem técnica, não operacional.
9. Estados de erro/fila podem apresentar causa técnica sem próxima ação segura.

### 6.2 Desenvolvedor sênior

1. Atualização de jornada não é transacional.
2. Exclusão de etapas sem filtro por tenant cria risco cross-tenant quando a função usa service role.
3. Edição de jornada ativa altera o fluxo em execução sem nova versão publicada.
4. `manual` pode matricular automaticamente a base; `audience = manual` não matricula ninguém.
5. `daily_limit` e `cooldown_hours` não são aplicados.
6. Worker de jornadas não possui cron agendado.
7. Janela usa timezone do processo.
8. Template de e-mail não tem snapshot e consulta do dispatcher não restringe tenant explicitamente.
9. Condição, split e update de player existem no schema, mas o dispatcher rejeita esses passos.
10. Falha encerra a matrícula como `failed`; retry configurável e recuperação idempotente não estão fechados.
11. Consultas de métricas não agregam no banco e podem degradar com volume.
12. Server functions de jornadas e controles operacionais não têm matriz de autorização por papel.

### 6.3 Gerente de projetos

1. Documentos anteriores classificam a fundação como “jornadas multicanal”, mas o gate de operação não foi fechado.
2. Há três backlogs sobrepostos: fluxos legados, jornadas novas e UX de canais.
3. Não existe plano de migração dos fluxos SMS/e-mail existentes para o modelo de jornada.
4. Não há dono explícito para decisão de descontinuação das rotas legadas.
5. WhatsApp e voz precisam de gates formais de disponibilidade para não reaparecerem por acidente.
6. O aceite deve medir segurança e consistência antes de ampliar o editor visual.

### 6.4 QA

1. Zero cobertura automatizada específica da área de Jornadas.
2. Não há teste negativo cross-tenant para update/delete de etapas.
3. Não há teste de manual/inatividade, limite, cooldown, janela BRT, saída, retry ou concorrência.
4. Não há E2E cobrindo criar → revisar → publicar → matricular → esperar → enviar → sair.
5. Não há matriz por papel para member, gestor, admin e superadmin.
6. Não há teste de regressão garantindo ausência de WhatsApp nas superfícies visíveis.
7. Não há teste de edição de jornada ativa nem recuperação após falha parcial.
8. Empty/error/loading existem de forma incompleta; falha de queries do hub não recebe tratamento consistente.

## 7. Checklist priorizado

### P0 — Bloquear risco de envio, perda de dados e vazamento entre tenants

- [ ] Colocar a publicação de novas Jornadas atrás de feature flag até o motor passar no aceite P1.
- [ ] Corrigir `saveJourney` para validar ownership antes de qualquer mutação.
- [ ] Salvar jornada + versão + etapas em transação/RPC atômica, sempre filtrada por tenant.
- [ ] Proibir edição direta da versão ativa; alterações geram novo rascunho/versionamento.
- [ ] Corrigir entrada manual para nunca varrer/matricular a base automaticamente.
- [ ] Remover “público manual” até existir matrícula manual/API auditada.
- [ ] Restringir publicar/pausar/arquivar por papel definido e testar manipulação direta da API.
- [ ] Restringir pausa global, pausa por canal e reprocessamento a superadmin/operação autorizada.
- [ ] Redigir resposta pública segura: sem variável de ambiente, provedor, endpoint, payload ou erro bruto.
- [ ] Ocultar WhatsApp de todas as superfícies do produto enquanto a integração não estiver certificada.
- [ ] Manter voz indisponível para publicação automática até concluir o gate operacional existente.

**Aceite P0:** tentativa cross-tenant falha sem alterar dados; manual não matricula automaticamente; jornada ativa não muda sem nova publicação; tenant não acessa infraestrutura nem recebe detalhes técnicos; WhatsApp não aparece.

### P1 — Tornar o motor de Jornadas funcional e previsível

- [ ] Agendar worker `channel=journey` com segredo, observabilidade e rollback.
- [ ] Aplicar limite diário de forma atômica por tenant/jornada/canal.
- [ ] Aplicar cooldown global por pessoa e política de consentimento antes de cada etapa.
- [ ] Calcular janela e dias da semana explicitamente em `America/Sao_Paulo`.
- [ ] Modelar três entradas reais: evento, inatividade temporal e manual/API.
- [ ] Definir reentrada: uma vez, por ocorrência, após cooldown ou nunca.
- [ ] Implementar saída antes do envio e reação a eventos relevantes.
- [ ] Fechar retry, backoff, máximo de tentativas e recuperação de claims órfãos.
- [ ] Criar snapshot imutável de e-mail e validar asset/sender pelo tenant.
- [ ] Remover do schema público passos ainda não executáveis ou implementá-los antes de expor.
- [ ] Agregar métricas no banco e eliminar leituras integrais por jornada.

**Aceite P1:** cenário SMS → espera → e-mail executa automaticamente uma vez, respeita janela/limite/cooldown/consentimento, sai pelo evento esperado e não duplica sob concorrência ou retry.

### P2 — Unificar produto, navegação e criação

- [ ] Transformar `/automacoes` no hub único da área e `/jornadas` na lista/detalhe do mesmo modelo, sem dois produtos concorrentes.
- [ ] Usar um único modal **Nova jornada** com: nome, tipo de entrada e evento/tempo correspondente.
- [ ] Remover os cards que prometem construtores separados por canal.
- [ ] Mostrar canais dentro das etapas da jornada, não como produtos paralelos.
- [ ] Exibir fluxos legados como “legados” somente durante migração, em modo de compatibilidade.
- [ ] Definir migration/conversor de `sms_flows` e `email_flows` para `journeys`.
- [ ] Preservar redirects para rotas antigas até medir ausência de uso.
- [ ] Remover “régua” e “fluxo” da nomenclatura principal.

**Aceite P2:** qualquer CTA de criação abre a mesma experiência; todas as jornadas aparecem na mesma lista; nenhum destino duplica a mesma tarefa; legado tem plano de encerramento observável.

### P3 — Evoluir o editor e a compreensão operacional

- [ ] Editor em etapas: entrada → público → sequência → saídas → limites → revisão.
- [ ] Reordenar/duplicar/remover etapas com confirmação e acessibilidade de teclado.
- [ ] Espera em minutos/horas/dias com presets e representação amigável.
- [ ] Preview por canal, variáveis, template/asset versionado e envio de teste seguro.
- [ ] Seleção de dias/horários e explicação do que ocorre fora da janela.
- [ ] Estimativa de elegíveis, exclusões, partes/créditos e impacto antes de publicar.
- [ ] Resumo final com gatilho, público, etapas, saídas, limites e canais indisponíveis.
- [ ] Alerta de alterações não salvas e autosave do rascunho.
- [ ] Pausa no nível da jornada com impacto: pessoas ativas, próximas etapas e regra de retomada.
- [ ] Status orientado à ação, sem nomes de fornecedor/variável e sem erro bruto.

**Aceite P3:** operador configura e revisa uma jornada sem ajuda, entende quem entra/sai, prevê o próximo envio e não perde alterações ao navegar ou recarregar.

### P4 — Certificação QA, observabilidade e rollout

- [ ] Testes unitários de gatilhos, janela, limite, cooldown, saída e renderização.
- [ ] Testes de integração de persistência atômica, RLS/RBAC, claims e retries.
- [ ] E2E dos caminhos de criação, publicação, pausa, retomada, falha e arquivamento.
- [ ] Testes negativos para IDs de outro tenant e todos os papéis.
- [ ] Teste de carga da matrícula, dispatcher e métricas.
- [ ] Teste de acessibilidade por teclado, foco, labels, contraste e leitor de tela.
- [ ] Regressão desktop/mobile e estados loading/vazio/erro.
- [ ] Painel seguro: fila, atraso, falha, próxima execução e reprocessamento autorizado.
- [ ] Executar teste moderado com ao menos três operadores e registrar métricas reais.
- [ ] Rollout gradual por tenant, com kill switch exclusivo da plataforma e plano de rollback.

**Aceite P4:** CI cobre a matriz crítica; teste humano atende os critérios; piloto controlado não duplica envio, não cruza tenant e possui rollback comprovado.

## 8. Decisão sobre os botões de ligar/desligar canal

Os switches atuais não devem permanecer como controle cotidiano do tenant.

Motivos:

- o efeito é transversal e pouco visível;
- uma jornada multicanal pode parar no meio sem explicar o estado de cada pessoa;
- os motores legado e novo não consomem necessariamente o mesmo estado, criando falsa sensação de controle;
- indisponibilidade de provedor deve ser tratada por health check/backoff da plataforma;
- emergência de infraestrutura exige autorização, motivo, auditoria, impacto e plano de retomada.

Modelo recomendado:

1. operador pausa uma jornada específica;
2. plataforma aplica pausa automática por saúde/limite;
3. superadmin possui kill switch por canal em uma central restrita;
4. qualquer pausa mostra pessoas/itens afetados, regra de retomada e trilha de auditoria;
5. a retomada nunca dispara backlog acumulado sem respeitar limite, janela e consentimento.

## 9. Plano de migração dos fluxos legados

1. Congelar novas funcionalidades em `sms_flows`, `email_flows`, `call_flows` e fluxos de WhatsApp.
2. Inventariar por tenant: fluxos ativos, gatilhos, etapas, pessoas em andamento e últimos envios.
3. Criar conversor somente para combinações suportadas e emitir relatório para incompatíveis.
4. Migrar como rascunho versionado; nunca ativar automaticamente.
5. Permitir comparação lado a lado de origem e jornada convertida.
6. Publicar a nova versão após aceite humano.
7. Drenar execuções antigas, manter histórico somente leitura e remover CTAs legados.
8. Desativar crons legados apenas quando não houver fila/matrícula ativa.

## 10. Protocolo obrigatório ao executar cada prioridade futuramente

Este protocolo foi solicitado para cada prioridade, mas não deve ser executado durante a etapa atual de auditoria.

1. Confirmar `git status` e excluir alterações alheias do commit.
2. Registrar hipótese, risco, arquivos/tabelas afetados e rollback.
3. Implementar testes antes ou junto da mudança.
4. Executar migrations somente no ambiente explicitamente escolhido e confirmar `supabase migration list`.
5. Executar testes relevantes, suíte completa, lint e build de produção.
6. Encerrar o processo local anterior e reiniciar com a build mais atual.
7. Fazer smoke test autenticado nos papéis afetados, sem chamar provedor real salvo autorização explícita.
8. Validar isolamento por tenant, loading, vazio, erro, desktop e mobile.
9. Revisar diff e segredos; criar commit exclusivo da prioridade e fazer push.
10. Informar:
   - commit/branch;
   - migrations aplicadas e ambiente;
   - comandos e resultados;
   - URL e roteiro exato de teste;
   - resultado esperado;
   - limitações e etapas ainda faltantes;
   - status do CI e rollback.

## 11. Roteiros futuros de aceite por prioridade

### P0

- entrar como member, gestor, admin e superadmin;
- tentar acessar/mutar controles de infraestrutura pela UI e por requisição direta;
- tentar salvar uma jornada usando ID de outro tenant;
- ativar entrada manual em base com jogadores e comprovar zero matrícula sem ação explícita;
- pesquisar todas as superfícies visíveis e confirmar ausência de WhatsApp.

### P1

- criar jornada SMS → espera curta → e-mail em tenant de teste;
- disparar o evento uma vez e repetir o mesmo evento;
- validar uma única matrícula e uma única execução por etapa;
- testar fora da janela, limite diário, cooldown, opt-out e evento de saída;
- provocar falha transitória e validar retry sem duplicação.

### P2

- iniciar criação pela sidebar, hub e empty state;
- confirmar que todos abrem a mesma experiência;
- localizar jornada nova e fluxo legado convertido na mesma área;
- abrir URLs legadas e validar redirect compatível.

### P3

- montar, reordenar e revisar uma sequência em desktop e mobile;
- sair/recarregar e recuperar o rascunho;
- validar preview, variáveis, elegíveis, custo e resumo;
- pausar uma jornada com matrículas ativas e verificar a explicação de impacto.

### P4

- executar matriz automatizada completa;
- executar protocolo de usabilidade com três operadores;
- realizar piloto em tenant controlado;
- comprovar observabilidade, alerta, rollback e aceite go/no-go.

## 12. Estado desta auditoria

- [x] Escopos existentes lidos e confrontados com o código atual.
- [x] Migrations locais/remotas consultadas e alinhadas no momento da auditoria.
- [x] Baseline técnico consultado: 11 arquivos/30 testes aprovados; lint sem erros bloqueantes; build aprovado.
- [x] Alterações locais pré-existentes identificadas e preservadas: `scripts/sync-sortealta-export.mjs` e `src/components/campaigns/individual-sms-dialog.tsx`.
- [x] Nenhuma implementação da área de Jornadas mantida nesta etapa.
- [ ] Prioridades aguardam aprovação para execução.

