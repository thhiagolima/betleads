# Levantamento da documentação do Betleads

**Data da revisão:** 09/10/2026  
**Escopo:** documentação presente no repositório, aderência ao código, configuração, banco, testes e operação.  
**Regra desta análise:** presença de código não foi tratada como aceite funcional. Quando não havia evidência de homologação, o estado foi classificado como implementado, porém não certificado.

## 1. Conclusão executiva

O Betleads possui boa documentação de decisões recentes, escopos de produto e operação de canais. O principal problema não é ausência total de conteúdo, mas falta de uma estrutura canônica: documentos de datas diferentes misturam diagnóstico, plano, evidência e estado atual. Algumas entregas avançaram no código sem que o documento de origem fosse encerrado ou atualizado.

O repositório não possui README, visão de arquitetura, catálogo do banco, contrato consolidado das APIs/webhooks, matriz completa de permissões, guia de desenvolvimento ou estratégia de testes. Isso torna a entrada de uma nova pessoa dependente de leitura do código e de conhecimento oral.

Classificação geral da documentação: **2,5 de 5 — útil para a equipe atual, insuficiente como fonte autônoma e confiável do sistema**.

| Dimensão | Nota | Leitura |
| --- | ---: | --- |
| Escopo funcional e decisões de produto | 4/5 | Há bons escopos para canais, Short.io, jornadas e conversão. |
| Operação e incidentes | 3/5 | Existe runbook, mas alguns estados operacionais estão desatualizados. |
| Arquitetura e integrações | 1/5 | Não há visão ponta a ponta, diagramas, fronteiras ou contratos consolidados. |
| Desenvolvimento e onboarding | 1/5 | Não há README, setup local completo, convenções ou fluxo de contribuição. |
| Banco e dados | 1/5 | Há 250 migrations, mas não há dicionário, ERD, ownership ou política de evolução. |
| Segurança, RBAC e LGPD | 2/5 | Regras aparecem em vários escopos, sem documento canônico e sem matriz completa. |
| Testes e qualidade | 2/5 | CI existe e passa, mas a estratégia e a cobertura de risco não estão documentadas. |
| Rastreabilidade das entregas | 3/5 | Há commits e evidências, porém checklists e números ficam obsoletos rapidamente. |

## 2. Retrato verificado do sistema

### 2.1 Tecnologia e estrutura

- Aplicação full-stack em TypeScript com React 19, TanStack Start/Router, Vite e Nitro sobre Node 22.
- Supabase como autenticação e banco PostgreSQL, com RLS, RPCs, Storage, `pg_cron` e `pg_net` usados nas migrations.
- Integrações principais: Short Brasil para SMS, Infobip para e-mail e voz, Evolution para WhatsApp, Short.io para rastreamento, Meta para mídia, ElevenLabs para geração de áudio e provedores de IA.
- Produto multitenant com perfis administrativos, campanhas, jornadas, públicos, players, gamificação, canais, consentimentos, atribuição e relatórios.

### 2.2 Dimensão atual

| Indicador | Quantidade verificada |
| --- | ---: |
| Arquivos versionados | 630 |
| Linhas TS/TSX, sem os dois principais gerados | aproximadamente 79.869 |
| Rotas visuais | 39 |
| Rotas públicas de API/worker/webhook | 25 |
| Migrations Supabase | 250 |
| Arquivos de teste | 15 |
| Testes automatizados | 48 |
| Documentos na pasta `docs` | 17 |
| Documentos versionados antes deste levantamento | 14 |

### 2.3 Módulos identificados

| Domínio | Capacidades encontradas | Cobertura documental atual |
| --- | --- | --- |
| Plataforma | autenticação, tenants, superadmin, configuração e auditoria | dispersa em reauditorias e escopos de segurança |
| CRM | dashboard, players, ficha do jogador, públicos, eventos, regras e gamificação | apenas planos e reauditorias; não há manual ou arquitetura |
| Orquestração | campanhas, rascunhos, jornadas, automações e filas | bem escopada, mas com documentos defasados após entregas recentes |
| Canais | SMS, e-mail, voz e WhatsApp | canais SMS/e-mail/voz possuem escopos e runbook; WhatsApp está pouco documentado |
| Conversão | links, funis, atribuição, relatórios, alertas e experimentos | operação recente bem descrita; escopo original ainda aparece como proposto |
| Aquisição | Meta, mídia, atribuição de aquisição e LTV | quase sem documentação própria |
| IA | inteligência, treino, feedback e insight de player | sem arquitetura, política de dados, custos ou limites documentados |
| Operação | alertas, webhooks, consentimentos, health/filas e recuperação | runbook parcial; faltam SLOs e catálogo completo de jobs |

