# Tenant de demonstração (clone anonimizado do Sorte Alta)

Data: 2026-10-16
Status: design para aprovação

## Intenção

Ter um tenant onde um cliente em potencial entra **sozinho**, com um login que nós geramos, e explora **o sistema inteiro** (jornadas, campanhas, CRM, resultados, links, WhatsApp, e-mail, voz) com números e comportamento reais do Sorte Alta, mas:

- sem nenhum dado pessoal real (nome, telefone, e-mail, CPF, data de nascimento, IDs externos da casa);
- sem nenhuma conexão de entrada (webhooks da casa, sync, callbacks);
- sem nenhum envio real em nenhum canal;
- sem nenhuma forma de quem tem o login transformar o demo em operação real (conectar WhatsApp, colar token, comprar crédito, convidar gente, mudar status do tenant).

O requisito duro é o último: **ninguém que acesse consegue usar de forma real**. Isso vale mesmo que alguém altere variáveis de ambiente de canary, ative uma jornada, chame uma server function direto pelo navegador ou que um cron novo seja criado no futuro sem pensar no demo.

## Metas

1. Um tenant novo, marcado como demo de forma que o servidor reconheça (não só a UI).
2. Cópia **congelada** (foto de 2026-10-16) dos dados do Sorte Alta, anonimizada, com os mesmos volumes, taxas, valores e distribuição temporal.
3. Trava no servidor, **fail-closed**, em toda saída externa, que recusa qualquer tenant demo.
4. Workers/crons pulam tenants demo antes de reivindicar trabalho (segunda camada, evita mutar a foto).
5. Bloqueio no servidor de todas as ações que conectam o demo a algo real.
6. Script para gerar logins demo (e-mail + senha aleatória), e para recriar o demo do zero (reset).
7. Aviso visível na UI de que é ambiente de demonstração.

## Não-metas

- Demo "vivo": não simula envios novos nem gera resultados novos. A foto envelhece; "últimos 7 dias" fica vazio com o tempo. Aceito pelo usuário.
- Isolamento entre prospects: todos os logins demo compartilham o mesmo tenant. Se um prospect edita algo, o próximo vê. Mitigação: script de reset.
- Tela de autoatendimento para criar logins demo. Os logins são gerados por script.

## Anti-metas (falha mesmo que "funcione")

- Qualquer mensagem chegar a um telefone/e-mail real a partir do demo, por qualquer caminho.
- Qualquer dado pessoal real de jogador do Sorte Alta aparecer no demo (inclusive dentro de `raw_payload`, `provider_response`, `metadata`, conteúdo de SMS ou HTML de e-mail).
- O demo mostrar a marca "Sorte Alta" ou links/domínios reais da casa para terceiros.
- A trava depender só da UI ou só de env var.
- Uma chamada ao Short.io, Evolution, Infobip, Short Code/Short Brasil, ElevenLabs ou webhook externo sair com o tenant demo.

## Contexto encontrado no código e no banco (2026-10-16)

- Credenciais de todos os provedores são **globais** (env vars): SMS (`SHORTCODE_SMS_TOKEN` / Short Brasil), e-mail e voz (Infobip), WhatsApp (Evolution), Short.io, ElevenLabs. Nenhum tenant cadastra chave própria.
- `tenants` tem `status` (`active|suspended|trial|canceled`), `plano`, `crm_model`, `webhook_token`, `webhook_secret`, `webhook_hmac_enforced`, `metadata`. Não existe flag de demo/sandbox.
- A única trava de tenant hoje é `assertTenantCanOperate` (`src/lib/tenant-access.server.ts:85`), usada no SMS e nas entradas de UI. Nenhum cron/worker olha `status`.
- Sorte Alta: id `03b73a96-aef7-414d-94fc-93a996f8256b`, slug `pixpgf`, `CRM_PLATAFORMA`. Dados de 2026-09-02 a 2026-10-16. Volumes principais: 21.118 players, 84.778 deposits, 13.948 withdrawals, 116.525 events, 6.080 sessions, 62.741 sms_send_logs, 63.338 sms_credit_ledger, 13 journeys / 151 steps, 38.549 enrollments, 57.898 step executions, 145.584 journey_events, 33.975 tracked_links / link_dispatches, 10.293 click_events, 207.535 link_click_snapshots, 11.890 player_attributions, 174 conversion_attributions, 17 sms_campaigns, 158 crm_results_daily.
- Pontos de saída e chokepoints mapeados:

| Canal | Onde travar | Observação |
|---|---|---|
| SMS | `sendSmsInternal` (`src/lib/sms.functions.ts` ~:749) e `sendSmsBatch` (`src/lib/sms-bulk.server.ts` ~:597) | tenant pode vir nulo (call-flows sem `tenantId`); falhar fechado |
| E-mail | `sendInfobipEmail` (`src/lib/email-send.server.ts` ~:80) | todos os chamadores passam tenant |
| Voz | `callInfobipVoice` (`src/lib/infobip-voice.server.ts:71`) | tornar `tenantId` obrigatório; 3 chamadores não passam hoje (`calls.server.ts:348`, `calls.functions.ts:718`, `call-flows.server.ts:284`) |
| WhatsApp | `evolutionFetch` (`src/lib/evolution.server.ts:18`) | não conhece tenant; ver decisão abaixo |
| Webhook externo WhatsApp | `sendExternalTriggerEvent` (`src/lib/whatsapp-external.server.ts:244`) | tem tenant |
| Short.io | `settingsForTenant` (`src/lib/shortio.server.ts:86`) e criação de link | bloqueado também upstream |
| ElevenLabs | `callElevenLabs` (`src/lib/calls.server.ts:167`) | manda texto com dados de jogador para terceiro |
| IA (OpenAI / gateway) | `supabase/functions/ai-player-insights`, `src/lib/ai-gateway.ts`, `src/lib/email-ai.functions.ts` | **bloqueado** para demo (decisão do usuário); a edge function precisa da própria checagem, fora da trava TS |

- Ações que hoje **qualquer membro** do tenant executa sem checagem de papel: criar/conectar sessão WhatsApp com QR (`src/lib/whatsapp.functions.ts:50,127,312-360`), proxies (`src/lib/whatsapp-proxies.functions.ts`), token Meta Ads (`src/lib/meta.functions.ts:268,453-587`), integrações de marketing (`src/lib/marketing.functions.ts:618`), checkout de crédito SMS (`src/lib/sms-credits.functions.ts:203`).
- Ações de admin/gestor: token/HMAC do webhook da casa (`src/lib/webhooks.functions.ts`), Short.io settings, URL do webhook externo WhatsApp, convites de equipe (`src/lib/tenants.functions.ts:585`).

## Design

### 1. Marcação do tenant demo

Adicionar a `tenants` uma coluna booleana `is_demo not null default false`. Decisão minha: coluna própria em vez de `metadata.demo` ou de um novo valor de `status`, porque:
- `status` já é usado com outra semântica (suspensão) e vários lugares tratam `active`/`trial`;
- coluna tipada permite filtro direto em SQL (crons/RPCs) e não some se alguém reescrever `metadata`.

Proteção da própria flag: só `service_role` pode alterar `is_demo` (trigger que rejeita `UPDATE` de `is_demo` vindo de qualquer outro papel, inclusive super-admin pela UI). `updateTenantSettings` não expõe o campo. Assim um login demo nunca consegue "desligar o modo demo".

Também no tenant demo: `webhook_token` e `webhook_secret` aleatórios novos e nunca exibidos; `webhook_hmac_enforced = true`; `status = 'active'` (para a UI não bloquear); nome e slug fictícios.

### 2. Trava de saída (camada 1, a que garante)

Nova função em `src/lib/tenant-access.server.ts`, ao lado de `assertTenantCanOperate`:

```ts
assertTenantCanSendExternally(tenantId: string | null | undefined): Promise<void>
```

