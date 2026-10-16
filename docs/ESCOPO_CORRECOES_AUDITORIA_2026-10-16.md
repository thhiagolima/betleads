# Escopo de correções: auditoria completa de 16/10/2026

**Origem:** [AUDITORIA_COMPLETA_SISTEMA_2026-10-16.md](AUDITORIA_COMPLETA_SISTEMA_2026-10-16.md). Os IDs entre parênteses remetem aos achados de lá.
**Status:** proposto. Aguarda aprovação do responsável pelo produto.
**Princípio:** nenhuma funcionalidade nova entra até as Fases 0 e 1 estarem aceitas. "Código existe" não é o mesmo que "entregue". Cada item só fecha com a evidência pedida no critério de aceite, registrada no PR.

Esforço: **P** até 1 dia · **M** de 2 a 4 dias · **G** 1 semana ou mais. As estimativas são para uma pessoa e incluem os testes.

---

## Regras de execução (valem para todas as fases)

1. Uma branch e um PR por item ou grupo pequeno, com CI verde antes do merge. A `main` fica protegida (ver F2-01).
2. Todo item de segurança ou de envio entra com um teste que falha antes da correção e passa depois.
3. Qualquer escrita em produção (dados, configuração, migration) precisa de aprovação explícita, plano de rollback e registro em `docs/operacoes/AAAA-MM-DD_<tema>.md`.
4. O status vive num único lugar: a tabela da seção 8 deste documento, com o hash do commit e a evidência de cada item.
5. Deploys só em horário comercial. Jornadas novas ou alteradas passam pelo checklist de publicação (F3-05).

---

## Fase 0: contenção (até 3 dias úteis)

**Objetivo:** fechar os vazamentos entre casas, a CVE crítica e o opt-out quebrado.

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| F0-01 | **Desligar a edge function `ai-player-insights`** (ou bloquear a tela Inteligência) até o F0-02 | SEC-10, DEV-40 | Uma chamada à função devolve 503 ou a tela mostra "indisponível". Verificado em produção. | P |
| F0-02 | Corrigir a edge function. Resolver o tenant ativo, autorizar com `is_tenant_admin(tenant)`, aplicar `.eq("tenant_id")` em todas as consultas, filtrar sinônimos e treino por tenant e gravar `tenant_id` em `ai_logs` | SEC-10, SEC-26 | Teste com duas casas: o admin de A não recebe nenhuma linha de B. Grep sem consulta a `players`/`deposits`/`withdrawals` sem tenant. | M |
| F0-03 | **Filtrar por tenant as campanhas de e-mail.** Aplicar `tenant_id` em `loadPlayersForSegment` e no modo "leads" | DEV-62 | Teste com duas casas: a campanha "Todos" de A só resolve jogadores de A. | P |
| F0-04 | Varredura do uso de `supabaseAdmin` em consultas a tabelas por tenant. Listar e corrigir todas as que não têm `tenant_id` | DEV-62, SEC-15, SEC-25 | Relatório anexado ao PR com zero ocorrências sem justificativa. | M |
| F0-05 | **Atualizar o TanStack Start** para a versão 1.169.39 ou superior e rodar `npm audit fix` nas dependências de runtime | SEC-11, DEV-26 | `npm audit --omit=dev` sem crítica nem alta em runtime; build e testes verdes. | P |
| F0-06 | Restringir `configureEvolutionWebhook`, `diagnoseEvolution`, `getEvolutionRealtimeConfig` e `testWhatsappProxy` a super admin; nunca devolver token nem chave; tornar `EVOLUTION_WEBHOOK_SECRET` obrigatório, aceito só por header. **Rotacionar** o segredo e a chave da Evolution | SEC-13, SEC-17, SEC-29 | Teste: um member recebe 403. Rotação registrada. O webhook antigo com `?token=` é recusado. | P |
| F0-07 | Integração externa do WhatsApp: exigir admin/gestor, aceitar só https, bloquear IP privado ou link-local depois da resolução de DNS, usar `redirect:"manual"` e não persistir o corpo da resposta | SEC-12, DEV-70 | Teste com `http://169.254.169.254` e `http://localhost` recusados; um member recebe 403. | M |
| F0-08 | `has_role('admin')` passa a respeitar o tenant: trocar por `is_tenant_admin(tenantId)` em `resetDashboards`, `requireAdmin` do SMS e nas políticas de storage | SEC-21, DEV-51 | Teste: um usuário admin em A e member em B recebe 403 em B. | P |
| F0-09 | IDOR em `deleteWhatsappSession`: lançar erro se a sessão não for do tenant e incluir `tenant_id` nas exclusões | SEC-15 | Teste: apagar uma sessão de outra casa é recusado. | P |
| F0-10 | **Verificar em produção (somente leitura)** se a SEC-01 e a CON-08 estão aplicadas, consultando `schema_migrations`. Se faltarem, aplicar seguindo o rollout da SEC-01 §9 | SEC-14 | Saída da consulta anexada; os cabeçalhos dos documentos foram atualizados. | P |
| F0-11 | Verificar e **desligar o signup público** do Supabase Auth | SEC-31 | Print da configuração; um `signUp` com a chave publicável é recusado. | P |
| F0-12 | **Opt-out de e-mail funcionando.** Corrigir o upsert de `suppressed_emails` (constraint ou RPC com `ON CONFLICT (lower(email))`), chave por `(tenant_id, email)`, comparação exata sem `ilike`, checagem do `{error}` | QA-01, QA-18, SEC-18 | Teste PGlite **sobre a migration real**: o descadastro grava, audita e bloqueia o envio seguinte; um descadastro em B não afeta A. | M |
| F0-13 | **Consentimento fail-closed** em `email-send`, `isSuppressed`, `isSmsSuppressed` e `checkContactFrequencyLimit` | QA-03, QA-16 | Teste: com erro do banco, o envio é adiado e nunca enviado. | P |
| F0-14 | Corrigir `isSmsSuppressed` para usar o formato da tabela | QA-04 | Teste com "+55…" e só dígitos. | P |
| F0-15 | **Mitigação imediata do SAIR.** Enquanto o F1-01 não sai, tirar a promessa "responda SAIR" dos textos e da UI, ou manter uma lista de bloqueio manual operada pelo suporte | QA-02, RSK-01 | Os textos foram revisados, ou existe processo manual documentado. | P |
| F0-16 | Avaliar se houve exposição real: consultar logs de uso da tela Inteligência e de campanhas de e-mail "Todos" desde a criação | RSK-03 | Relatório para o DPO com a decisão sobre comunicação à ANPD. | P |

