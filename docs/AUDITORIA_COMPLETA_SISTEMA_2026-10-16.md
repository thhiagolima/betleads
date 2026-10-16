# Auditoria completa do Betleads — UX, Dev, Red Team, QA e Gestão de Projeto

**Data:** 16/10/2026
**Base auditada:** `main` @ `eb66bd0` + alteração não commitada em `scripts/sync-sortealta-export.mjs`
**Método:** análise estática do repositório (código, 304 migrations, 31 documentos, histórico git de 275 commits) por cinco frentes independentes, com verificação cruzada. Suíte de testes, typecheck e lint executados localmente com todos os endpoints externos apontados para `127.0.0.1:9`. **Nada foi alterado em produção, em provedores ou no código.**
**Escopo de produção:** não consultado. Itens que dependem do estado real do banco/env estão marcados **A verificar**.
**Documento de execução:** [ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md](ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md)

Legenda de confiança: **Confirmado** (lido no código/execução; os críticos foram reverificados manualmente) · **Provável** (forte evidência estática, depende de dados/config) · **A verificar** (depende de produção).
Severidade: Crítica · Alta · Média · Baixa.

---

## 1. Resumo executivo

O Betleads tem um núcleo de jornadas bem projetado (leases, idempotência de entrega, fail-closed, canário), RLS em 100% das tabelas, typecheck limpo e 580 testes passando. **Porém existem falhas de isolamento entre casas, de conformidade (opt-out) e de envio duplicado que precisam ser tratadas antes de qualquer nova funcionalidade.**

### 1.1 Os 12 problemas mais graves

| # | Problema | Sev. | Conf. | Fonte |
|---|---|---|---|---|
| 1 | **Edge function `ai-player-insights` devolve nome, telefone e saldos de jogadores de TODAS as casas** a qualquer admin de qualquer casa (service_role, sem filtro de tenant, `has_role('admin')` ignora tenant) | Crítica | Confirmado | SEC-10 / DEV-40 |
| 2 | **Campanha de e-mail envia para jogadores de outras casas**: `loadPlayersForSegment` e o modo "leads" consultam `players` via service_role sem `tenant_id` | Crítica | Confirmado | DEV-62 |
| 3 | **XSS refletido sem autenticação no TanStack Start** (GHSA-qx66-fv34-fjm8, CVSS 9.3; instalado 1.169.35 < 1.169.39), com JWT em `localStorage` e sem CSP → tomada de conta, inclusive super admin | Crítica | Confirmado | SEC-11 |
| 4 | **Opt-out "SAIR" por SMS não é processado**: resposta vira `delivered`; 0 supressões em produção; a UI promete o contrário | Crítica (LGPD) | Confirmado | QA-02 / SEC-19 / RSK-01 |
| 5 | **Falta de crédito de UMA casa pausa o SMS de TODAS** (402 interno → `dispatch_pause_state` sem filtro de tenant + throttle global 30 min) | Crítica | Confirmado | SMS-01 |
| 6 | **Opt-out de e-mail não persiste**: upsert com `onConflict:"email"` contra índice em `lower(email)` sempre falha; erro ignorado; revogação na UI dá erro e não audita | Alta | Confirmado (reproduzido em PGlite) | QA-01 / SEC-18 |
| 7 | **Segredo/chave global da Evolution entregue a qualquer usuário logado** (`configureEvolutionWebhook` devolve URL com token; fallback para `EVOLUTION_API_KEY`) → controle de todas as instâncias WhatsApp | Alta | Confirmado | SEC-13 |
| 8 | **SSRF + exfiltração de PII** pela URL de integração externa do WhatsApp, configurável por qualquer membro, com corpo da resposta legível | Alta | Confirmado | SEC-12 / DEV-70 |
| 9 | **Envios duplicados**: retry em 5xx/timeout no SMS unitário, fluxos SMS sem `deliveryKey`, campanha de e-mail com UUID novo a cada execução, fila de voz sem claim, WhatsApp sem claim atômico, cashback catch-up reinscrevendo no mesmo dia | Alta | Confirmado | SMS-03/04, DEV-63/64/65/66, JRN-01 |
| 10 | **Janela de envio, pausa e antiban da casa principal aplicados a todas as casas**; `updateSendWindow` de super admin sobrescreve todas | Alta | Confirmado | QA-05 / DEV-68 / SMS-02 |
| 11 | **Data de término da jornada não é respeitada no envio** (só na entrada e num sweep best-effort com LIMIT 1000) | Alta | Confirmado | JRN-03 |
| 12 | **Operação sem rede de segurança**: sem homologação, migrations aplicadas à mão, sem backup/PITR testado, sem rollback de imagem, tudo direto na `main`, docs de escopo fora do git | Alta | Confirmado | PM-01..04, DEV-17 |

### 1.2 Números

| Indicador | Valor |
|---|---|
| Achados registrados | **≈ 260** (UX 51 · Dev 80 · Red Team 25 · QA 19 + 28 pipeline · PM 12 + 11 riscos + backlog) |
| Críticos | 9 (após deduplicação: 5 problemas distintos) |
| Testes | 61 arquivos · **580 testes · 100% passando** (67,7 s) |
| Typecheck | ✅ 0 erros |
| Lint | 0 erros · **700 warnings** (664 `no-explicit-any`) |
| `npm audit` | 8+ vulnerabilidades (1 crítica: TanStack Start; altas: undici, sharp/librsvg, nitro beta) |
| Cobertura de módulos | ~55 de 174 módulos de `src/lib`/`api` importados por algum teste |
| Commits | 275 em 31 dias; 91 nos últimos 4 dias; 25% entre 22h e 6h; 0 merges/PRs |
| Docs | 31 arquivos; 5 escopos vigentes **não versionados** (`.gitignore: docs/*`) |
| Itens de escopo declarados "feitos" sem evidência de aceite | ~70% dos itens entregues em 13–16/10 |

### 1.3 Nota por dimensão

| Dimensão | Nota (1–5) | Leitura |
|---|---:|---|
| Segurança e isolamento entre casas | **2** | RLS sólida, mas service_role sem filtro em 3 caminhos críticos e CVE crítica não corrigida |
| Conformidade (LGPD / publicidade de apostas) | **1,5** | Opt-out SMS inexistente, opt-out e-mail quebrado, sem retenção, sem jogo responsável |
| Confiabilidade de envio | **3** | Jornadas e campanhas SMS boas; fluxos legados, e-mail, voz e WhatsApp sem idempotência |
| Qualidade de código | **3** | Strict + typecheck limpo; arquivos-deus, tipos gerados desatualizados, 813 `any` |
| Testes | **2,5** | Bons testes de jornada; nada de E2E, consentimento, janela, créditos, webhooks |
| UX/UI | **2,5** | Bons padrões pontuais; maquete em Configurações, confirmações faltando, abas escondidas |
| Acessibilidade | **2** | Rótulos ausentes, 52 de 61 botões-ícone sem nome, sidebar mobile sem `inert` |
| Processo e governança | **1,5** | Sem PR, sem staging, sem release, docs fora do git, aceite inexistente |
| Observabilidade | **3** | Sentry/health/heartbeats no código; configuração em produção não evidenciada |

---

## 2. Retrato do sistema

### 2.1 Arquitetura

- **Front-end:** React 19 + TanStack Router, 41 rotas `.tsx`, shadcn/Radix + `ui-premium`, tema escuro fixo.
- **Server functions:** 304 `createServerFn` em 50 arquivos `src/lib/*.functions.ts` (+2 em `u.$token.tsx`). Todas as 302 de `lib` usam `requireSupabaseAuth`; `x-active-tenant` é revalidado no SQL por `current_tenant_id()`.
- **Servidor:** `*.server.ts` — dispatchers (SMS, bulk, campanha, precall), jornadas (scanner, crossing, dispatcher, orchestrator), adaptadores (Short Brasil, Infobip, Evolution, Short.io, Meta, ElevenLabs, gateway de IA), `webhook-process`, rate-limit/breaker.
- **Rotas públicas:** `src/routes/api/public/**` — webhooks das casas, SMS, Infobip, Evolution, clique first-party, ticks de cron, health.
- **Banco:** Supabase Postgres (compute **Large** desde 14/10), ~140 tabelas, 115 funções `SECURITY DEFINER` (todas com `search_path`), pg_cron + pg_net, edge function `ai-player-insights`.
- **Runtime:** Nitro `node-server`, Node 22, Docker no VPS, Sentry via `instrument.mjs`.

**Fluxo de dados:** casa → webhook com token → `webhook_logs` → `webhook-process` → `players`/`deposits` → pg_cron chama `hooks/*` → scanner/dispatcher → provedores → callbacks + `click_events` → atribuição → `crm_results_daily` → Central de Resultados.

### 2.2 Jobs de cron (17 efetivos)

| Frequência | Jobs |
|---|---|
| 1 min | dispatch sms / email / call / journey, scan-journeys, journey-crossing, shortio-sync, webhook-replay, outbox SQL |
| 2 min | recovery |
| 5 min | orchestrate-tenants (1 POST por tenant, sem filtrar inativos), meta-sync, refresh-dashboard-metrics |
| 10 min | crm-results-recent |
| Diário | crm-results-week (06:20 UTC), crm-results-health (06:40), reconcile-infobip-voice (09:00) |
| Ausente | `email-campaigns/tick` (sem cron em migration), `cashback-catchup` (não encontrado), dispatch-whatsapp (removido) |

Todos usam o mesmo `betleads_cron_secret` (Vault) e URL fixa `https://betleads.io` em 13 migrations.

### 2.3 Integrações

| Integração | Módulos | Entrada | Observação |
|---|---|---|---|
| Short Brasil (SMS) | sms.functions, sms-dispatcher, sms-bulk, sms-campaign-dispatch | sms-webhook | Transporte legado **HTTP sem TLS** provavelmente ativo (DEV-67) |
| Infobip e-mail | infobip-email, email-send | infobip/email/events | Sem evidência de envio real aceito |
| Infobip voz + ElevenLabs | infobip-voice, calls.* | infobip/voice/{cml,events,reconcile} | Callback final não comprovado |
| Evolution (WhatsApp) | evolution, whatsapp-* | evolution-webhook | Oculto na navegação, mas vivo no código e com falhas graves |
| Short.io | shortio.server | shortio/sync (cron) | Sync O(n) por link |
| Meta | meta.functions | meta-sync/tick | `access_token` na URL de paginação |
| IA (Lovable gateway / Gemini / OpenAI) | ai-gateway, ai.functions, email-ai, edge function | — | PII enviada; sem limite de custo |
| Casas | webhook-process | webhook/$token/$evento | Token na URL; HMAC disponível mas nenhuma casa usa |