## 3. Inventário de tudo que já foi documentado

| Documento | Papel atual | Situação encontrada | Ação recomendada |
| --- | --- | --- | --- |
| `CONVERSION_FUNNEL_OPERATIONS.md` | operação/rollback do funil | atual e conciso | manter como runbook canônico e ligar ao índice |
| `docker-deployment.md` | deploy Docker/VPS | funcional, mas incompleto e com dados específicos de usuário/tenant | generalizar, completar variáveis, rollback, backup e pós-deploy |
| `ESCOPO_AUDITORIA_JORNADAS_2026-10-07.md` | auditoria original de jornadas | não versionado e superado por migrations/commits posteriores | arquivar como histórico e criar evidência final de entrega |
| `ESCOPO_EVOLUCAO_UX_CANAIS_2026-10-07.md` | escopo de UX/governança | bom documento de decisão | marcar como concluído e apontar para a evidência correspondente |
| `ESCOPO_FUNIL_CONVERSAO_CAMPANHAS_JORNADAS_2026-10-08.md` | escopo do funil | diz “proposto”, mas grande parte já foi implementada | trocar por estado entregue/parcial e relacionar migrations, testes e lacunas restantes |
| `ESCOPO_JORNADAS_CRUZADAS_E_PROGRESSAO_NIVEIS.md` | escopo de conflitos e níveis | fases parecem implementadas no código recente, sem registro de entrega/aceite | acrescentar status por fase e cenários E2E comprovados |
| `ESCOPO_REAUDITORIA_CANAIS_2026-10-06.md` | reauditoria técnica dos canais | útil como histórico; aceitações reais continuam abertas | congelar o diagnóstico e mover estado vivo para a matriz de aceite |
| `ESCOPO_REMOCAO_BUSINESSCODE_INFOBIP_2026-10-06.md` | migração de provedor | runtime está limpo de BusinessCode | marcar encerrado e manter somente como ADR/histórico |
| `ESCOPO_SHORTIO.md` | arquitetura original Short.io | boa referência de desenho, não de estado | manter congelado e apontar somente para o plano canônico |
| `ESCOPO_UX_COMPOSER_E_ENVIO_INDIVIDUAL_2026-10-07.md` | melhoria do composer | possui registro de entrega e roteiro manual | marcar aceite manual pendente ou registrar conclusão |
| `EVIDENCIA_EVOLUCAO_UX_CANAIS_2026-10-07.md` | evidência técnica de UX/canais | clara, mas os números de testes são históricos | manter imutável com rótulo explícito de snapshot |
| `MATRIZ_ACEITE_CANAIS.md` | certificação operacional | todos os checkboxes seguem vazios; SMS/e-mail bloqueados e callback de voz pendente | tornar este o estado vivo por tenant/ambiente e concluir ou formalizar o bloqueio |
| `OPERACAO_SEGURA.md` | runbook de canais/incidentes | boa base; voz ainda é descrita como cron desabilitado | reconciliar com migrations e flags reais; acrescentar SLOs, contatos e rollback de banco |
| `PLANO_DE_ENTREGAS.md` | backlog geral | muito defasado frente às entregas de jornadas e conversão | revalidar cada item e transferir backlog vivo para uma única fonte |
| `PLANO_FECHAMENTO_SHORTIO.md` | checklist canônico Short.io | declara aceite do piloto, mas a definição de pronto ainda possui tarefas abertas | separar “piloto aceito” de “escopo integral encerrado” e remover contradição |
| `REAUDITORIA_SISTEMA_2026-10-03.md` | fotografia geral anterior | não versionado e desatualizado; afirma que não havia testes | arquivar como histórico ou remover do fluxo de leitura atual |
| `TESTE_USABILIDADE_CANAIS_2026-10-07.md` | protocolo de pesquisa com operadores | roteiro pronto, tabela de resultados vazia | executar com três operadores ou registrar formalmente que o aceite não ocorreu |

## 4. O que está bem documentado e deve ser preservado