**Saída da Fase 0:** nenhuma consulta por tenant via service_role sem filtro, CVE fechada, segredos rotacionados, opt-out de e-mail persistindo.

---

## Fase 1: envio confiável e conformidade (2 semanas)

**Objetivo:** nenhum SMS, e-mail ou ligação duplicada, nenhuma configuração de uma casa vazando para outra, opt-out completo.

### 1A. Conformidade

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| F1-01 | **Capturar SAIR/PARAR/STOP/CANCELAR** no `sms-webhook`: parser de MO, revogação em `channel_consents` do tenant do log casado, auditoria e encerramento das inscrições de jornada | QA-02, PM-BL-07/08 | Testes com payloads reais da Short Brasil. Charter CH-1 executado em homologação: o envio seguinte é bloqueado em menos de 5 min. | M |
| F1-02 | Revogação de consentimento encerra a inscrição (`consent_revoked` no sweep de saídas) | PM-BL-08 | Teste PGlite. | P |
| F1-03 | Escapar as variáveis de template em HTML e trocar o sanitizador por allowlist (`sanitize-html`) | SEC-20 | Teste: um nome com `<a href>` aparece como texto. | P |
| F1-04 | Bloquear o envio quando sobrar uma variável não resolvida; restringir as variáveis de ligação ao contexto de ligação | QA-09 | Teste: `{atendeu}` em SMS é rejeitado no salvamento. | P |
| F1-05 | Links `{link}`, `{link_deposito}` e `{link_login}` por tenant; bloquear o envio se não houver link configurado | QA-08 | Teste com duas casas. | M |
| F1-06 | Datas nas mensagens em `America/Sao_Paulo`; `TZ` fixado no Dockerfile; uso de `tz.ts` em todo cálculo de dia | QA-10, DEV-19, DEV-74 | Teste com o relógio em 22:30 BRT e `TZ=UTC`. | P |
| F1-07 | Exportações de PII: neutralizar fórmulas, separador `;` com BOM, restringir a admin, auditoria funcionando para admin de tenant | SEC-24, QA-14, UX-30, §3.2 | Teste com o nome `=1+1`. Registro de auditoria criado. | P |
| F1-08 | Papel admin/gestor nas ações sensíveis: Meta, antiban, importação de consentimento, sessões WhatsApp, envio de teste e envio em massa. Rate limit por usuário e por casa no `sendTestEmail` e no `sendTestSms` | SEC-16, SEC-23, DEV-52 | Matriz de papéis × funções com teste para cada uma. | M |
| F1-09 | Webhooks: HMAC obrigatório com timestamp e anti-replay para as casas, em modo monitor seguido de enforce; tokens só por header onde o provedor permitir; remover CORS `*`; GET sem efeito colateral; limite de tamanho do corpo; o token de e-mail não cai mais no de voz | SEC-22, DEV-59, JRN-14 | Testes de assinatura inválida, replay e corpo grande. Plano por casa acordado. | M |