- `tenantId` nulo/indefinido → **lança** (fail-closed). Para isso, os chamadores que hoje não passam tenant precisam passar.
- tenant com `is_demo = true` → lança `DemoTenantSendBlockedError` (código estável, ex. `DEMO_SEND_BLOCKED`).
- tenant `suspended`/`canceled` → mesmo comportamento atual de `assertTenantCanOperate`.
- Leitura do tenant **sem cache entre requests** (ou cache de no máximo alguns segundos), para que marcar um tenant como demo tenha efeito imediato.

Chamar em todos os pontos da tabela acima, **imediatamente antes** da chamada de rede ao provedor (não só no começo da função de alto nível), incluindo Short.io e ElevenLabs.

WhatsApp: guardar dentro de `evolutionFetch` para todo path que envia mensagem (`/message/*`) e também para criar/conectar/reiniciar instância e setar webhook/proxy. Resolver o tenant pelo `instance_name` em `whatsapp_sessions`; instância desconhecida → bloquear. Decisão minha: guard no transporte, porque é o único ponto único e não depende de lembrar dos 4+ chamadores.

Comportamento visível: a server function retorna erro tratado e a UI mostra um toast/diálogo "Ambiente de demonstração: nenhum envio é feito". **Nada é gravado** como se tivesse enviado (sem `sms_send_logs`, sem débito de crédito, sem `link_dispatches`). Decisão minha: recusar em vez de fingir sucesso, porque fingir exigiria gravar linhas falsas e essas linhas virariam trabalho para callbacks e reconciliações.

### 3. Workers e crons pulam o demo (camada 2)

Objetivo: o demo nunca ter trabalho reivindicado, para a foto não mudar e para não depender só da camada 1.

- RPCs de claim (`claim_sms_flow_leads`, `claim_due_sms_campaigns`, `claim_due_email_campaigns`, `claim_journey_scan_jobs`, claims de jornada/enrollments, `claim_webhook_logs_for_replay`, `recover_stuck_*`, `process_journey_level_outbox`) excluem tenants `is_demo`.
- Loops que iteram `public.tenants` excluem demo: cron de orchestrate (SQL `FROM public.tenants`), `refresh_recent_dashboard_metrics_slot`, `refresh_crm_results_recent`, `check_crm_results_recent`, `syncShortioMetrics` (loop por tenant de `tracked_links`), cashback catchup, `evaluateAllPlayers`, `runDispatcher` (WhatsApp), precall, call flows, voice queue, reconciliação Infobip.
- Exceção a decidir pelo builder: os refreshes de métricas derivadas (`crm_results_daily`, dashboard) podem rodar **uma vez** no fim da carga para gerar os agregados a partir dos dados clonados, e depois o demo fica fora dos loops.

O builder deve procurar por qualquer outro worker/RPC que itere tenants e aplicar o mesmo filtro. Um teste deve listar as funções SQL com loop sobre `tenants` e falhar se alguma não tiver o filtro (ou equivalente).

### 4. Entradas bloqueadas

- Webhook da casa (`/api/public/webhook/{token}/{evento}`): se o tenant do token é demo → 403, sem processar nem gravar `webhook_logs`. Também excluir demo do espelhamento para tenants `CRM_EXPERT` (`webhook-process.server.ts:1035-1045`) como destino.
- Evolution webhook: instância de tenant demo → ignorar. (Não deve existir instância real, mas a regra fica.)
- Callbacks globais (SMS DLR, Infobip e-mail/voz): como o demo nunca envia, `provider_message_id`s clonados não podem coincidir com os reais. A carga **reescreve** todos os IDs de provedor e idempotency keys (ver seção 6), então um callback real nunca atualiza linha do demo.
- `/click/{token}` e `/u/{token}`: tokens clonados são regenerados; links do demo redirecionam para um destino neutro (ver 6).
- Scripts manuais (`scripts/sync-sortealta-export.mjs`, `import-sortealta-leads.mjs`, `sync-sorte-alta-crm-flows.mjs`): usam slug/ID fixo do Sorte Alta, então não tocam o demo. Adicionar checagem: se o tenant resolvido for demo, abortar.