1. Critérios de aceite proporcionais ao risco, especialmente em canais, Short.io, conversão e jornadas.
2. Separação entre implementação técnica e certificação operacional.
3. Preocupação recorrente com isolamento por tenant, idempotência, consentimento, frequência e rollback.
4. Registro de evidências com migrations, commits e cenários reais.
5. Decisões explícitas de produto, como Infobip exclusivo para e-mail/voz e rastreamento determinístico.
6. Runbook de incidentes com severidade, pausa, preservação de fila e retomada controlada.
7. Roteiros de validação manual e de usabilidade que evitam confundir build aprovado com aceite humano.

Esses padrões devem virar um template único de RFC/escopo, em vez de permanecerem replicados manualmente em cada arquivo.

## 5. Divergências entre documentação e estado atual

### 5.1 Documentos de escopo não foram encerrados

- O funil de conversão ainda aparece como “proposto”, embora existam as rotas de relatório de campanha e jornada, a camada de atribuição, alertas, entrega, atribuição assistida e experimentos.
- A auditoria de jornadas registra ausência de agendamento, publicação segura, concorrência e proteções que receberam migrations posteriores (`20261007200000` a `20261007214000`) e novas evoluções em 08/10.
- O escopo de jornadas cruzadas apresenta cinco fases sem coluna de status, mesmo havendo migrations específicas para conflitos, níveis, prioridade, cadência e frequência.
- O plano geral ainda marca jornadas multicanal e relatórios de campanha como ausentes, apesar de implementação posterior. A certificação pode estar pendente, mas o estado não deve continuar como simplesmente “não feito”.

### 5.2 Estado operacional de voz é contraditório

- `OPERACAO_SEGURA.md` e `MATRIZ_ACEITE_CANAIS.md` orientam manter o cron desabilitado.
- As migrations `20261008130000_enable_voice_dispatch_cron.sql` e `20261008220000_schedule_infobip_voice_reconciliation.sql` foram aplicadas no remoto.
- A matriz registra reprodução real aprovada, mas callback final pendente. Há uma implementação local nova de reconciliação ainda não consolidada no Git.
- É necessário definir uma única resposta por ambiente: cron ativo/inativo, flag efetiva, escopo do job, dono e evidência de callback/reconciliação.

### 5.3 Short.io possui dois conceitos de encerramento

O plano registra deploy e aceite final do piloto, mas mantém tarefas abertas que a própria “Definição de pronto” considera obrigatórias. O documento precisa separar:

- piloto Sorte Alta aprovado;
- produto mínimo suportado;
- backlog de robustez/observabilidade;
- encerramento integral do escopo.

### 5.4 Qualidade é aprovada com dívida invisível no resumo

- `npm test`: 15 arquivos e 48 testes aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado, com muitos avisos de bundling e chunk principal de aproximadamente 1,2 MB antes de gzip.
- `npm run lint`: retorna sucesso, mas gera **668 avisos**. Portanto o CI bloqueia erros, não dívida crescente de warnings.
- O CI executa lint, testes e build, mas não executa typecheck dedicado, auditoria de dependências, lint do banco ou teste E2E.
- Os documentos de evidência registram 11, 23, 28 ou 30 testes conforme a data. Esses números são snapshots e não devem ser lidos como estado atual.

### 5.5 Configuração e deploy estão incompletos

A comparação entre código e `.env.example` encontrou nomes usados, mas não catalogados: `INFOBIP_EMAIL_CALLBACK_TOKEN`, `APP_URL`, `IMPORT_TENANT_ID`, overrides de URL do Short Brasil e aliases de service role do Supabase. Nem todos são obrigatórios em produção, mas o documento deve classificá-los como obrigatório, opcional, legado ou exclusivo de script.

Também há variáveis no exemplo sem uso direto aparente, como `JOURNEYS_PUBLISHING_ENABLED`, enquanto o comentário afirma que ela controla publicação. Isso precisa ser removido ou implementado para não criar falsa segurança operacional.

O deploy contém o e-mail nominal de um usuário e um tenant específico, além de ainda usar endereço com domínio BusinessCode como passo padrão. Informações de uma implantação não devem estar no guia genérico.

### 5.6 Governança da pasta de documentação é frágil

O `.gitignore` ignora `docs/*` e depende de exceções individuais. Isso deixou duas auditorias fora do versionamento e exige alteração manual a cada documento novo. A regra deveria ser invertida: versionar documentação por padrão e ignorar somente artefatos temporários ou sensíveis.