### 1B. Isolamento de configuração por casa

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| F1-10 | Janela de envio por tenant em todos os call sites; UI lê e grava só a janela da própria casa; validar timezone e minutos | QA-05, QA-06, DEV-68 | Teste com A (9–20) e B (8–21) nos fluxos de SMS, e-mail, call-flow e e-mail-campaign. | P |
| F1-11 | Pausa e antiban por tenant (`isPaused`, `getAntibanSettings`); o worker de campanha respeita a pausa | SMS-02, DEV-68 | Teste: a pausa em A não afeta B. | P |
| F1-12 | **Falta de crédito pausa só a casa afetada**, com um `errorKind: insufficient_credits` próprio; a pausa global fica reservada ao breaker do provedor | SMS-01 | Teste: A sem saldo, B continua enviando. | P |
| F1-13 | A campanha para ao ficar sem crédito (`retryable`), sem queimar o público restante | SMS-05 | Teste: depois da recarga, a campanha retoma do cursor. | P |
| F1-14 | Créditos SMS usam o tenant ativo, não o primeiro `user_roles` | DEV-53 | Teste com usuário de duas casas. | P |

### 1C. Idempotência e duplicidade

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| F1-15 | SMS unitário com a mesma política do bulk: sem retry em 5xx; timeout vira `unconfirmed` sem estorno e sem reenvio; write-ahead do log | SMS-03, DEV-66 | Teste: ECONNRESET depois do aceite não gera segundo envio. | M |
| F1-16 | `deliveryKey` determinística nos fluxos de SMS e e-mail e no `resendFailedSms`; índice único em `sms_send_logs.idempotency_key` | SMS-04, DEV-58, DEV-66 | Teste de retry: um envio, uma cobrança. | P |
| F1-17 | Campanha de e-mail com chave `(campaign, player)`; o tick e o recover não reenviam a quem já recebeu | DEV-63 | Teste: reexecutar a campanha não gera envio novo. | P |
| F1-18 | Fila de voz com claim atômico, chave de idempotência e "outcome unknown" sem retry | DEV-64 | Teste com dois workers concorrentes. | M |
| F1-19 | WhatsApp com claim `FOR UPDATE SKIP LOCKED`, contador atômico e limite no resume; remover `bypassWindow`. **Ou** descomissionar o WhatsApp (ver decisão D-07) | DEV-65, UX-06 | Teste de concorrência, ou rotas e código removidos. | M |
| F1-20 | Envio imediato de campanha inserido já travado, sem corrida com o cron | SMS-06 | Teste. | P |
| F1-21 | Precedência de status nos callbacks de SMS e de e-mail Infobip (`delivered` não regride) | SMS-07, DEV-77 | Teste com callbacks fora de ordem. | P |
| F1-22 | Cashback catch-up idempotente por pagamento, paginado, com erros tratados | JRN-01, JRN-02 | Teste: N execuções no mesmo dia geram 1 envio. | P |
| F1-23 | Enfileiramento de flows via upsert (3 lugares); `activation_runs` sem check-then-insert | DEV-57, DEV-80 | Teste de corrida. | P |
| F1-24 | Migrar o SMS para a API nova com TLS (`SHORTCODE_SMS_TOKEN`) e desligar o host HTTP legado | DEV-67 | Envio real em homologação pela API nova; o host legado não é mais referenciado. | P |