### 2.4 Pontos fortes (consolidado)

- **Pipeline de jornadas** é o melhor desenho do sistema: lease com renovação, slot de worker, `reserve_journey_delivery_v2` reaproveitando chave do provedor, `UNIQUE(idempotency_key)` e `UNIQUE(enrollment_id, step_position, attempt)`, backoff, flag fail-closed e canário.
- **Campanhas SMS** com claim, chave determinística e cursor; **créditos** em ledger com `UNIQUE(tenant_id, idempotency_key)`; claims de fluxos com `SKIP LOCKED`.
- **RLS universal** (140/140 tabelas), CON-08/SEC-01 com matrizes geradas, rollback e testes negativos.
- **Crons** com segredo só por header, comparação em tempo constante, segredo no Vault.
- **Redirect de clique** assinado por HMAC, sem open redirect; legado sem token responde 410.
- **Sentry** com scrub amplo, `sendDefaultPii:false`, sem replay, source maps removidos; `/api/public/health` bem feito.
- **Dockerfile** multi-stage, usuário não-root, segredo de build via BuildKit.
- **CI** com lint, typecheck, test e build; **typecheck limpo** com `strict: true`.
- **UX:** diálogo de publicar/desligar jornada com impacto; composer com autosave e validação acessível; Central de Resultados com estados completos; webhook com estado "sem permissão".
- **Documentação de decisões** rica (escopos, runbooks) — falta apenas consolidação e versionamento.

---

## 3. Red Team — segurança

Inventário: 304 server functions enumeradas; 115 funções DEFINER revisadas; superfície pública mapeada. Varredura de segredos no código e no histórico do git: **nenhuma chave real commitada** (exceto DSNs do Sentry em `.env.example`).

### 3.1 Achados

| ID | Sev. | Conf. | Achado | Evidência | Correção | Esf. |
|---|---|---|---|---|---|---|
| SEC-10 | Crítica | Confirmado | Edge function de IA lê `players`/`deposits`/`withdrawals` de todas as casas com service_role; autoriza por `has_role('admin')` sem tenant; devolve as linhas; `ai_synonyms`/`ai_training_examples` globais permitem envenenamento entre casas | `supabase/functions/ai-player-insights/index.ts:826-855, 247, 396, 425, 488-651, 1033`; `has_role` em `migrations/20260609200834:17-31` | Desligar até corrigir; resolver tenant ativo + `is_tenant_admin`; `.eq("tenant_id")` em todas as consultas; treino por tenant; `tenant_id` em `ai_logs` | M |
| SEC-11 | Crítica | Confirmado | XSS refletido sem autenticação em respostas de server function do TanStack Start; sessão em `localStorage`; sem CSP | `npm audit`; `@tanstack/start-server-core` 1.169.35 instalado; `previewAuthStorage.ts` | Atualizar para ≥ 1.169.39; CSP restritiva | P |
| SEC-12 | Alta | Confirmado | SSRF com leitura da resposta + vazamento de leads via `whatsapp_external_integrations.url`, sem papel exigido | `whatsapp-external.functions.ts:6,31,66,105`; `whatsapp-external.server.ts:96-161` | Exigir admin; só https; bloquear IP privado pós-DNS; `redirect:"manual"`; não persistir corpo | M |
| SEC-13 | Alta | Confirmado | `configureEvolutionWebhook` e `diagnoseEvolution` acessíveis a qualquer logado; devolvem token do webhook (fallback para chave global da Evolution) e lista global de instâncias | `whatsapp.functions.ts:35-68, 587-590, 696-726`; `evolution-webhook.ts:9-24` | Super admin apenas; nunca devolver token; segredo de webhook obrigatório, só por header; **rotacionar** | P |
| SEC-14 | Alta | A verificar | SEC-01 com cabeçalho "nada aplicado" e timestamp anterior a migrations aplicadas; se não aplicada, membro altera o próprio saldo de créditos e escala via `user_roles` | `docs/SEC-01_CORRECAO_PERMISSOES.md:5`; `20261015100000_fix_rls_privilege_escalation.sql` | Consultar `schema_migrations` (somente leitura) e aplicar se faltar | P |
| SEC-15 | Média | Confirmado | IDOR em `deleteWhatsappSession(force)`: apaga mensagens/chats de outra casa via service_role sem checar posse | `whatsapp.functions.ts:409-463` | `if (!session) throw`; `tenant_id` nas exclusões | P |
| SEC-16 | Média | Confirmado | Qualquer membro envia e-mail com HTML livre pelo remetente central (`sendTestEmail`) e SMS em massa para até 20.000 números arbitrários | `email.functions.ts:66-78`; `sms.functions.ts:917, 1032` | Papel admin/gestor; rate limit por usuário/casa; destino restrito | M |
| SEC-17 | Média | Confirmado | `testWhatsappProxy` abre TCP para qualquer host:porta (varredura interna) | `whatsapp-proxies.functions.ts:122-194` | Super admin; bloquear IP privado | P |
| SEC-18 | Média | Provável | Descadastro de e-mail global por endereço: token e supressão não respeitam a casa; `ilike` trata `_`/`%` como curinga; fail-open | `email-deliverability.server.ts:37-38, 59-64, 104-118` | Chave `(tenant_id, email)`; comparação exata; fail-closed | M |
| SEC-19 | Média | A verificar | Opt-out SAIR não processado (ver QA-02) | `sms-webhook.ts:96,181,237`; `sms.tsx:590` | Ver QA-02 | M |
| SEC-20 | Média | Confirmado | Injeção de HTML em e-mail via variáveis do jogador (`{nome}` não escapado); sanitizador por regex | `template-vars.server.ts:98-106`; `email-send.server.ts:26-33` | Escapar variáveis em HTML; sanitizador por allowlist | P |
| SEC-21 | Média | Confirmado | `has_role(uid,'admin')` sem tenant: admin da casa A executa `resetDashboards`, `resendFailedSms` e `getSmsDashboard` na casa B; idem políticas de storage | `dashboard-settings.functions.ts:27-31`; `sms.functions.ts:1739-1745` | `is_tenant_admin(tenantId)` | P |
| SEC-22 | Média | Confirmado | Webhooks: token na URL; HMAC opcional e desligado por padrão (rotação o desliga); sem anti-replay; segredos em query string; CORS `*`; corpo lido antes da auth; sem limite de tamanho | `webhook.$token.$evento.ts:70-84`; `webhooks.functions.ts:42`; `sms-webhook.ts:21-50`; `infobip/email/events.ts:8-10` | HMAC obrigatório com timestamp; tokens por header; remover CORS; limite de corpo | M |
| SEC-23 | Média | Confirmado | Operações sensíveis sem papel: conectar/desconectar Meta, antiban, importação em massa de consentimento "concedido", sessões WhatsApp, exportação total de jogadores | `meta.functions.ts:268,453,513,587`; `automations.functions.ts:570`; `consent.functions.ts:134`; `players.tsx:1060-1092` | `requireTenantRole(['admin','gestor'])` + RLS | M |
| SEC-24 | Baixa | Confirmado | Injeção de fórmula em CSV (jogadores, conversão, Central, destinatários) e exportação de PII sem auditoria | `players.tsx:1060`; `crm-results-csv.ts:5`; `conversion-report.functions.ts:126,689` | Prefixar `'` em `= + - @`; restringir e auditar | P |
| SEC-25 | Baixa | Provável | `storage_path`/`media_url` gravados pelo cliente são assinados/apagados com service_role | `journey-voice-assets.functions.ts:92,119`; `whatsapp.functions.ts:985-994` | Validar prefixo `${tenantId}/` | P |
| SEC-26 | Média | Confirmado | IA: `select("*")` de depósitos/saques/eventos (CPF, PIX) enviado a provedores externos; sem limite de custo/taxa; `ai_logs` sem tenant; prompt injection por nome de jogador | `ai.functions.ts:24-28, 88-92` | Dados agregados/pseudonimizados; limites; ROPA/DPA | M |
| SEC-27 | Baixa | Provável | Sem CSP/HSTS/frame-ancestors; porta 3000 publicada em todas as interfaces | `start.ts`; `docker-compose.yml` | Cabeçalhos via middleware/proxy; bind em 127.0.0.1 | P |
| SEC-28 | Baixa | Confirmado | `changeInitialPassword` troca senha sem senha atual e sem checar `force_password_change` | `auth.functions.ts:14-35` | Exigir a flag; reautenticação | P |
| SEC-29 | Baixa | Confirmado | `CRON_SECRET` único para tudo e fallback do HMAC de clique; DSNs reais no `.env.example` (e typo `htps://`); chave global da Evolution ao navegador do super admin; `SHORT_BRASIL_WEBHOOK_SECRET` devolvido ao cliente | `click-tracking.server.ts:38-39`; `.env.example:97,106`; `whatsapp.functions.ts:74-91`; `admin.functions.ts:39` | Segredos por finalidade; remover dos retornos | P |
| SEC-30 | Baixa | Provável | PII (telefone, texto) em stdout; payload de webhook com CPF/PIX sem retenção | `whatsapp.functions.ts:616-618`; `sms.functions.ts:220-289`; `webhook-process.server.ts:316-322` | Mascarar logs; retenção de 90 dias | M |
| SEC-31 | Info→Alta | A verificar | Se o signup público do Supabase Auth estiver ligado, qualquer pessoa obtém JWT e explora SEC-13/17 | Painel Supabase | Desligar signup público | P |
| SEC-32 | Baixa | Confirmado | Magic link de impersonação do super admin sem auditoria | `admin.functions.ts` (`adminGenerateLoginLink`) | Registrar em `admin_audit_logs` | P |
| SEC-33 | Baixa | Confirmado | `.or()` do PostgREST com busca do usuário sem sanitizar (limitado pela RLS) | `history.functions.ts:233,280,384`; `calls.functions.ts:595`; `email.functions.ts:797` | Reutilizar `sanitizeSearch` | P |
| SEC-34 | Baixa | Confirmado | Proxy `email-img` serve SVG com `ACAO: *` na origem do app | `api/public/email-img.$assetId.$filename.ts` | Remover SVG ou `CSP: sandbox` | P |