## 6. O que falta documentar

### Prioridade 0 — necessário para operar e evoluir com segurança

1. **README principal:** objetivo, módulos, stack, requisitos, setup local, comandos, variáveis, banco, testes e links para documentos canônicos.
2. **Índice e política de documentação:** dono, status, data de revisão, documento substituído e fonte canônica por assunto.
3. **Arquitetura ponta a ponta:** browser → TanStack/Nitro → Supabase → workers/cron → provedores → callbacks, incluindo fronteiras de tenant e service role.
4. **Catálogo de ambientes e configuração:** desenvolvimento, homologação e produção; variáveis obrigatórias/opcionais; rotação e ownership de segredos.
5. **Matriz RBAC:** usuário, gestor, admin, superadmin e contas técnicas versus ação e dado acessível.
6. **Contrato de APIs, webhooks e jobs:** rota, método, autenticação, payload, idempotência, timeout, retry, resposta e observabilidade.
7. **Modelo de dados crítico:** entidades, relacionamentos, fonte de verdade e retenção para players, eventos financeiros, campanhas, jornadas, envios, links e atribuições.
8. **Recuperação operacional:** backup/restore testado, rollback de migration, RPO/RTO e procedimento de desastre.
9. **Correção de segurança de dependências:** a auditoria encontrou 8 vulnerabilidades, sendo 4 altas e 4 moderadas, principalmente em `sharp`, `undici` e `source-map-js`. A atualização completa pode exigir mudança incompatível do Nitro e deve ter plano/teste próprio.

### Prioridade 1 — necessário para reduzir regressão e dependência oral

1. **Estratégia de testes:** pirâmide, riscos por domínio, fixtures, ambiente, política de E2E e gates de release.
2. **Matriz de isolamento multitenant:** testes negativos por tabela/RPC/endpoint e regra para uso de service role.
3. **Catálogo de jobs:** frequência, lock, timeout, retry, kill switch, tabela afetada, métrica e responsável.
4. **Observabilidade/SLO:** disponibilidade, atraso máximo de fila, taxa de falha, alertas, dashboards e escalonamento.
5. **Guia de migrations:** convenção de nomes, transações, reversibilidade, promoção, validação e recuperação.
6. **ADR das decisões principais:** provedores, multitenancy, atribuição, jornadas, Short.io, service role e arquitetura de workers.
7. **Política de LGPD:** base legal, minimização, retenção, anonimização, exportação, descarte e auditoria.
8. **Guia de contribuição/release:** branch, revisão, CI, migrations, deploy, smoke test, changelog e rollback.

### Prioridade 2 — necessário para escalar produto e suporte

1. Manual do operador por tarefa, não por tela.
2. Guia administrativo e de troubleshooting por código/estado seguro.
3. Glossário de campanha, jornada, automação, régua, público, conversão, atribuição e estados.
4. Catálogo de métricas com fórmula, fonte, fuso, granularidade e limitações.
5. Política de IA: dados enviados, modelo/provedor, custos, retenção, avaliação e fallback.
6. Documentação específica de Meta/mídia/LTV e WhatsApp/Evolution.
7. Changelog e notas de release orientadas ao operador.

## 7. Melhorias propostas para o que já existe

### 7.1 Adotar quatro tipos de documento

- **Referência atual:** arquitetura, API, dados, segurança e operação. Deve refletir sempre o sistema atual.
- **RFC/escopo:** proposta com problema, decisão, fases e critérios; ao concluir, recebe estado final e links de evidência.
- **Evidência:** snapshot imutável, datado, com commit, ambiente e resultado.
- **Histórico:** auditorias e planos substituídos, claramente marcados como não canônicos.

Hoje esses quatro papéis aparecem misturados, o que produz contradições.

### 7.2 Cabeçalho padrão obrigatório

Todo documento deve declarar:

```text
Status: rascunho | aprovado | em execução | entregue | substituído | arquivado
Dono:
Última revisão:
Ambiente:
Fonte canônica:
Substitui / substituído por:
Código/migrations relacionados:
Aceite funcional:
```

### 7.3 Transformar checklists em evidência sustentável

- Não registrar contagem fixa de testes como estado atual; apontar para CI e manter a contagem apenas como evidência datada.
- Separar “implementado”, “validado tecnicamente”, “homologado” e “certificado em produção”.
- Evitar listas duplicadas entre plano geral e escopo específico. O plano geral deve apenas referenciar o backlog canônico.
- Cada item concluído deve ter commit/release, migration, ambiente, cenário e responsável.