### 1D. Jornadas

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| F1-25 | `ends_at` checado no dispatcher e no claim; jornadas encerradas saem do scan e do crossing | JRN-03 | Teste PGlite: nenhum envio depois de `ends_at`. | P |
| F1-26 | Limite global 24h/7d conta as execuções reservadas; o cap por jogador exclui só o passo atual | JRN-04, JRN-05 | Teste de duas reservas concorrentes. | M |
| F1-27 | **Passo de voz da jornada obedece a `VOICE_DISPATCH_ENABLED`**; adiamento de voz não consome tentativa; `max_attempts`/`retry_delay` da UI passam a valer ou são removidos | PM-BL-06, JRN-06 | Teste com a flag desligada: nenhuma ligação. | P |
| F1-28 | Schema zod para `entry_rules`: janela inválida é rejeitada (fail-closed); `start==end` é rejeitado | JRN-11 | Teste. | P |
| F1-29 | Sweep de saídas e retomada de prioridade com escopo de tenants, ordem e índice | JRN-10 | EXPLAIN anexado; teste com mais de 1000 candidatos. | M |
| F1-30 | Chunks de 100 em `recentCooldownPlayers`; clamps de batch em no máximo 1000 | JRN-07, JRN-08 | Teste com 2000 IDs. | P |
| F1-31 | Hard deadline espera o pool ou aborta os handlers antes de liberar o slot | JRN-12 | Teste. | M |
| F1-32 | Arbitragem de prioridade não pausa um concorrente com lease vivo | JRN-13 | Teste. | P |

**Saída da Fase 1:** a suíte nova de testes de envio e consentimento roda no CI e o charter CH-1 a CH-7 foi executado em homologação.

---

## Fase 2: ambientes, release e operação (1–2 semanas, em paralelo com o fim da Fase 1)

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| F2-01 | Proteger a `main`: PR obrigatório, CI verde, uma revisão; commitlint; `user.name` configurado | PM-01, PM-07, PM-08 | Push direto recusado. | P |
| F2-02 | **Ambiente de homologação** (projeto ou branch Supabase + compose separado + `.env` próprio) | PM-03 | O deploy de um PR em homologação está documentado. | M |
| F2-03 | Baseline de migrations a partir do schema de produção; `supabase db push` pelo CI com registro; backup antes de cada aplicação; arquivar as migrations destrutivas e com PII | DEV-17, DEV-18, DEV-41, DEV-48, DEV-49, PM-04 | O banco é recriado do zero em CI e o diff contra produção dá vazio. | G |
| F2-04 | Backup/PITR ativo e **teste de restauração**; RPO/RTO definidos | PM-BL-30 | Restauração testada e registrada. | M |
| F2-05 | Imagens com tag por versão num registry, CalVer, release no Sentry, runbook de rollback de app e de migration | PM-05, PM-12 | Rollback ensaiado em homologação. | M |
| F2-06 | Gates de CI: `--max-warnings` (meta decrescente), `npm audit`, diff de tipos Supabase, migrations num banco limpo, matrizes RLS CON-08/SEC-01, build Docker, smoke pós-deploy | DEV-32, QA-TC-16/17/18 | Workflow verde com todos os jobs. | M |
| F2-07 | Regenerar os tipos Supabase e remover os `eslint-disable` de arquivo inteiro | DEV-01 | `types.ts` atualizado; o job de diff passa. | P |
| F2-08 | Configurar e **testar** Sentry (DSN servidor e browser, alertas) e Better Stack (uptime + heartbeats); tirar os DSNs do `.env.example` e corrigir o typo `htps` | OBS-02..04, SEC-29, PM-BL-23 | Erro de teste visível no Sentry; job derrubado em homologação gera alerta em menos de 5 min. | P |
| F2-09 | HEALTHCHECK do Docker em `/api/public/health`; `.dockerignore` completo; porta só em 127.0.0.1; cabeçalhos CSP/HSTS/frame-ancestors | DEV-23, DEV-30, SEC-27 | `curl -I` mostra os cabeçalhos. | P |
| F2-10 | Retenção de dados: política por tabela (`webhook_logs`, `sms_send_logs`, `email_send_logs`, `click_events`, `events`, `sessions`, `ai_logs`, `journey_*`, `cron.job_run_details`) com expurgo agendado, depois de aprovação jurídica dos prazos | DEV-42, SEC-30, RSK-12 | Jobs de expurgo ativos; crescimento monitorado. | M |
| F2-11 | Criptografar as senhas de SMTP e de proxy e o `webhook_secret`; nunca devolvê-los à UI; segredos separados por finalidade (cron, clique, webhooks) | DEV-50, DEV-69, SEC-29 | Colunas criptografadas; grep sem retorno de segredo. | M |
| F2-12 | Pendências da SEC-01: `anon` sem DML no WhatsApp, `antiban` não gravável por membro, margem fora de `sms_effective_pricing`, RPCs de crédito só para `service_role`, `has_role` sem `_user_id` arbitrário, `(select has_tenant_access())` nas tabelas novas, rollback regenerado | §3.2, DEV-45, DEV-46 | Matriz SEC-01 regenerada no CI sem regressão. | M |
| F2-13 | Medir a CPU do Large por 24h (BASELINE P1–P5) e oficializar a meta revisada | PM-BL-28 | Relatório anexado. | P |
| F2-14 | Logger JSON com `run_id`/`tenant_id`, mascaramento de telefone e texto no stdout; `AsyncLocalStorage` para correlação de erro | DEV-16, DEV-24, DEV-75 | Log de um envio rastreável de ponta a ponta. | M |
| F2-15 | `fetch` com timeout em todos os adaptadores | DEV-71 | Grep sem `fetch(` sem `signal`. | P |
| F2-16 | Concluir o upgrade do Nitro (fixar versão); remover `bun.lock`/`bunfig.toml`, `wrangler.jsonc` e as dependências sem uso; `engines`/`packageManager` | DEV-25..29, DEV-08 | `npm ci` limpo; build ok. | P |
| F2-17 | Auditar a impersonação do super admin; `changeInitialPassword` só com a flag | SEC-28, SEC-32 | Testes. | P |