### 3.2 Pendências das revisões CON-08/SEC-01 ainda abertas

- Senha de proxy WhatsApp e de SMTP em texto puro (`password_encrypted` não é criptografada; SMTP devolvida à UI) — DEV-50/DEV-69.
- `antiban_settings` gravável por membro; `anon` com DML em tabelas WhatsApp.
- `sms_effective_pricing` expõe `provider_cost_per_sms` (margem) a membros.
- Auditoria de exportação de PII falha silenciosamente para admin de casa (`conversion_report_audit_events` sem policy, inserido com JWT do usuário — `conversion-report.functions.ts:942,986`).
- Tabelas novas (`crm_results_daily`, `player_lifecycle_daily`, `crm_results_health`) usam `has_tenant_access(tenant_id)` sem `(select …)` → custo por linha e semântica "todas as casas do usuário".
- Script de rollback da SEC-01 desatualizado após 6+ tabelas novas.
- `reserve_sms_credits`/`refund_sms_credits`/`apply_sms_credit_mutation` com EXECUTE para `authenticated` (protegidas só por guard interno) — DEV-45.
- `has_role`/`has_tenant_access` aceitam `_user_id` arbitrário (enumeração de papéis) — DEV-46.
- Migração `20260529214149` reescrita após aplicada (continha URL da Lovable + apikey) — conferir `cron.job` e rotacionar — DEV-41.

### 3.3 Superfície de ataque

| Endpoint | Autenticação | Risco |
|---|---|---|
| Edge `ai-player-insights` | JWT + `has_role('admin')` | **Crítico** |
| Server functions (SSR) | TanStack Start vulnerável | **Crítico** |
| `POST /api/public/evolution-webhook` | Bearer/header/`?token=` com fallback para API key | Alto |
| `POST /api/public/webhook/$token/$evento` | Token no caminho; HMAC opcional | Médio |
| `GET/POST /api/public/sms-webhook` | Segredo por query/header; CORS `*`; GET altera estado | Médio |
| `infobip/{email,voice}/*` | `?token=` (e-mail cai no token de voz) | Médio |
| `hooks/*`, `*/tick`, `shortio/sync`, `meta-sync/tick`, `precall/dispatch` | `requireSharedSecret(CRON_SECRET)` por header | Baixo |
| `click/$token` | HMAC `?s=` | Baixo |
| `email-img/...` | Público | Baixo |
| `/u/$token` | Token 128 bits | Médio (SEC-18) |
| PostgREST direto | RLS 140/140 | Médio (SEC-14/23/25) |

---

## 4. Desenvolvimento e arquitetura

**Execução:** `tsc --noEmit` ✅ · `eslint .` 0 erros / 700 warnings · 813 `any` em `src` · 33 `eslint-disable` (9 de arquivo inteiro) · 190 `console.*` · 0 TODO/FIXME.

### 4.1 Maiores arquivos

| Arquivo | Linhas | Avaliação |
|---|---:|---|
| `src/integrations/supabase/types.ts` | 8.091 | Gerado e **desatualizado** (22 tabelas faltando) |
| `src/routes/email.tsx` | 3.850 | Arquivo-deus (68 estados/queries) com componentes mortos |
| `src/routes/sms.tsx` | 3.715 | Arquivo-deus (81) com componentes mortos |
| `src/routes/whatsapp.tsx` | 2.919 | **Inteiro atrás de redirect** |
| `src/routes/players.tsx` | 2.642 | Grande; baixa a base inteira no filtro de alerta |
| `src/lib/whatsapp.functions.ts` | 2.274 | Arquivo-deus + 66 `any` + falhas de segurança |
| `src/routes/midia-ltv.tsx` | 2.137 | Grande |
| `src/lib/sms.functions.ts` | 2.135 | Mistura CRUD, envio e provedor |
| `src/lib/journeys.server.ts` | 1.660 | Núcleo das jornadas |
| `src/lib/webhook-process.server.ts` | 1.524 | Crítico, 17–22 chamadas PostgREST por depósito |

### 4.2 Achados