### 7.4 Corrigir qualidade e manutenção do código associadas à documentação

- Criar script `typecheck` e adicioná-lo ao CI.
- Definir orçamento de warnings e reduzi-lo progressivamente; impedir crescimento acima da baseline.
- Priorizar testes para webhooks financeiros, RLS/RBAC, dispatcher de jornadas, retries/concorrência, cron e callbacks.
- Adicionar E2E dos caminhos de maior risco: login/tenant, campanha, jornada, opt-out e relatórios.
- Substituir as duas chamadas ativas de `window.confirm` por dialogs do sistema, conforme a regra já documentada.
- Dividir rotas monolíticas: `email.tsx`, `sms.tsx`, `whatsapp.tsx`, `players.tsx` e `midia-ltv.tsx` têm milhares de linhas e elevam o custo de revisão e teste.
- Avaliar code splitting do chunk principal e registrar orçamento de bundle/performance.

## 8. Estrutura documental recomendada

```text
README.md
docs/
  INDEX.md
  architecture/
    overview.md
    data-model.md
    tenancy-and-rbac.md
    jobs-and-integrations.md
  development/
    local-setup.md
    environment-variables.md
    testing.md
    migrations.md
    contributing.md
  operations/
    deployment.md
    runbook.md
    backup-restore.md
    monitoring-slo.md
    channel-acceptance.md
  product/
    operator-guide.md
    metrics-glossary.md
    campaigns-and-journeys.md
  api/
    public-endpoints.md
    webhooks.md
  decisions/
    ADR-*.md
  rfcs/
    active/
    delivered/
    archived/
  evidence/
```

## 9. Roteiro de execução recomendado

### Semana 1 — recuperar a fonte de verdade

1. Criar README e `docs/INDEX.md`.
2. Classificar os 17 documentos como atual, evidência ou histórico.
3. Atualizar plano geral, funil, jornadas, Short.io, operação segura e matriz de canais.
4. Corrigir `.env.example` e o deploy sem dados pessoais/específicos.
5. Registrar decisão operacional de voz por ambiente.
6. Abrir correção controlada das vulnerabilidades de dependências.

### Semana 2 — documentar o núcleo técnico

1. Criar arquitetura, dados, RBAC e integrações/jobs.
2. Documentar APIs/webhooks e idempotência.
3. Criar estratégia de testes e matriz multitenant.
4. Adicionar typecheck ao CI e baseline de warnings.

### Semanas 3 e 4 — fechar operação e produto

1. Executar a matriz real de SMS, e-mail e voz.
2. Executar o teste de usabilidade com três operadores.
3. Documentar backup/restore, SLOs e escalonamento.
4. Criar manual do operador, glossário de métricas e ADRs.
5. Automatizar checagem de links, cabeçalhos e documentos sem revisão.

## 10. Evidências técnicas desta revisão

| Verificação | Resultado em 09/10/2026 |
| --- | --- |
| `npm test` | aprovado: 15 arquivos, 48 testes |
| `npx tsc --noEmit` | aprovado |
| `npm run lint` | aprovado com 668 warnings |
| `npm run build` | aprovado; avisos de bundle/dependências presentes |
| `npx supabase migration list --linked` | 250 migrations locais e remotas alinhadas |
| `npx supabase db lint --linked` | nenhum erro de schema |
| `npm audit --omit=dev --audit-level=high` | falhou: 8 vulnerabilidades, 4 altas e 4 moderadas |
| Busca por BusinessCode no runtime | nenhuma referência ativa em `src`, scripts ou configuração atual |
| Busca por dialogs nativos | duas ocorrências de `window.confirm` |

## 11. Critério de conclusão deste saneamento

O trabalho documental estará realmente concluído quando uma pessoa nova conseguir, apenas pelo repositório:

1. instalar e executar o sistema localmente;
2. compreender módulos, fluxos, dados e fronteiras de segurança;
3. identificar a fonte canônica de cada regra de negócio;
4. promover uma migration e uma release com rollback;
5. operar filas/webhooks/canais sem expor dados ou duplicar envios;
6. saber o que está implementado, homologado, certificado ou ainda pendente;
7. localizar evidências atuais sem interpretar planos antigos como estado do produto.