---

## Fase 3: aceite do que já foi construído e governança (2 semanas)

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| F3-01 | **Versionar a documentação**: inverter o `.gitignore` (versionar `docs/`, ignorar só `docs/private/`); converter `FLUXO CRM.docx` para Markdown; criar `docs/INDEX.md` e o README | PM-BL-31, DEV-37 | Todos os docs vigentes no git. | P |
| F3-02 | Reorganizar a documentação em `00-canonico/`, `adr/`, `escopos/`, `auditorias/`, `runbooks/`, `evidencias/`, `operacoes/` e `_arquivo/`; arquivar PLANO_DE_ENTREGAS, REAUDITORIA, STATUS_P0 e o Short.io fechado; atualizar os cabeçalhos conflitantes | §7.3, §7.4 | INDEX sem documento órfão; cabeçalhos com status padrão. | M |
| F3-03 | Documentos canônicos: arquitetura, ambientes, matriz RBAC, dicionário de dados, regras de negócio de jornadas (reconciliando o FLUXO CRM com as decisões de 15/10), ADRs das decisões já tomadas, política LGPD | PM-BL-31 | Revisados por uma segunda pessoa. | G |
| F3-04 | **Rodada de decisões com o negócio** (seção 7) e registro em ADR | PM-BL-17, §7.6 | Cada decisão com dono e data. | P |
| F3-05 | Checklist de publicação de jornada: janela, limites, término, textos aprovados, holdout, revisão por segunda pessoa | RSK-11 | Checklist em uso nas próximas publicações. | P |
| F3-06 | Matriz de aceite de canais atualizada para as **3 casas** (SMS, e-mail Infobip com SPF/DKIM/DMARC, voz com callback final), com assinaturas | PM-BL-03, PM-BL-05, MATRIZ | 21 cenários × 3 casas com evidência. | M |
| F3-07 | Aceite de negócio das regras P0–P3 de jornadas e F0–F5 da Central, com evidência por tenant | PM-BL-18 | Termo assinado. | M |
| F3-08 | Correções de dados da RECUPERACAO (6 `ultimo_login`, 71+106 depósitos, 25 inscrições, 9 recibos); RPC que não sobrescreve depósito aprovado; `greatest()` em `ultimo_login` | PM-BL-27, WHK-04 | Script revisado, aplicado com aprovação e com rollback. | M |
| F3-09 | Revisar, commitar ou descartar `scripts/sync-sortealta-export.mjs`, incluindo a correção de `ftd_em` (D-14) e o ajuste dos 203 jogadores | DEV-39, PM-BL-16 | PR revisado. | P |
| F3-10 | Teste moderado com 3 operadores, incluindo "falar com um jogador pela ficha" e "achar o histórico de voz" | PM-BL-32 | Resultados registrados e go/no-go. | M |
| F3-11 | Selo "não homologado" nos números de receita da Central até a homologação de atribuição com as casas (P0.4) | RSK-07 | Selo visível. | P |
| F3-12 | Central: corrigir a contagem de distintos do período, paginar a retenção, mostrar o erro do holdout e calcular o "Retorno sobre o envio" com o custo de todos os canais | QA-11, QA-12, QA-13, UX-24 | Testes com mais de 1000 linhas e com jogador em vários dias. | M |
| F3-13 | Uma atribuição por evento (chave sem `classification`); token sem destinatário não credita qualquer jogador | QA-15 | Teste de reprocessamento. | P |