| ID | Sev. | Achado | Evidência | Recomendação | Esf. |
|---|---|---|---|---|---|
| DEV-62 | **Crítica** | Campanha de e-mail sem filtro de tenant (segmento e "leads") — **confirmado manualmente** | `email-segments.server.ts:14-21`; `email.functions.ts:882-885` | `.eq("tenant_id", camp.tenant_id)` nas duas consultas + teste | P |
| DEV-40 | **Crítica** | = SEC-10 | | | |
| DEV-01 | Alta | Tipos Supabase desatualizados (22 tabelas, ex.: `crm_results_daily`, `click_events`, `journey_scan_jobs`) → `eslint-disable` de arquivo inteiro em módulos críticos | `types.ts`; `crm-results.functions.ts:1` etc. | `supabase gen types` + checagem no CI | P |
| DEV-17 | Alta | Banco não é recriável a partir das migrations: script local pula 6 migrations "perigosas" (TRUNCATE, DROP, cron Lovable), reaplica tudo sem controle | `scripts/run-supabase-migrations.ps1:17-66` | Baseline a partir do schema de produção; `supabase db push` com histórico no CI | M |
| DEV-41 | Alta | Migration `20260529214149` reescrita depois de aplicada (tinha URL e apikey da Lovable) | linhas 4-6 | Conferir `cron.job`; rotacionar chave | P |
| DEV-42 | Alta | Sem retenção/particionamento em `webhook_logs` (507 MB), `sms_send_logs`, `email_send_logs`, `click_events`, `events`, `sessions`, `ai_logs`, `journey_events`, `journey_step_executions`, `cron.job_run_details` (~13 mil linhas/dia) | migrations | Política de retenção por tabela + jobs de expurgo | M |
| DEV-50 | Alta | Senha de proxy WhatsApp em texto puro em `password_encrypted` | `whatsapp-proxies.functions.ts:52,86,161` | Vault/pgsodium | M |
| DEV-51 | Alta | = SEC-21 | | | |
| DEV-55 | Alta | Truncamento silencioso em 1.000 linhas: ROI de marketing, conversões pendentes (descarta as mais novas), `selectInChunks` sem paginar dentro do bloco, lista de jogadores sem `order` | `marketing.functions.ts:307-327`; `pending-conversion.functions.ts:41-45`; `conversion-report.functions.ts:31-49, 521-546, 1069-1077`; `players-list.functions.ts:612-622` | Paginar ou agregar em SQL | M |
| DEV-63 | Alta | Campanha de e-mail sem idempotência por destinatário (`randomUUID` por execução); tick e recover reexecutam a campanha inteira | `email.functions.ts:988`; `email-campaigns/tick.ts:68-80` | Chave `(campaign, player)` | P |
| DEV-64 | Alta | Fila de voz sem claim nem idempotência; timeout de transporte reagendado | `calls.server.ts:264-275, 347-367` | Claim atômico + chave + "outcome unknown" sem retry | M |
| DEV-65 | Alta | Claim do WhatsApp não atômico; `onlyLeadId` pula claim; resume sem limite; `?bypassWindow=1`; contador read-modify-write | `automation.server.ts:466-501, 739-742`; `whatsapp-resume.ts:26-32` | `FOR UPDATE SKIP LOCKED`; incremento atômico | M |
| DEV-66 | Alta | Retry do Short Brasil em 5xx duplica SMS (provedor não deduplica); fluxos SMS/e-mail sem `deliveryKey`; `idempotency_key` não único; log de e-mail de jornada gravado sem checar erro | `sms.functions.ts:239-271`; `sms-dispatcher.server.ts:676-687`; `journeys.server.ts:866-881` | Mesma política do bulk; chaves determinísticas; índice único | M |
| DEV-67 | Alta | Transporte SMS legado em **HTTP sem TLS** com usuário/chave em header, provavelmente ativo | `sms.functions.ts:50-51, 235` | Migrar para a API nova (`SHORTCODE_SMS_TOKEN`) | P |
| DEV-02 | Média | Arquivos-deus nas rotas (email/sms/whatsapp) | ver 4.1 | Dividir por aba com lazy loading | G |
| DEV-03 | Média | Arquivos-deus no servidor | ver 4.1 | Consultas / comandos / adaptador | G |
| DEV-04 | Média | Módulos inteiros sem import: `activation.functions.ts` (11 server fns), `ai.functions.ts`, `activation-labels.ts`, `diagnostic-auth.server.ts`, `player-messages.ts` | grep | Remover | P |
| DEV-05 | Média | Server functions exportadas sem chamador, mas expostas como RPC (`enrollJourneyManually`, `rotateMyWebhookCredentials`, `requeueSmsProviderFailures`, `runCallFlowsTick`, `sendWhatsappMedia`, `saveSmtpConfig`, `runEmailFlowsNow`, `triggerSmsFlowNow`, `exportConversionDrilldownCsv`…) | vários | Remover ou garantir guarda | M |
| DEV-10 | Média | 5 implementações de relatório/conversão e 3 estilos de paginação; números podem divergir entre relatório por campanha e Central | `conversion-report.*`, `crm-results.*`, `conversion-p2.functions.ts` (morto) | Uma camada de métricas | M |
| DEV-11 | Média | Features do jogador duplicadas em orchestrator e automation | `orchestrator.server.ts:85-100`; `automation.server.ts:66-80` | Função pura compartilhada | P |
| DEV-12 / DEV-58 | Média | Caminhos de envio SMS fragmentados (7 módulos, 3 entradas de campanha); camadas invertidas (`*.server` importando `*.functions`); `resendFailedSms` sem `deliveryKey` | `sms.functions.ts:188,312,686,1912` | `sms-send.server.ts` único | G |
| DEV-15 | Média | Cache em memória: chave depende de convenção; remoção não-LRU; pendente nunca expira; regrava valor antigo após invalidação; resultado com RLS do 1º usuário servido a outros | `server-result-cache.ts:7-44`; `dashboard.functions.ts:130` | Chave obrigatória por tenant/escopo; invalidação | M |
| DEV-16 | Média | "Último erro" global misturando requisições no Sentry | `server.ts:66`; `error-capture.ts:4-9` | `AsyncLocalStorage` | P |
| DEV-19 / DEV-74 | Média | "Hoje" em UTC no TypeScript (container sem `TZ`); offset -3 duplicado em ~12 lugares; `tz.ts` existe mas não é usado | `history.functions.ts:539`; `marketing.functions.ts:276`; `orchestrator.server.ts:92-96,129` | Usar `tz.ts` em todo cálculo de dia; lint contra `setHours` | P |
| DEV-20 / DEV-73 | Média | Dinheiro somado em float; `total_cashback_paid` read-modify-write; `Number("1.234,56")` → evento financeiro descartado em silêncio | `orchestrator.server.ts:88-97`; `webhook-process.server.ts:131,450-458,586-594` | Agregar no SQL; incremento atômico; parser de valor BR | P |
| DEV-21 | Alta | = SEC-22 (webhooks só por token) | | | |
| DEV-22 | Baixa | Comparação de segredo manual; segredo único para todos os jobs | `cron-auth.server.ts:5-19` | `timingSafeEqual` sobre SHA-256; segredo por família; rotação dupla | P |
| DEV-23 | Média | HEALTHCHECK do Docker renderiza `/` via SSR em vez de `/api/public/health` | `Dockerfile:68-69` | Apontar para o health | P |
| DEV-24 / DEV-75 | Média | Logs sem estrutura/correlação; PII no stdout | 190 `console.*` | Logger JSON com `run_id`, `tenant_id`; mascarar | M |
| DEV-25 | Média | Dois lockfiles (bun parado desde 15/09; proteção de supply-chain só no bun) | `bun.lock`, `bunfig.toml` | Remover bun ou adotá-lo | P |
| DEV-26 | Média | `nitro ^3.0.260603-beta` em produção; upgrade de segurança parado desde 10/10 em worktree | `package.json` | Fixar versão; concluir upgrade | P |
| DEV-32 | Média | CI não barra dívida: sem `--max-warnings`, `npm audit`, diff de tipos, lint SQL, matrizes RLS, build Docker | `.github/workflows/quality.yml` | Adicionar gates | P |
| DEV-33 | Média | `no-explicit-any` como warning (664) | `eslint.config.js:39` | `error` em `*.server`/`*.functions` após DEV-01 | G |
| DEV-37 | Média | Sem README/arquitetura; `docs/*` ignorado | `.gitignore:17` | Inverter regra | M |
| DEV-43 | Média | `refresh_tenant_daily_metric_day` filtra por `(created_at AT TIME ZONE …)::date` (sem índice) | `20261002170000:50-63` | Filtro por intervalo | P |
| DEV-44 | Média | Índices ausentes (`sms_send_logs.campaign_id`, `email_send_logs(tenant_id,created_at)`, `sms_campaigns(tenant_id,name)` usado por trigger a cada insert…) e duplicados | migrations citadas | Criar/remover | P |
| DEV-45 | Média | RPCs de crédito liberadas para `authenticated` | `20261015100000:317-334` | Só `service_role` | P |
| DEV-47 | Média | URL `betleads.io` fixa em 13 crons; `orchestrate-tenants` sem filtrar tenants inativos | migrations | Config em Vault; filtrar ativos | P |
| DEV-48 | Média | PII e identidades fixas em migrations (UUID de super admin, e-mails pessoais, UPDATE em `auth.users`, tenant por nome, DELETE de config de outras casas) | `20260608201800:38-48`; `20260623034119:10-27`; `20260714201821` | Baseline limpa (DEV-17) | M |
| DEV-52 | Média | = SEC-23 | | | |
| DEV-53 | Média | Créditos SMS ignoram o tenant ativo (pega o 1º `user_roles`) — usuário multi-casa opera crédito na casa errada | `sms-credits.functions.ts:129-139` | Usar `current_tenant_id()` | P |
| DEV-54 | Média | ~225 `throw new Error(error.message)` (mensagens do Postgres ao cliente); 232 destructures descartando `error`; 25 catches vazios | vários | Middleware de sanitização; convenção única | M |
| DEV-56 | Média | N+1 síncrono (5.000 upserts sequenciais de consentimento; 500 `createSignedUrl`; HTTP por chat) | `consent.functions.ts:142-160`; `whatsapp.functions.ts:972-983, 1930-1983` | Lote/RPC | M |
| DEV-57 | Média | Enfileiramento de flows select→insert não atômico em 3 lugares | `webhook-process.server.ts:486-525, 794-840`; `cashback-catchup.server.ts:95-130`; `orchestrator.server.ts:133-177` | Upsert | P |
| DEV-59 | Média | Webhooks: segredo em query, GET altera estado, fallback de segredos cruzados, sem limite de corpo | ver SEC-22 | | M |
| DEV-68 | Média | = QA-05 + `isPaused`/`getAntibanSettings` globais | `sms-dispatcher.server.ts:172-178`; `antiban.server.ts:37-41` | Filtrar por tenant | P |
| DEV-69 | Média | SMTP em texto puro devolvido à UI; `tenants.webhook_secret` em texto puro; `EVOLUTION_API_KEY` ao cliente | `email.functions.ts:218,239,254`; `whatsapp.functions.ts:74-91` | Criptografar; nunca devolver | M |
| DEV-70 | Média | = SEC-12 | | | |
| DEV-71 | Média | `fetch` sem timeout (ElevenLabs, Evolution, Meta, mídia, IA) | `calls.server.ts:167-197`; `whatsapp-send.server.ts:95`… | `AbortSignal.timeout` | P |
| DEV-72 | Média | Sem interface comum de provedor; credenciais globais por env | adaptadores | Contrato `ProviderResult` | M |
| DEV-76 | Média | = SEC-26 + treino persistente na edge function | | | |
| DEV-77 | Média | Eventos de e-mail Infobip sobrescrevem status sem ordem | `infobip/email/events.ts:29-58` | Precedência de status | P |
| DEV-06/07/08/09 | Baixa | Componentes mortos; 18 componentes shadcn sem uso; deps sem uso (`@dnd-kit/*`, `date-fns`, `framer-motion`, `@base-ui`, `@tabler`…) | grep | Remover | P |
| DEV-13 | Baixa | Server functions de descadastro definidas no arquivo de rota | `u.$token.tsx:11-44` | Mover para `consent.functions.ts` | P |
| DEV-14 | Baixa | Assets e IDs de tenants específicos no código | `src/assets/email/*`; `scripts/import-sortealta-leads.mjs:6` | Storage por tenant | P |
| DEV-18 | Baixa | Nomes de migration mistos (UUID Lovable × descritivo) | 304 arquivos | Ver DEV-17 | P |
| DEV-27/28/29 | Baixa | `wrangler.jsonc` morto; sem `engines`/`packageManager`; dependência opaca `@lovable.dev/vite-tanstack-config` | raiz | Limpar/fixar | P |
| DEV-30/31 | Baixa | `.dockerignore` incompleto (~7 MB de logs, scripts, tests no contexto); raiz poluída | raiz | Ajustar | P |
| DEV-34/35/36 | Baixa | `noUnusedLocals` off; ESLint com globals de browser no servidor; 9 `exhaustive-deps` desligados em hooks de realtime | configs | Ajustar | P |
| DEV-38 / DEV-78 | Baixa | Variáveis de ambiente não catalogadas (18 usadas e não documentadas; 4 documentadas sem uso) | ver lista abaixo | Inventário | P |
| DEV-39 | Baixa | Script `sync-sortealta-export.mjs` modificado e não commitado, escreve em produção com service role | `git status` | Revisar e commitar | P |
| DEV-46 | Baixa | `has_role`/`has_tenant_access` com `_user_id` arbitrário | | Usar `auth.uid()` | P |
| DEV-49 | Baixa | 56 CREATE TABLE e 63 CREATE INDEX sem `IF NOT EXISTS`; `reserve_journey_delivery` redefinida 7× | migrations | Baseline | P |
| DEV-60/61 | Baixa | Segredo ao navegador; helpers de autorização duplicados com semânticas diferentes; `.maybeSingle()` em `user_roles` quebra com 2 linhas | `admin.functions.ts:39`; vários | Helper único | P |
| DEV-79/80 | Baixa | `shouldExit()` morto; dispatch SMS pode passar de 60 s; check-then-insert em `activation_runs` | `sms-dispatcher.server.ts:142-170`; `orchestrator.server.ts:503-537` | Ajustar | P |

**Variáveis de ambiente usadas e não documentadas:** `APP_RELEASE`, `GIT_SHA`, `APP_URL`, `CLICK_KNOWN_CRAWLER_UA_HASHES`, `EXPOSE_LINK_SYNC_DIAGNOSTICS`, `INFOBIP_EMAIL_CALLBACK_TOKEN`, `JOURNEYS_SCANNER_RESCAN_SECONDS`, `JOURNEYS_EVENT_ENTRY_ENABLED`, `JOURNEYS_CROSSING_ENABLED`, `JOURNEYS_CROSSING_BATCH_SIZE`, `JOURNEYS_CROSSING_TIME_BUDGET_MS`, `SHORT_BRASIL_SMS_SINGLE_URL`, `SHORT_BRASIL_SMS_BULK_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_KEY`, `IMPORT_TENANT_ID`, `BETTERSTACK_HEARTBEAT_JOURNEY_CROSSING`, `BETTERSTACK_HEARTBEAT_SMS_PROVIDER`.
**Documentadas e sem uso:** `EMAIL_PROVIDER`, `VOICE_PROVIDER`, `VITE_SUPABASE_PROJECT_ID`, `INFOBIP_WEBHOOK_SECRET`.

---

## 5. QA — testes e defeitos funcionais

### 5.1 Execução

| Verificação | Resultado |
|---|---|
| `vitest run` (inclui 10 testes de banco em PGlite, em memória) | **61 arquivos, 580 testes, 100% passando** (67,7 s) |
| `tsc --noEmit` | ✅ |
| `eslint` | 0 erros, 700 warnings |
| Lentos | `sms-campaign-dispatch.server.test.ts` 28 s (um caso de 14,9 s, perto do timeout de 20 s) |

### 5.2 Lacunas de cobertura

- **Sem teste nenhum:** `sms-dispatcher.server.ts` (1.117 linhas), `email-automations.server.ts`, `call-flows.server.ts`, `automation.server.ts`, `orchestrator.server.ts`, `calls.server.ts`, `whatsapp-send`, `evolution`, `antiban`, `sms-credits.functions.ts`, `send-window.*`, `contact-frequency`, `email-deliverability`, `tz.ts`, `template-vars.server.ts`, `tenant-access`, `cron-auth`, `auth-middleware`, `evolution-webhook`, `webhook.$token.$evento`, `hooks/*`, `cashback-catchup`, `crm-results.functions` (paginação/holdout).
- **Sem E2E nem testes de UI** (nenhum Playwright/Cypress/Testing Library).
- **CI** não roda migrations num banco limpo, nem matrizes RLS (`con08-matrix.mjs`, `sec01-matrix.mjs` só manuais), nem cobertura, nem smoke pós-deploy.