### 5. Ações bloqueadas para quem usa o demo

No servidor (não só UI), para tenant demo, recusar com `DEMO_ACTION_BLOCKED`:

- WhatsApp: criar/conectar/reconectar/desconectar/excluir/renomear sessão, QR code, proxies, atribuir proxy, configurar webhook Evolution, enviar mensagem manual/mídia.
- Meta Ads e integrações de marketing: conectar/validar/selecionar/desconectar token.
- Créditos SMS: checkout/compra.
- Webhook da casa: ver/rotacionar token, provisionar, mudar HMAC.
- Short.io settings, webhook externo WhatsApp (salvar, testar, enviar amostras).
- Equipe: convidar, adicionar usuário, mudar papel, remover usuário.
- Configurações do tenant: renomear, status, plano, `crm_model`.
- Testes de envio (SMS/e-mail/voz/WhatsApp de teste) também caem na trava da seção 2.

Ações que **continuam livres** dentro do demo (para a pessoa explorar): criar/editar jornadas, rascunhos de campanha, templates, segmentos/audiências, filtros, ativar/pausar jornadas (sem efeito, porque os workers pulam o demo), ver relatórios, exportar CSV (dados são falsos).

Na UI: banner fixo "Ambiente de demonstração — nenhuma mensagem é enviada e nada aqui é real"; botões das ações bloqueadas desabilitados com tooltip explicando. A UI é cosmética; a garantia é o servidor.

### 6. Clonagem anonimizada (foto congelada)

Script único e idempotente, rodando com service role: `scripts/demo/clone-tenant-demo.mjs --source pixpgf --target demo --apply` (dry-run por padrão, igual aos scripts existentes). Ele **apaga e recria** os dados do tenant demo, servindo também como reset.

Regras:

- **Novo tenant**: nome e slug fictícios (decisão minha: "Casa Demo" / `demo`; ajustável). `is_demo = true`.
- **IDs**: todo `id` e toda FK é remapeada para UUID novo, mantendo as relações. Nenhum UUID do Sorte Alta reaparece no demo.
- **Datas**: mantidas como estão (foto de 2026-10-16). Sem deslocamento.
- **Valores**: mantidos (depósitos, saques, saldos, contagens, durações, status, flags, níveis, tags, risco, VIP, UTMs genéricos). Isso preserva gráficos e taxas.
- **Dados pessoais substituídos por falsos, consistentes por jogador** (o mesmo jogador tem o mesmo nome falso em todas as tabelas): `nome`, `telefone`, `email`, `cpf` (válido em formato, gerado), `data_nascimento` (mesma faixa etária ±), `player_external_id`, `affiliate_id`, `expert`. Telefones falsos devem ser **não roteáveis** (decisão minha: faixa fictícia reservada, ex. DDD válido + prefixo `9 0000`, e e-mails em domínio reservado `@example.com`), para que, mesmo se uma trava falhar, o envio não chegue a ninguém.
- **Campos livres com PII ou dados de provedor**: `raw_payload`, `provider_response`, `last_callback`, `metadata`, `evidence` → zerados (`{}`) ou reduzidos a chaves não sensíveis que a UI precisa. O builder deve conferir quais chaves a UI lê.
- **Conteúdo de mensagens** (`sms_send_logs.content`, templates SMS/e-mail, variantes em `journey_steps.config`, `call_history.rendered_text`, scripts de voz): trocar nome do jogador pelo nome falso, marca "Sorte Alta"/"pixpgf"/domínios reais pela marca fictícia e domínio neutro, e links curtos reais por links do demo.
- **Links**: `tracked_links.short_url`, `shortio_link_id`, `original_url`, `link_dispatches.sent_url/original_url` reescritos para domínio neutro (decisão minha: `https://demo.betleads.io/...` ou similar sem redirecionamento real); `tracking_token` regenerado; `status` dos tracked_links mantido para a UI, mas fora do sync (seção 3). Nenhum `shortio_link_id` real pode ficar no demo.
- **IDs de provedor e idempotência**: `provider_message_id`, `provider_call_id`, `provider_request_id`, `idempotency_key`, `event_id`, `provider_event_id`, `external_id` → regenerados.
- **Hashes**: `recipient_hash`, `ip_hash`, `user_agent_hash`, `canonical_url_hash` → regenerados/recalculados a partir dos dados falsos.
- **Não clonar**: `webhook_logs`, `webhook_event_receipts`, `financial_webhook_attempts` (payload bruto da casa), `dispatcher_runs`, `link_tracking_sync_runs`, `admin_audit_logs`, `tenant_audit_logs`, `ops_backup_*`, `user_roles`, `email_unsubscribe_tokens`, `journey_voice_assets` com áudio que contenha dado real (avaliar), `journey_scan_jobs`, `journey_level_outbox`, `dispatch_pause_state`. Se alguma tela depender de uma dessas para não quebrar, o builder gera poucas linhas sintéticas ou deixa vazia com estado vazio.
- **Clonar** (com as regras acima): players, deposits, withdrawals, events, sessions, player_attributions, journeys, journey_steps, journey_enrollments, journey_step_executions, journey_events, journey_contact_limits, journey_crossing_states, sms_campaigns, sms_audiences, sms_templates(+versions), sms_send_logs, sms_credit_ledger, tenant_sms_credit_balances, tenant_sms_pricing, email_templates(+versions), email_senders (com remetente fictício), email_send_logs, tracked_links, link_dispatches, click_events, link_click_snapshots (avaliar se precisa das 207k linhas ou só do agregado), conversion_attributions, conversion_attribution_issues, crm_results_daily, crm_results_health, player_lifecycle_daily, tenant_daily_metrics, activation_runs, campaign_drafts, call_queue, call_history, call_scripts(+versions), voice_contact_policies, send_window_settings, dashboard_settings, shortio_settings (com domínio neutro).
- **Agregados**: depois da carga, recalcular `crm_results_daily`, métricas de dashboard e lifecycle a partir dos dados clonados (ou copiar os agregados do Sorte Alta, que já batem com os dados, já que valores e datas são iguais).
- **Verificação automática ao fim do script**: varrer todas as colunas texto/jsonb das tabelas do demo procurando qualquer telefone, e-mail, CPF, `player_external_id`, `provider_message_id`, `shortio_link_id`, UUID ou domínio do Sorte Alta. Qualquer acerto → o script falha e reverte.

Execução em produção requer autorização explícita do usuário no momento (regra do projeto).

### 7. Logins demo

Script `scripts/demo/create-demo-login.mjs --count N [--label "prospect X"]`:
- cria usuário Supabase Auth com e-mail gerado (decisão minha: `demo+<rótulo>-<aleatório>@betleads.io`, que não precisa existir como caixa real porque não há fluxo de confirmação nem recuperação) e senha aleatória forte;
- `app_metadata`: `is_demo_user = true`, sem `force_password_change` (para o prospect entrar direto);
- `user_roles`: **somente** no tenant demo, papel `gestor` (decisão minha: precisa enxergar tudo; as ações perigosas de gestor estão bloqueadas pela seção 5). Nunca `admin`, nunca `super_admin`, nunca outro tenant;
- trigger/checagem no banco: usuário com `is_demo_user` não pode ganhar `user_roles` em tenant não-demo;
- usuário demo não pode trocar e-mail nem senha pela UI (decisão minha: evita "tomar posse" da conta); sem recuperação de senha;
- opção `--revoke` para desativar um login e `--expires-at` opcional;
- imprime e-mail + senha no terminal para o usuário repassar.

### 8. Testes exigidos