---

## Fase 4: UX e acessibilidade (2–3 semanas)

| ID | Item | Achados | Critério de aceite | Esf. |
|---|---|---|---|---|
| F4-01 | **Confirmações de risco:** resetar `riskConfirmed` a cada mudança, botão "Enviar para N · N créditos", digitar o número acima de 1000; mesmo padrão nas ligações em massa | UX-03, UX-04 | Teste de componente. | P |
| F4-02 | Confirmação com consequência para rotacionar e exigir HMAC | UX-02 | Diálogo; bloqueio sem evento assinado. | M |
| F4-03 | `requestConfirmation` em toda exclusão, remoção ou cancelamento, desfazer onde couber, fim do `window.confirm`; o Cancelar do composer passa a confirmar | UX-12, UX-50, §6.1 | Grep sem `window.confirm`. | P |
| F4-04 | Remover ou ligar a dados reais a página Configurações | UX-01 | Nenhum controle sem efeito real. | M |
| F4-05 | Componente `<QueryState>` (carregando, erro com retry, vazio, sem permissão) aplicado em todas as páginas; relatório de campanha com saída | UX-10, UX-13, UX-14 | Inventário de páginas com nota ≥ 3. | M |
| F4-06 | Destinos de CTA válidos com `<Link>`; abas visíveis por canal (Visão geral, Biblioteca, Histórico); decisão sobre rotas órfãs | UX-05, UX-07, UX-22, UX-44 | Teste hash × aba. | M |
| F4-07 | Remover código morto (WhatsApp se descomissionado, componentes legados de sms/email, módulos e server functions sem chamador, componentes shadcn sem uso) | UX-08, DEV-04..07 | Redução de linhas registrada; nenhum caminho legado de envio alcançável. | M |
| F4-08 | Barra de ações na ficha do jogador | UX-09 | Fluxo "enviar SMS pela ficha" em menos de 3 cliques. | M |
| F4-09 | Acessibilidade: `<Label htmlFor>` no editor de jornada e em todos os forms, `aria-label` em todo botão de ícone, sidebar mobile com `inert`/Esc, link "pular para o conteúdo", status não só por cor, teclado em linhas clicáveis, sidebar recolhida funcional; regras jsx-a11y no lint | UX-11, UX-17, UX-31..33 | axe sem violação séria nas 10 rotas principais. | M |
| F4-10 | Páginas 404 e de erro em pt-BR; remover as referências à Lovable; `<title>` por rota | UX-18, UX-48 | Revisão visual. | P |
| F4-11 | Editor de jornada: espera em min/h/dias, reordenar, chave estável, desfazer, origem padrão vinda do tenant (sem o telefone fixo), guarda de alterações, aviso ao editar jornada ativa | UX-27, UX-28 | Teste de usabilidade. | M |
| F4-12 | Arquitetura de informação: glossário (Jogador, E-mail, Jornada, Campanha, Conta), rótulos de rota numa fonte única, sidebar reorganizada, títulos do cabeçalho | UX-19..21, UX-39 | Grep de termos proibidos sem resultado. | M |
| F4-13 | Analytics: Início vira "pulso" e a Central passa a fonte única de resultado do CRM; métricas com nome único e tooltip; período e aba da Central na URL; seletor de conta duplicado removido | UX-23, UX-45, UX-46 | Revisão com o negócio. | M |
| F4-14 | Gráficos: corrigir as 49 cores inválidas, wrapper `<Chart>` com tooltip, unidade, `aria-label` e "ver como tabela" | UX-25, UX-26 | Contraste validado. | M |
| F4-15 | Design system: tokens `success/warning/info/danger`, `PageContainer`, consolidar `MetricCard`/`StatusBadge`/`EmptyState`, só lucide, `color-scheme: dark`, texto mínimo de 12px | UX-34..38, UX-47 | Lint contra a paleta crua; redução de reimplementações. | G |
| F4-16 | Texto e formatação: acentos, mojibake, `pct()`/`dateTime()` pt-BR, fim do `toFixed` na UI | UX-40, UX-41 | Grep. | P |
| F4-17 | Oportunidades: SMS pela plataforma; "bônus" desabilitado até haver integração | UX-29 | — | P |
| F4-18 | Consentimentos: select de bases legais LGPD, evidência obrigatória para autorização manual, CSV em pt-BR | UX-42 | — | M |
| F4-19 | Jogadores: alertas calculados no servidor; exportação do filtro inteiro pelo servidor | UX-16, UX-30 | Página com 100 mil jogadores em menos de 2 s. | G |
| F4-20 | Públicos salvos como filtro de entrada de jornada | UX-15 | — | G |