### 5.3 Qualidade dos testes

| ID | Problema | Evidência |
|---|---|---|
| Q-1 | Teste que não roda entre 00:00 e 01:20 BRT (`if (minutes < 80) return;`) | `journey-p0-rules.db.test.ts:239-241` |
| Q-2 | 37 usos de relógio real em asserções; só 5 arquivos com fake timers | `journeys.dispatcher.test.ts:308…`; `click-tracking.trk06.test.ts:379` |
| Q-3 | Nenhum teste fixa `TZ` nem cobre a virada da meia-noite BRT | — |
| Q-4 | Mocks pesados (10–13 `vi.mock`); PGlite usa **schema escrito à mão**, não as migrations reais → drift (QA-01 passaria despercebido) | `supabase/tests/journey-level/schema.sql` |
| Q-6 | PGlite tem uma conexão: sem teste real de concorrência (SKIP LOCKED, double-claim) | — |
| Q-7 | Nenhum teste prova isolamento de tenant em agregados, drill-down e CSV (critério 8.3 da Central) | — |

### 5.4 Defeitos — consentimento, janela, templates, Central

| ID | Sev. | Conf. | Defeito | Evidência | Correção |
|---|---|---|---|---|---|
| QA-02 | **Crítica** | Confirmado | SAIR/PARAR/STOP por SMS não revoga consentimento; com `statusDescricao` a resposta vira `sent` e o texto se perde | `sms-webhook.ts:87-96, 181, 237` | Parser de MO + `channel_consents` + auditoria + testes com payload real |
| QA-01 | Alta | Confirmado | Upsert em `suppressed_emails` sempre falha (ON CONFLICT sem índice correspondente): supressão não grava; tenant `null` só em memória; revogação na UI dá erro sem auditoria; importação aborta | `migrations/20260622202326:13`; `email-deliverability.server.ts:60-64`; `consent.server.ts:68-74` | Constraint em e-mail normalizado / RPC com `ON CONFLICT (lower(email))`; checar `{error}` |
| QA-03 | Alta | Confirmado | Consentimento **fail-open** (e-mail, `isSuppressed`, `isSmsSuppressed`) | `email-send.server.ts:111-135`; `email-deliverability.server.ts:43-46`; `channel-eligibility.server.ts:42-46` | Fail-closed + reenfileirar |
| QA-05 | Alta | Confirmado | Janela de envio do tenant principal aplicada a todos (6 call sites sem `tenantId`); UI lê sempre a janela principal; `updateSendWindow` sem filtro de tenant | `send-window.server.ts:158`; `send-window.functions.ts:32, 140-149` | Propagar tenant; filtrar select/update |
| QA-08 | Alta | Confirmado | `{link}`, `{link_login}`, `{link_deposito}` apontam para `https://betleads.app/depositar` para todas as casas | `template-vars.server.ts:82-84`; `calls.server.ts:118` | Link por tenant; bloquear se ausente |
| QA-04 | Média | Confirmado | `isSmsSuppressed` nunca encontra registro (tabela só dígitos × consulta com "+55") | `migrations/20261003123000:6`; `channel-eligibility.server.ts:55,74` | `normalizeConsentSubject` |
| QA-06 | Média | Provável | Timezone inválido derruba dispatchers; "08:75" aceito | `send-window.functions.ts:126`; `send-window.server.ts:79` | Validar timezone e minutos |
| QA-07 | Média | Confirmado | Cooldown de voz > 24 h não respeitado (consulta só 24 h) | `consent.server.ts:106-133` | `since = max(24h, cooldown)` |
| QA-09 | Média | Confirmado | Variáveis de ligação aceitas em SMS/e-mail mas não preenchidas → jogador recebe "{atendeu}" | `message-variables.ts:56-60`; `template-vars.server.ts:48-103` | Validar por contexto; bloquear token não resolvido |
| QA-10 | Média | Confirmado | Datas em mensagens formatadas em UTC (`{ultimo_login}` às 22:30 BRT sai com o dia seguinte) | `template-vars.server.ts:64-72`; `calls.server.ts:103-111`; `email.functions.ts:460,604` | `timeZone: "America/Sao_Paulo"` |
| QA-11 | Média | Provável | Retenção diária truncada em 1.000 linhas, cortando os dias **mais recentes** | `crm-results.functions.ts:186-192` | Paginar |
| QA-13 | Média | Provável | Central soma "destinatários"/"recuperados" distintos **por dia** → um jogador conta 10× em 10 dias; taxa e custo por recuperado distorcidos | `20261016130000:167,257`; `crm-results.ts:75,79` | Distintos do período no SQL ou rótulo "destinatários-dia" |
| QA-14 | Média | Confirmado | CSV da Central: injeção de fórmula; `other` rotulado "campanha"; separador `,` quebra Excel pt-BR | `crm-results-csv.ts:271,329,353` | Neutralizar; mapear; `;` + BOM |
| QA-15 | Média | Provável | Mesmo depósito pode gerar 2 atribuições (direta + assistida); token sem `recipient_player_id` credita qualquer jogador | `conversion-attribution.server.ts:95,140` | Chave única por evento |
| QA-17 | Média | Provável | Ligação sem registro em `call_history` (insert sem checar erro) escapa da política de frequência | `journeys.server.ts:924-943` | Checar erro |
| QA-18 | Média | Confirmado | `suppressed_emails` com unicidade global e `ilike` sem escape | `consent.server.ts:75`; `email-deliverability.server.ts:37` | Ver SEC-18 |
| QA-12 | Baixa | Confirmado | Erro da RPC de holdout ignorado | `crm-results.functions.ts:102-107` | Mostrar erro |
| QA-16 | Baixa | Confirmado | Limite de frequência fail-open com RPC vazia | `contact-frequency.server.ts:139-143` | Fail-closed |
| QA-19 | Baixa | Confirmado | DDDs inexistentes aceitos; nome vazio gera "Olá , …"; DSN real e typo `htps://` no `.env.example`; offset fixo em `tz.ts` | `phone-normalization.ts:9`; `template-vars.server.ts:31-33` | Ajustes pontuais |

### 5.5 Defeitos — pipeline de SMS e créditos

| ID | Sev. | Conf. | Defeito | Evidência |
|---|---|---|---|---|
| SMS-01 | **Crítica** | Confirmado | Falta de crédito interno de **uma** casa pausa SMS de **todas** e liga throttle global de 30 min (migrations de "unpause" sugerem que já ocorreu) | `sms.functions.ts:822`; `sms-dispatcher.server.ts:718-745`; `dispatch-pause-insufficient.server.ts:8,25-33` |
| SMS-02 | Alta | Confirmado | `isPaused()` lê uma linha arbitrária de `automation_settings` (pausa de uma casa para todas, ou ignora a pausa da casa); worker de campanhas nem consulta | `sms-dispatcher.server.ts:172-179` |
| SMS-03 | Alta | Confirmado | Timeout/5xx no envio unitário → estorno, log `pending`, reenvio → **SMS duplicado** | `sms.functions.ts:262-271, 831-855, 679` |
| SMS-04 | Alta | Confirmado | Fluxos SMS sem `deliveryKey`; anti-duplicação de 30 min compara formatos de telefone diferentes e sem tenant | `sms-dispatcher.server.ts:645-687` |
| SMS-05 | Alta | Confirmado | Sem crédito, a campanha marca o público restante como `failed` e avança o cursor — sem reenvio após recarga (teste fixa esse comportamento) | `sms-bulk.server.ts:724-731`; `sms-campaign-dispatch.server.ts:447-480` |
| SMS-06 | Média | Confirmado | Envio imediato (≤50) concorre com o cron e sobrescreve contadores | `sms.functions.ts:1171-1298` |
| SMS-07 | Média | Confirmado | Callback atrasado regride `delivered` → `sent`/`failed` | `sms-webhook.ts:183-214` |
| SMS-08 | Média | Confirmado | Cota diária por fluxo consumida sem envio e nunca devolvida | `sms-dispatcher.server.ts:547-613` |
| SMS-09 | Média | Provável | Cobrança de 1 crédito por SMS sem contar segmentos GSM-7/UCS-2 (acentos → 70 chars/segmento) | `sms.functions.ts:588`; `sms-bulk.server.ts:723` |
| SMS-11 | Média | Provável | Públicos > 20.000 não podem ser enviados (zod `.max(20000)`) | `channel-campaign-composer.tsx:524`; `sms.functions.ts:1037,1952` |
| SMS-12 | Baixa | Confirmado | Falha no estorno engolida; `lifetime_used` não desconta estorno | `sms.functions.ts:603-619` |
| SMS-13 | Baixa | Confirmado | Opção "rastrear links" do composer ignorada (sempre `true`) | `sms.functions.ts:1120,1185,1246,2062` |
| SMS-14 | Baixa | Confirmado | "Reenviar falhas" filtra `status='error'`, mas o caminho padrão grava `pending`; sem paginação | `sms.functions.ts:1759-1830` |
| SMS-15 | Baixa | Confirmado | Call-flows registram `sms_sent` mesmo com envio falho | `call-flows.server.ts:771-787` |

### 5.6 Defeitos — jornadas, scanner e orquestrador