- Unitários da trava: tenant demo, tenant nulo, tenant suspenso, tenant normal, para cada canal (SMS single e batch, e-mail, voz, WhatsApp via `evolutionFetch`, webhook externo, Short.io, ElevenLabs). Mock do `fetch` deve provar que **nenhuma** requisição de rede sai.
- Servidor: cada ação da seção 5 retorna `DEMO_ACTION_BLOCKED` para tenant demo.
- SQL: RPCs de claim e loops de tenants não retornam linhas do demo.
- Trigger: `is_demo` não muda fora do service role; demo user não ganha papel fora do demo.
- Script de clone: roda em banco local/teste com dados sintéticos e a varredura de PII passa; rodar duas vezes dá o mesmo resultado (idempotente).

### 8b. Áreas sem dados e IA

- O Sorte Alta não tem dados de WhatsApp (`whatsapp_*`, `lead_whatsapp_assignments`, `flows`/`flow_leads`), Meta Ads / marketing (`meta_*`, `marketing_*`), IA (`ai_*`), pré-call, fluxos SMS/e-mail/call (`*_flow*`), `lead_followups`, `lead_alerts`. Essas áreas ficam **vazias** no demo, com estado vazio dizendo "Nenhum dado neste ambiente de demonstração". Nada é sintetizado (decisão do usuário).
- Recursos de IA (insights de jogador, sugestão de texto de e-mail, qualquer chamada ao gateway/OpenAI) ficam **bloqueados** para tenant demo no servidor, inclusive na edge function `ai-player-insights`. A UI mostra "Indisponível no ambiente de demonstração" (decisão do usuário).

### 9. Arquivos no Storage

Áudios de voz (`journey_voice_assets`, 1 linha no Sorte Alta), mídias e imagens usadas em templates de e-mail **não são copiados**. O clone aponta essas referências para arquivos neutros de placeholder (um áudio genérico e uma imagem genérica sem marca) gravados num caminho do tenant demo. O reset apaga e recria esses objetos. Decisão minha: áudio pode conter nome de jogador real e imagens carregam a marca, e a varredura de PII não enxerga dentro de arquivo.

### 10. Visões globais e de super-admin

O tenant demo fica **fora** de totais globais e relatórios de plataforma (faturamento/consumo de SMS, créditos, saúde de tenants, visão da plataforma), para não contar o Sorte Alta duas vezes. Ele continua aparecendo na lista de tenants do super-admin, com selo "demo". Decisão minha.

### 11. Troca de e-mail/senha pelo usuário demo

Bloqueio só na UI, mais `--revoke` no script. Decisão minha: mesmo que alguém troque a própria senha via cliente Supabase, a conta continua presa ao tenant demo (trigger da seção 7) e nada nele envia ou conecta, então "tomar posse" não dá uso real.

## Decisões do usuário (nesta conversa)

- O prospect explora sozinho e precisa ver tudo.
- Manter números e comportamento reais; trocar identidades por falsas.
- Foto congelada de hoje; não precisa parecer vivo.
- Seguir o desenho proposto (tipo demo + trava única no servidor fail-closed + bloqueio de integrações + logins limitados + sem logs brutos de webhook).
- Áreas sem dado no Sorte Alta ficam vazias, sem dados sintéticos.
- IA bloqueada no demo.

## Decisões minhas (o usuário pode trocar)

- Coluna `tenants.is_demo` em vez de status/metadata.
- Recusar envio com mensagem clara em vez de fingir sucesso.
- Trava WhatsApp dentro de `evolutionFetch`.
- Nome/slug fictícios ("Casa Demo" / `demo`), marca e domínios reais removidos.
- Telefones não roteáveis e e-mails `@example.com`.
- Papel `gestor` para logins demo; edições dentro do demo permitidas; reset pelo script de clone.
- Logins sem troca de senha/e-mail (bloqueio só na UI + revogação; ver seção 11).
- Arquivos do Storage não copiados; placeholders neutros no lugar.
- Demo fora dos totais globais e relatórios de plataforma.

## Deixado para o builder

- Ordem de implementação e quebra em PRs.
- Formato exato do gerador de dados falsos (biblioteca ou tabela de nomes própria).
- Quais chaves de `metadata`/`evidence` a UI precisa manter.
- Se `link_click_snapshots` vai inteiro ou reduzido.
- Detalhe de UI do banner e dos botões desabilitados.