---

## Fase 5: dívida técnica e escala (contínua)

| ID | Item | Achados | Esf. |
|---|---|---|---|
| F5-01 | Serviço único de envio SMS (`sms-send.server.ts`) e inversão de camadas | DEV-12, DEV-58 | G |
| F5-02 | Dividir os arquivos-deus (email, sms, players, midia-ltv, whatsapp.functions, sms.functions, journeys.server, webhook-process) | DEV-02, DEV-03 | G |
| F5-03 | Uma camada única de métricas e conversão | DEV-10 | M |
| F5-04 | Paginação correta em todas as consultas sujeitas ao limite de 1000 linhas | DEV-55, JRN-09 | M |
| F5-05 | Cache server-side seguro: chave obrigatória, LRU, invalidação | DEV-15 | M |
| F5-06 | Erros sanitizados ao cliente; convenção única de tratamento | DEV-54 | M |
| F5-07 | `no-explicit-any` como erro em `*.server`/`*.functions`; `no-unused-vars`; knip no CI | DEV-33, DEV-34 | G |
| F5-08 | Índices faltantes e duplicados; filtro por intervalo em `refresh_tenant_daily_metric_day` | DEV-43, DEV-44 | P |
| F5-09 | Cobrança por segmento GSM-7/UCS-2, exibida no composer | SMS-09 | M |
| F5-10 | Públicos com mais de 20 mil contatos: campanha criada a partir do critério no servidor | SMS-11 | M |
| F5-11 | Interface comum de provedor e credenciais por tenant | DEV-72 | G |
| F5-12 | Dinheiro: agregação em SQL, incremento atômico, parser de valor no formato BR | DEV-20, DEV-73 | P |
| F5-13 | Itens de escala pendentes: WHK-02..06, TRK-01..05, DLQ de jornada, teste de carga com 100 mil jogadores, Short.io incremental | PM-BL-20..25 | G |
| F5-14 | E2E com Playwright nas rotas críticas e cobertura com limiar progressivo | QA-TC-17/18 | M |
| F5-15 | Testes sem relógio real (Q-1, Q-2), `TZ` fixado no vitest, PGlite sobre as migrations reais | Q-1..Q-4 | M |
| F5-16 | Itens adiados pelo cliente: cashback D+1, teto diário de gasto, estado `completed`, descarte de passos vencidos ao retomar, inventário de templates | PM-BL-09..14 | M |

---

## 7. Decisões necessárias (bloqueiam itens)

| ID | Decisão | Bloqueia | Responsável sugerido |
|---|---|---|---|
| D-01 | Congelamento de novas frentes até o fim das Fases 0 e 1 | todo o roadmap | Produto |
| D-02 | Comunicação de incidente à ANPD/clientes se o F0-16 encontrar exposição real | F0-16 | DPO / jurídico |
| D-03 | Canal de opt-out SMS: a Short Brasil encaminha MO? | F1-01 | Produto + fornecedor |
| D-04 | Prazos legais de retenção por tipo de dado | F2-10 | Jurídico |
| D-05 | Revisão jurídica das réguas (reativação, até 6 SMS/dia, textos de "lucro"), aviso 18+, integração da autoexclusão da casa | F3-03, F3-05 | Jurídico do cliente |
| D-06 | Holdout padrão, janela influenciada, faixas de inatividade, métrica principal de ROI, glossário da Central | F3-04, F3-12 | Produto + casas |
| D-07 | WhatsApp: descomissionar ou trazer para o padrão | F1-19, F4-07 | Produto |
| D-08 | Teto diário de gasto por casa/jornada e preço por casa | F5-16 | Financeiro |
| D-09 | Orçamento para homologação e backup/PITR | F2-02, F2-04 | Gestão |
| D-10 | Segundo dono técnico ou revisor | F2-01 | Gestão |
| D-11 | Quem assina o aceite de jornadas P0–P3 e da Central F0–F5 | F3-07 | Produto |