| ID | Sev. | Conf. | Defeito | Evidência |
|---|---|---|---|---|
| JRN-01 | Alta | Confirmado | Cashback catch-up reinscreve e **reenvia o fluxo a cada execução no mesmo dia** (compara `created_at` que não muda) | `cashback-catchup.server.ts:105-120`; `webhook-process.server.ts:501-511` |
| JRN-03 | Alta | Confirmado | `ends_at` não checado no dispatcher nem no claim; sweep best-effort com `LIMIT 1000` global sem ORDER | `journeys.server.ts:432-438, 1474`; `20261016100000_journey_end_date.sql:100-106` |
| JRN-02 | Média | Confirmado | Catch-up só vê os 500 primeiros pagamentos do dia; erros ignorados | `cashback-catchup.server.ts:32-38` |
| JRN-04 | Média | Provável | Limite global 24h/7d não conta SMS/e-mail reservados e não logados → concorrência estoura o "2" | `20261016110000:65-117` |
| JRN-05 | Média | Provável | Cap diário por jogador exclui **todos** os envios da própria inscrição | `20261015200000_journey_p0_rules.sql:116` |
| JRN-06 | Média | Confirmado | Adiamento de voz por política consome tentativas; próxima falha real mata a inscrição; `max_attempts`/`retry_delay` de voz da UI não são lidos | `journeys.server.ts:901-906, 1298-1349`; `journeys.shared.ts:46-52` |
| JRN-07 | Média | Provável | `.in()` com até 2.000 UUIDs em `recentCooldownPlayers` (o próprio código registra que 500 já quebra) | `journey-scanner.server.ts:182-187` |
| JRN-08 | Média | Confirmado (latente) | Scanner/crossing com batch > 1.000 truncados pelo `max_rows` e tratados como "ciclo completo" | `journey-scanner.server.ts:536, 670-673`; `journey-crossing.server.ts:119-187` |
| JRN-09 | Média | Confirmado | Orquestrador volta cursor ao início no deadline; agregados truncados; erros fail-open geram inscrição duplicada; dia UTC | `orchestrator.server.ts:56-68, 241-270, 579-611` |
| JRN-10 | Média | Provável | Sweep de saídas e retomada de prioridade varrem todas as casas a cada tick, fora do canário, sem ordem | `end_date.sql:65-106`; `journeys.server.ts:1466-1474` |
| JRN-11 | Média | Confirmado | `entry_rules` sem schema: formato inválido **desliga a janela** (envio de madrugada); `start==end` bloqueia para sempre | `journeys.shared.ts:84`; `journey-policy.ts:36-54` |
| JRN-12 | Média | Provável | Hard deadline libera o slot e para o lease com handlers ainda enviando | `journeys.server.ts:1588-1652` |
| JRN-13 | Baixa | Provável | Arbitragem de prioridade pausa concorrente em envio por outro worker | `20261015122000_express_journeys.sql` |
| JRN-14 | Baixa | Confirmado | HMAC fail-open com `enforced=true` e segredo nulo; mojibake "invÃ¡lida"; inatividade usa `ultimo_login` na entrada e `ultimo_deposito` na saída; execuções presas em `claimed` contam nos limites | `webhook.$token.$evento.ts:75-84`; `journey-policy.ts:72`; `journeys.server.ts:232, 1207-1219` |

**Verificados sem problema:** `cron-auth` (tempo constante, fail-closed), todos os `hooks/*` com `requireSharedSecret`, webhook legado 410, revalidação do `x-active-tenant`, holdout determinístico e excluído de campanhas, inscrição única por advisory lock, dia BRT no SQL.

### 5.7 Critérios de aceite sem evidência

- **MATRIZ_ACEITE_CANAIS:** 21 de 21 cenários ☐; nenhuma assinatura; cobre só Sorte Alta, embora jornadas rodem em 3 casas.
- **ESCOPO_CENTRAL 8.3:** isolamento de tenant sem teste; p95 < 2 s sem medição; custo vs ledger só por envio; "depósito creditado duas vezes" em risco (QA-15).
- **ESCOPO_AUDITORIA_GATILHOS:** R-10 (SAIR) aberto; matriz §6.3 parcial; tudo "não verificado no navegador".

---

## 6. UX / UI

### 6.1 Recomendações de 07/10 — situação

| Recomendação | Situação |
|---|---|
| Confirmar fechamento do composer com alterações | Parcial: `window.confirm` nativo; botão Cancelar **pula** a confirmação (`channel-campaign-composer.tsx:611,1068`) |
| Entrada única "Criar" | Aplicado |
| Total/elegíveis/excluídos por canal | Aplicado |
| Remover alternador de canal | Aplicado, mas virou **abas ocultas** (`TabsList className="hidden"`) |
| Consolidar rotas de estados operacionais | Não aplicado (destinos mortos) |
| Teste moderado com 3 operadores | **Não realizado** |

### 6.2 Achados

| ID | Sev. | Achado | Evidência | Recomendação | Esf. |
|---|---|---|---|---|---|
| UX-01 | **Crítica** | Página Configurações é uma maquete que finge salvar (inputs fixos, switches sem estado, "Salvar" só mostra toast, status "Conectado" fixo, nome do modelo de IA e "Lovable" expostos, 2FA "em breve" ligável) | `configuracoes.tsx:34-185` | Remover cards falsos ou ligar a dados reais | M |
| UX-02 | **Crítica** | Rotacionar chave HMAC e "Exigir assinatura" num clique, sem confirmação — pode parar a ingestão de depósitos | `webhooks.tsx:118-134, 205-216` | AlertDialog com consequência; bloquear se nenhum evento assinado chegou | M |
| UX-03 | **Crítica** | Confirmação de risco do envio em massa não é resetada ao trocar público/conteúdo; botão sem quantidade nem custo | `channel-campaign-composer.tsx:656, 690, 1088-1092` | Resetar em qualquer mudança; "Enviar para N · N créditos"; digitar o número acima de 1.000 | P |
| UX-04 | **Crítica** | "Disparar N ligações" executa direto | `ligacoes/bulk-call-tab.tsx:386-392` | Resumo de risco ou eliminar caminho legado | P |
| UX-05 | Alta | CTAs de estado de campanha levam a destinos mortos; `<a href>` com recarga | `channel-operation-state.ts:12-16`; `ligacoes.tsx:29-36` | Mapear destinos válidos; `<Link>`; teste hash×aba | P |
| UX-06 | Alta | WhatsApp desligado na navegação mas ativo em Jogadores, toasts e textos de ajuda → becos sem saída | `players.tsx:2169,2280,2585`; `whatsapp/send-dialog.tsx:85-180` | Decidir produto; feature flag | M |
| UX-07 | Alta | Histórico de e-mail/voz, fluxos de voz e ligações em massa só acessíveis por hash na URL | `email.tsx:351`; `ligacoes.tsx:60` | Abas visíveis padronizadas por canal | M |
| UX-08 | Alta | Código morto em massa nas maiores rotas; caminhos legados de envio ainda alcançáveis sem as proteções novas | `whatsapp.tsx`; `sms.tsx`; `email.tsx:2316` | Remover | M |
| UX-09 | Alta | Ficha do jogador sem nenhuma ação (enviar mensagem exige ir a Campanhas e redigitar o telefone) | `players.$playerId.tsx:402-409` | Barra de ações na ficha | M |
| UX-10 | Alta | Relatório de campanha/jornada em erro vira overlay fixo sem saída; sem foco preso | `conversion-report.tsx:178, 1199-1205` | Página normal ou Dialog real; "Voltar"/"Tentar de novo" | P |
| UX-11 | Alta | Formulário de jornada sem `<label>` (todos os campos); só 24 de 208 `<Label>` com `htmlFor` | `journey-editor.tsx:169-175, 779-1019` | `<Label htmlFor>`; lint jsx-a11y | M |
| UX-12 | Alta | 8+ ações destrutivas sem confirmação; 52 de 61 botões-ícone sem nome acessível | `tenants.tsx:724`; `admin.tsx:483,648`; `campaigns-hub.tsx:285,440`; `experts.tsx:138`; `treino-ia.tsx:174,283` | `requestConfirmation({destructive})`; desfazer; `aria-label` | P |
| UX-13 | Alta | Erro de carregamento exibido como lista vazia (Jornadas, Oportunidades, Jornada, Encurtador com "Carregando…" infinito) | `journeys-hub.tsx:549`; `alertas.tsx:486,697`; `links.configuracoes.tsx:18` | Componente `<QueryState>` padrão | M |
| UX-14 | Alta | Encurtador salva sem feedback e falha em silêncio; jargão técnico | `links.configuracoes.tsx:19-43` | Toasts; linguagem de negócio | P |
| UX-15 | Alta | Jornadas não usam os Públicos salvos | `journey-editor.tsx:775-782` | Público salvo como filtro de entrada | G |
| UX-16 | Alta | Filtro de alerta em Jogadores baixa a base inteira no navegador (laço de 1.000 + `limit(20000)`) | `players.tsx:825-855` | RPC no servidor | G |
| UX-17 | Alta | Sidebar mobile fechada continua no Tab; sem Esc nem foco preso; sem "pular para conteúdo" | `app-sidebar.tsx:273-276` | Sheet do Radix / `inert` | P |
| UX-18 | Alta | Páginas 404 e de erro em inglês; meta `@Lovable` | `__root.tsx:33-118` | Traduzir; remover meta | P |
| UX-19 | Média | Cabeçalho mostra "BETLEADS" em 7 páginas principais | `app-layout.tsx:11-38` | Títulos de fonte única | P |
| UX-20 | Média | Nomes diferentes para o mesmo destino (Oportunidades × "Central de Recuperação de Receita"; Automações × Jornadas; Contas × "Configuração do tenant"…) | ver relatório | Glossário + constante de rótulos | P |
| UX-21 | Média | Sidebar com redundâncias (Inteligência › Inteligência; Configurações › Configurações; Consentimentos em Canais; mesmo ícone em Jogadores e Públicos) | `app-sidebar.tsx:54-78` | Reorganizar | P |
| UX-22 | Média | Rotas órfãs (`/experts`, `/eventos`, `/links`) e redirects em cadeia | — | Expor, mover ou remover | P |
| UX-23 | Média | Três funis de aquisição, duas retenções e "Recuperado" com definições diferentes entre Início e Central | `index.tsx:694,770,854`; `central-results.tsx:903` | Início = pulso; Central = fonte única | M |
| UX-24 | Média | "Retorno sobre o envio" divide recuperado de todos os canais pelo custo só de SMS | `index.tsx:900-903` | Corrigir fórmula ou rótulo | P |
| UX-25 | Média | 49 cores de gráfico inválidas (`hsl(var(--x))` sobre tokens `oklch`) | `sms.tsx:1588-1600`… | `var(--x)` direto / `ChartContainer` | P |
| UX-26 | Média | Gráficos sem alternativa textual, tooltip inconsistente, eixos sem unidade | `central-results.tsx:253-822` | Wrapper `<Chart>` + "ver como tabela" | M |
| UX-27 | Média | Editor de jornada: espera em segundos sem unidade; sem reordenar; `key={i}`; sem desfazer; **telefone real fixo como origem padrão**; sem guarda de alterações | `journey-editor.tsx:463-977` | Ver relatório | M |
| UX-28 | Média | Não fica claro o efeito de editar jornada ativa ("salva como rascunho" sempre) | `journey-editor.tsx:460,487` | Mostrar status e consequência | P |
| UX-29 | Média | Oportunidades: "SMS" abre `sms:` no navegador; "Enviar bônus" é simulado e registra como feito | `alertas.tsx:540,556-558` | Envio individual real; desabilitar bônus | P |
| UX-30 | Média | Exportar CSV de Jogadores exporta só a página atual (50 linhas) | `players.tsx:1034-1035` | Exportação do filtro no servidor | M |
| UX-31 | Média | Status só por cor | `players.tsx:310-318`; `app-layout.tsx:121-124`; `journeys-hub.tsx:393-437` | Texto/aria | P |
| UX-32 | Média | Linhas clicáveis sem teclado; chat da IA sem rótulo e sem `aria-live` | `history-shell.tsx:550`; `inteligencia.tsx:91-195` | Ajustar | P |
| UX-33 | Média | Itens agrupados da sidebar recolhida não funcionam; sem `aria-expanded` | `ui/sidebar.tsx:358-387` | Flyout | P |
| UX-34–38 | Média | Dois conjuntos de ícones; 1.003 cores cruas sem tokens semânticos; duas bibliotecas e 17+ reimplementações locais de KPI/Badge/Empty; tema escuro forçado sem `color-scheme`; padding e larguras inconsistentes, `<main>` aninhado | ver relatório | Tokens `success/warning/info/danger`; `PageContainer`; consolidar | G |
| UX-39–41 | Média | Termos inconsistentes (players/leads/jogadores; Email/E-mail); textos sem acento e mojibake; datas ISO cruas e percentuais com ponto | `midia-ltv.tsx`; `consentimentos.tsx`; `links.tsx:28-52` | Glossário; revisão de texto; `pct()`/`dateTime()` | M |
| UX-42 | Média | Consentimento: termos divergentes, base legal em texto livre, autorização manual sem evidência, CSV com cabeçalho em inglês | `consentimentos.tsx:193-357` | Select de bases legais LGPD; evidência obrigatória | M |
| UX-43–46 | Média | Lista de campanhas sem paginação e com rótulos ambíguos; navegação com recarga completa; período/aba da Central fora da URL; seletor de conta duplicado no dashboard | `campaigns-hub.tsx:398-455`; `central-results.tsx:60,152`; `index.tsx:521` | Ver relatório | P–M |
| UX-47–51 | Baixa | Texto 9–11 px de baixo contraste (232 usos); `<title>` ausente em 34 rotas; larguras fixas que quebram em 320–375 px; `window.confirm`; assistente IA perde conversa | ver relatório | Ajustes | P–M |