---

## 8. Quadro de status (fonte única)

Atualize a cada PR. Estados: `Pendente` · `Em andamento` · `Implementado` · `Homologado` · `Aceito`.

| Fase | Itens | Pendente | Em andamento | Implementado | Homologado | Aceito |
|---|---:|---:|---:|---:|---:|---:|
| F0 Contenção | 16 | 4 | 12 | 0 | 0 | 0 |
| F1 Envio e conformidade | 32 | 32 | 0 | 0 | 0 | 0 |
| F2 Ambientes e operação | 17 | 17 | 0 | 0 | 0 | 0 |
| F3 Aceite e governança | 13 | 12 | 0 | 1 | 0 | 0 |
| F4 UX e acessibilidade | 20 | 16 | 4 | 0 | 0 | 0 |
| F5 Dívida técnica | 16 | 16 | 0 | 0 | 0 | 0 |

Itens que não aparecem na tabela abaixo estão `Pendente`.

| ID | Estado | PR/commit | Evidência | Data |
|---|---|---|---|---|
| F0-01 | Pendente | | | |
| F0-02 | Em andamento | | | 16/10/2026 |
| F0-03 | Em andamento | | | 16/10/2026 |
| F0-04 | Em andamento | | | 16/10/2026 |
| F0-05 | Em andamento | | | 16/10/2026 |
| F0-06 | Em andamento | | | 16/10/2026 |
| F0-07 | Em andamento | | | 16/10/2026 |
| F0-08 | Em andamento | | | 16/10/2026 |
| F0-09 | Em andamento | | | 16/10/2026 |
| F0-10 | Pendente | | | |
| F0-11 | Pendente | | | |
| F0-12 | Em andamento | | | 16/10/2026 |
| F0-13 | Em andamento | | | 16/10/2026 |
| F0-14 | Em andamento | | | 16/10/2026 |
| F0-15 | Em andamento | | | 16/10/2026 |
| F0-16 | Pendente | | | |
| F3-01 | Implementado | branch `docs/f3-versioning` (2637709, a5898f5, 547b61a) | `.gitignore` invertido (só `docs/private/` ignorado); todos os docs de `docs/` no git, sem segredo nem PII; `FLUXO_CRM.md` convertido; `docs/INDEX.md` e `README.md` criados | 16/10/2026 |
| F3-02 | Pendente | | Parcial no F3-01: cabeçalhos de CON-08, SEC-01 e STATUS_P0 receberam nota; estrutura de pastas proposta no INDEX | |
| F4-01 | Em andamento | | | 16/10/2026 |
| F4-02 | Em andamento | | | 16/10/2026 |
| F4-03 | Em andamento | | | 16/10/2026 |
| F4-10 | Em andamento | | | 16/10/2026 |

---

## 9. Cronograma indicativo (1 desenvolvedor + revisor)

| Semana | Foco |
|---|---|
| S1 (19–23/10) | Fase 0 completa; início da F2-01/F2-02 |
| S2–S3 (26/10–06/11) | Fase 1 (1A, 1B, 1C); F2-02..F2-08 em paralelo |
| S4 (09–13/11) | Fase 1 (1D) e fim da Fase 2; charters CH-1 a CH-7 em homologação |
| S5–S6 (16–27/11) | Fase 3 (aceite, docs, decisões); repetir V-03/D-15 da Central com 30 dias de dados |
| S7–S9 (30/11–18/12) | Fase 4 (UX e a11y) |
| Contínuo | Fase 5 |

Com dois desenvolvedores, as Fases 2 e 4 andam em paralelo com as Fases 1 e 3, e o total cai para cerca de 5 semanas.