### 6.3 Inventário de páginas (nota de estados 1–5)

| Rota | Propósito | Nota |
|---|---|---|
| `/` | Pulso da operação | 3 |
| `/resultados` | Central de Resultados | 4 |
| `/resultados/comparar` | Comparar casas | 3 |
| `/midia-ltv` | Mídia paga e LTV | 3 |
| `/players` | Base de jogadores | 3 |
| `/players/$id` | Ficha do jogador | 4 (sem ações) |
| `/publicos` | Segmentos | 4 |
| `/alertas` | Oportunidades | 2 |
| `/gamificacao` | Níveis | 4 |
| `/campanhas` | Hub de campanhas | 3 |
| `/campanhas/$id/relatorio` | Relatório | 2 |
| `/automacoes` | Hub de jornadas | 3 |
| `/jornadas/nova`, `/jornadas/$id` | Editor | 2 |
| `/jornadas/$id/relatorio` | Relatório | 2 |
| `/sms` | Canal SMS | 3 |
| `/sms/templates` | Biblioteca SMS | 2 |
| `/email` | Canal e-mail (abas ocultas) | 3 |
| `/ligacoes` | Voz (abas ocultas) | 2 |
| `/consentimentos` | Opt-in/out | 2 |
| `/creditos-sms` | Créditos | 3 |
| `/inteligencia` | Assistente IA | 3 |
| `/treino-ia` | Treino da IA | 2 |
| `/webhooks` | Integração/HMAC | 4 |
| `/links` | Métricas de links (órfã) | 2 |
| `/links/configuracoes` | Encurtador | 1 |
| `/configuracoes` | Preferências (maquete) | 1 |
| `/tenants` | Conta e equipe | 3 |
| `/admin` | Super Admin | 4 |
| `/eventos` | Eventos (órfã) | 3 |
| `/experts` | Afiliados (órfã) | 2 |
| `/u/$token` | Descadastro público | 4 |

---

## 7. Gestão de projeto

### 7.1 Processo

| ID | Sev. | Achado | Evidência | Recomendação |
|---|---|---|---|---|
| PM-01 | Alta | Tudo vai direto para `main`: 0 merges, 0 PRs; CI configurado para PR nunca usado como gate | `git log --merges` | Proteção da `main`, PR obrigatório com CI verde |
| PM-02 | Alta | Escopo e código no mesmo dia, de madrugada, sem aceite (Central: doc 04h23, commits F0–F5 22h55–04h22); 25% dos commits entre 22h e 6h desde 13/10 | datas dos commits | Definition of Done com aceite; janela de deploy diurna; limite de WIP |
| PM-03 | Alta | Não existe homologação; documentos exigem "testar em staging" impossível | `supabase/config.toml` com um único projeto | Projeto/branch Supabase de homologação |
| PM-04 | Alta | Migrations aplicadas à mão da máquina local; sem registro auditável do que foi aplicado (status conflitantes entre docs) | `scripts/run-supabase-migrations.ps1` | `supabase db push` no CI com backup/PITR antes |
| PM-05 | Média | Sem versionamento/release (sem tags, CHANGELOG; `SENTRY_RELEASE` vazio) | `git tag` | CalVer + tag por deploy |
| PM-06 | Média | Commits gigantes (24,8 mil, 22 mil, 11,6 mil linhas) | `--shortstat` | PRs < 500 linhas |
| PM-07/08 | Média | Autor "unknown" em 257 commits; commit duplicado; título "registra aceite" sem aceite | `git log` | `user.name`, commitlint |
| PM-09 | Média | Branches e worktree abandonados (`backup/main-before-sync`, upgrade de segurança parado desde 10/10) | `git worktree list` | Concluir ou descartar |
| PM-10 | Baixa | `base/` com CSVs de jogadores (PII) e logs no diretório local | raiz | Mover/criptografar/apagar |
| PM-12 | Média | Rollback só existe para Short.io; imagem refeita no VPS sem tag (a anterior se perde) | `docker-deployment.md` | Registry com tag; runbook de rollback |
| PM-13 | Alta | Diretriz "suspender novas frentes até P0.1/P0.2/P0.6" (ESCOPO_RESOLUCAO §15) descumprida: Central, holdout, express, mapa entregues com P0.2/P0.3/P0.5/P0.6 abertos | `ESCOPO_RESOLUCAO_LEVANTAMENTO_2026-10-10.md:513` | Reativar o congelamento |
| PM-14 | Alta | Mudanças de produção feitas por transação direta (limites, prioridades, backfills, limpezas) com listas de rollback só em arquivos locais de sessão | ESCOPO_AUDITORIA_GATILHOS §8 | Registro de operações em produção versionado |

### 7.2 Backlog consolidado — itens com status divergente ou em aberto

Classificação: **EV** entregue e verificado · **ESA** entregue sem evidência de aceite · **PAR** parcial · **PEN** pendente · **OBS** obsoleto · **CONF** conflitante.

| ID | Origem | Item | Declarado | Verificado | Evidência |
|---|---|---|---|---|---|
| PM-BL-01 | RESOLUCAO §15 | Congelar frentes novas | Diretriz ativa | **CONF** (descumprida) | 640b371…78fb20a |
| PM-BL-02 | RESOLUCAO P0.4 | Homologar atribuição com as casas | Parcial | PAR | 119e557, 2bf89f6; HMAC em 0 casas |
| PM-BL-03 | RESOLUCAO | SPF/DKIM/DMARC e envio real Infobip e-mail | Pendente | PEN | Nenhuma evidência |
| PM-BL-04 | RESOLUCAO | Catálogo de ambientes | Pendente | PEN | — |
| PM-BL-05 | REAUDITORIA_CANAIS P0.1 | Aceite real SMS/e-mail | Pendente | PEN (SMS em produção em escala sem matriz atualizada) | MATRIZ 0/21 |
| PM-BL-06 | REAUDITORIA_CANAIS | Voz bloqueada até certificar | Bloqueada | **CONF**: cron religado em 08/10 sem flag até 10/10; **passo de voz das jornadas ignora `VOICE_DISPATCH_ENABLED`** | `journeys.server.ts:929`; `20261008130000` |
| PM-BL-07 | ESCOPO_AUDITORIA_GATILHOS R-10 | Capturar SAIR | "Urgente" | PEN | QA-02 |
| PM-BL-08 | AUDITORIA_GATILHOS C-03 | Revogação de consentimento encerra inscrição | — | PAR (só telefone vazio sai) | sweep sem `consent_revoked` |
| PM-BL-09 | AUDITORIA_GATILHOS E-05 | Cashback D+1 com substituição | Adiado pelo cliente | PEN | trigger ainda `cashback_pago` |
| PM-BL-10 | AUDITORIA_GATILHOS C-02 / CENTRAL R-09 | Teto diário de gasto por casa/jornada | Adiado | PEN; **créditos em 99.999.999** | — |
| PM-BL-11 | AUDITORIA_GATILHOS §8.1 | Estado `completed` da jornada ao fim | Especificado | PAR (só badge) | — |
| PM-BL-12 | AUDITORIA_GATILHOS S-03 | Descartar passos vencidos ao retomar | — | PEN | — |
| PM-BL-13 | AUDITORIA_GATILHOS | Job de reconciliação de inscrições | Requisito P1 | **OBS** por decisão do dev, sem aceite do negócio | §8.5 |
| PM-BL-14 | AUDITORIA_GATILHOS G-01 | Inventário de templates aprovado e versionado por casa | — | PEN | — |
| PM-BL-15 | CENTRAL D-10 | Comparação de período like-for-like | — | PEN | `dashboard.functions.ts:114-120` |
| PM-BL-16 | CENTRAL D-07/D-14 | Corrigir `ftd_em` no sync + 203 jogadores | — | PEN (não está no diff local) | — |
| PM-BL-17 | CENTRAL §8.2 | Decisões abertas (janela influenciada 72h, faixas ≥48h vs glossário "<3d", holdout 0% vs 5%, preço×custo) | Abertas | **Implementadas por padrão do dev sem aprovação** | — |
| PM-BL-18 | CENTRAL F0–F5 | Central de Resultados completa | Feito | ESA (madrugada de 16/10, "não verificado no navegador", F0 sem teste) | 211ecb0…eb66bd0 |
| PM-BL-19 | FILA_ASSINCRONA P5 | Rampa 5→25→50→100% | Previsto | **CONF**: 3 casas ativadas de uma vez em 13/10 | 23bf6d9, 4e6d78d |
| PM-BL-20 | FILA_ASSINCRONA P3 | DLQ de jornada e `provider_idempotency_key` | — | PEN | — |
| PM-BL-21 | FILA_ASSINCRONA P1 | Teste de carga 100k jogadores | — | PEN | — |
| PM-BL-22 | AUDITORIA_JORNADAS P3/P4 | Editor passo a passo, espera em min/h/d, preview e envio de teste seguro, E2E, teste moderado | — | PEN | — |
| PM-BL-23 | ESCALA OBS-02..04 | Sentry/Better Stack configurados e alerta < 5 min | ✅ código | ESA código / **PEN configuração** (DSN e heartbeats vazios) | — |
| PM-BL-24 | ESCALA WHK-02..06 | Inbox durável, contrato, eventos fora de ordem, HMAC obrigatório, atribuição assíncrona | — | PEN | `webhook-process.server.ts:330, 629` |
| PM-BL-25 | ESCALA TRK-01..05 | Clique first-party para ForrandoBet/PixReals, sync incremental, redirect fora do Postgres, keyring | — | PEN/PAR | — |
| PM-BL-26 | ESCALA REP-04 | CSV sem `tracking_token` e PII | — | PEN | `conversion-report.functions.ts:696-718` |
| PM-BL-27 | RECUPERACAO | Corrigir 6 `ultimo_login`, 71+106 depósitos, 25 inscrições de nível, 9 recibos; RPC que não sobrescreve depósito aprovado | Proposto | PEN | — |
| PM-BL-28 | BASELINE P1–P5 | Medição de CPU 24h no Large, Advisors, pico, Realtime, timeouts | Pendente | PEN | — |
| PM-BL-29 | SEC-01 follow-ups | WhatsApp, SMTP, margem, configs graváveis por membro, rollback | Pendente | PEN | §3.2 |
| PM-BL-30 | OPERACAO_SEGURA | Retenção LGPD, rotação de segredos, backup/PITR, on-call | Pendente | PEN | — |
| PM-BL-31 | LEVANTAMENTO | README, INDEX, inverter `.gitignore`, `.env.example` completo, warning budget, `npm audit`, dividir monólitos, E2E, docs canônicos | Recomendado | PEN (só typecheck no CI e remoção de `JOURNEYS_PUBLISHING_ENABLED` feitos) | — |
| PM-BL-32 | TESTE_USABILIDADE | Teste com 3 operadores | Preparado | PEN (só "validação técnica") | 8380778 |
| PM-BL-33 | REMOCAO_BUSINESSCODE | Encerramento formal; default `'businesscode'` em `sms_send_logs.provider`; e-mail pessoal no guia de deploy | — | PAR | `20260527203237`; `docker-deployment.md:8,160` |
| PM-BL-34 | PLANO_FECHAMENTO_SHORTIO | Retenção/expurgo de cliques; SMS complementar de call-flow com tracking | — | PEN | — |

**Entregues e verificados** (amostra): remoção BusinessCode no runtime (cee67eb); CI com typecheck (9085652); P0.1 paridade git/banco; fundação e piloto Short.io; redirect first-party Sorte Alta (63.406/63.407 eventos); CON-08/SEC-01 em código; regras P0 de jornada (inscrição única, faixas exclusivas, PIX 72h, saque 4/dia); prioridades D-3; backfill de nível D-7; filtro de crawler (228db42).

### 7.3 Contradições entre documentos (principais)

1. CON-08 e SEC-01: cabeçalhos "nada aplicado" × ESCOPO_ESCALA "✅ aplicada".
2. Fase C (migrations 110000–113000): "não aplicadas" × SEC-01 "aplicadas" × `c3c07d6` aplicando 121000.
3. FLUXO CRM.docx (no máximo 1 mensagem de régua/dia; cashback D+1) × decisões 2+4/dia e cashback no pagamento.
4. Prioridades: doc de jornadas cruzadas × D-3; D-3/D-6/D-7 "delegadas" ao assistente, não decididas pelo negócio.
5. Limite 7 dias: sugerido 10 × aplicado 14.
6. Atribuição assistida 8–14d e experimentos A/B (ops doc) × removidos pela Central.
7. FTD: glossário "1º depósito aprovado" × regra `ftd_em` mantida.
8. Voz "não publicar até certificar" × "certified voice steps" sem certificação.
9. TPS 15/5 × 30/15 aplicado; Supabase Small × Large (já corrigido na memória do assistente).
10. "Grau A ou nada" × "Recuperação influenciada" sem clique na Central.
11. Status de deploy no VPS: pendente (STATUS_P0/ESCALA) × feito e verificado (AUDITORIA_GATILHOS).
12. Painel de operação dos canais: "por tenant" (OPERACAO_SEGURA) × só super admin no código.

### 7.4 Governança documental

- `.gitignore` ignora `docs/*` com lista de exceções. **Não versionados:** REAUDITORIA_SISTEMA_2026-10-03, ESCOPO_AUDITORIA_JORNADAS_2026-10-07, ESCOPO_CENTRAL_RESULTADOS_CRM_2026-10-15, ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15, FLUXO CRM.docx (especificação de negócio); LEVANTAMENTO e ESCOPO_FUNIL liberados mas nunca adicionados. **Este documento e o escopo também ficarão fora do git até a regra ser invertida.**
- Não existe fonte única de status: o mesmo item aparece em 4–6 documentos com estados diferentes.
- PLANO_DE_ENTREGAS (06/10) e REAUDITORIA (03/10) estão superados; STATUS_P0 obsoleto; CONVERSION_FUNNEL_OPERATIONS desatualizado.
- Faltam: README, arquitetura, ADRs, dicionário de dados, matriz RBAC formal, runbook de deploy/rollback, política LGPD/retenção, backup/PITR/RPO/RTO, on-call.

### 7.5 Registro de riscos

| ID | Risco | Prob. | Impacto | Mitigação | Dono sugerido |
|---|---|---|---|---|---|
| RSK-01 | Opt-out SAIR não capturado (e opt-out de e-mail quebrado) — LGPD/CDC | **Confirmado** | Alto | Fase 0 do escopo; até lá, remover a promessa dos textos ou lista manual | PO + Dev |
| RSK-02 | Regulação de apostas (Lei 14.790/2023, portarias SPA/MF de publicidade e jogo responsável): réguas de reativação, até 6 SMS/dia, textos "lucrar/ganhos insanos", sem aviso 18+, sem exclusão de autoexcluídos — **a verificar com jurídico, não é parecer** | Média | Muito alto | Revisão jurídica de réguas e textos; integrar autoexclusão da casa | Jurídico do cliente |
| RSK-03 | Vazamento entre casas (SEC-10, DEV-62) — incidente reportável à ANPD | **Confirmado** | Muito alto | Fase 0; avaliar se houve uso e comunicação | Dev + DPO |
| RSK-04 | Bus factor 1 (um desenvolvedor + agentes de IA, sem revisão) | Alta | Muito alto | Segundo revisor; docs versionados | Gestão |
| RSK-05 | Dependência de Short Brasil/Infobip (quedas, transporte HTTP, sem fallback) | Média | Alto | Breaker existente; TPS contratado; secundário | Ops |
| RSK-06 | Deploy e migração direto em produção sem homologação e sem rollback | Alta | Alto | Fase 1 | Dev |
| RSK-07 | Números de receita/atribuição exibidos antes da homologação com a casa | Média | Alto | Selo "não homologado" na Central | PO |
| RSK-08 | PII local (CSVs em `base/`, logs, acesso à produção de notebook) | Média | Alto | Política de dados | DPO |
| RSK-09 | CVE crítica do TanStack e Nitro beta | **Confirmado** | Alto | Atualizar | Dev |
| RSK-10 | Custo: créditos 99.999.999 sem teto, ~R$ 72 mil/mês estimados só na Sorte Alta; cobrança por SMS sem segmentos | Média | Alto | Teto diário por casa | Financeiro |
| RSK-11 | Erro humano por trabalho de madrugada (já houve 16 SMS em 2 min; saque à noite até 16/10) | Alta | Alto | Janela de deploy; checklist de publicação | Gestão |
| RSK-12 | Banco crescendo sem retenção (`webhook_logs` 507 MB, temp files 23 GB, "no space left" já ocorreu) | Alta | Alto | DEV-42 | Dev |
| RSK-13 | Monitoramento possivelmente "escuro" em produção (DSN/heartbeats não configurados) | Média | Alto | Configurar e testar alerta | Ops |

### 7.6 Perguntas em aberto para o negócio

1. O congelamento de frentes do ESCOPO_RESOLUCAO volta a valer?
2. A Short Brasil encaminha MO ("SAIR")? Se não, qual canal de opt-out adotar?
3. O jurídico validou réguas de reativação, até 6 SMS/dia e os textos diante das portarias da SPA? Como a autoexclusão chega ao CRM?
4. Houve uso da tela Inteligência ou de campanhas de e-mail "Todos" por admins de casas diferentes? (define se há incidente a comunicar)
5. Holdout padrão (0% × 5%), janela influenciada (72h × 7d), faixas de inatividade (48h × 3d), métrica principal de ROI — quem aprova?
6. Teto diário de gasto por casa e por jornada; preço de R$ 0,12 por casa.
7. WhatsApp: descomissionar formalmente ou trazer para consentimento, segurança e matriz de aceite?
8. Orçamento para homologação e backup/PITR?
9. Quem é o segundo dono técnico do sistema?
10. Quem assina o aceite de P0–P3 de jornadas e F0–F5 da Central?

---

## 8. Recomendação final

**Pausar novas funcionalidades** e executar o [ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md](ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md) na ordem: Fase 0 (contenção, ≤ 3 dias) → Fase 1 (envio confiável e conformidade) → Fase 2 (ambientes e release) → Fase 3 (aceite do que já existe) → Fase 4 (UX e acessibilidade) → Fase 5 (dívida técnica).
