# Plano de fechamento — encurtamento e rastreamento Short.io

Atualizado em: 06/10/2026  
Documento canônico de acompanhamento: este é o único arquivo em que o status da
implantação deve ser atualizado. O escopo original permanece como referência de
arquitetura e contexto.

## Legenda e regra de atualização

- `[ ]` pendente;
- `[~]` parcialmente entregue ou em execução;
- `[x]` concluído e validado com evidência.

Um item somente pode receber `[x]` quando houver evidência proporcional ao risco:
arquivo/rota alterada, migration aplicada quando necessária, teste executado,
commit publicado e validação no ambiente aplicável. Build isolado não encerra item
funcional.

Ao final de cada entrega:

1. atualizar este checklist e o registro de evidências;
2. executar testes e build relacionados;
3. reiniciar e validar o runtime local;
4. fazer commit e push somente dos arquivos do escopo;
5. listar as entregas ainda pendentes;
6. quando houver efeito remoto, registrar deploy e homologação em produção.

## Decisões congeladas

- [x] Canais desta etapa: SMS e e-mail.
- [x] WhatsApp está fora do rollout e não deve ser habilitado por fallback.
- [x] Atribuição adotada: individual, por destinatário, URL e envio.
- [x] API key central, mantida exclusivamente no servidor.
- [x] Domínio do piloto: `bmkt.click`.
- [x] Tenant piloto: Sorte Alta.
- [x] O usuário decide, em cada mensagem/campanha/etapa, se deseja rastrear links.
- [x] O preview usa URL ilustrativa; links Short.io reais só são criados no envio.
- [x] Quando desligado, o conteúdo mantém a URL original e não cria dispatch.
- [x] URLs de descadastro, mídia, esquemas não navegáveis e links técnicos protegidos
  não devem ser encurtados.

## Situação consolidada

| Frente | Estado | Observação |
| --- | --- | --- |
| Fundação e banco | `[x]` | tabelas, RLS, índices, configurações e migrations aplicadas |
| Domínio e credencial | `[x]` | chave no runtime e HTTPS de `bmkt.click` validado |
| Piloto SMS | `[~]` | envio e clique validados; escolha por mensagem ainda incompleta |
| Piloto e-mail | `[~]` | canal habilitado; escolha implementada somente no teste manual |
| Idempotência e auditoria | `[~]` | persistência existe, mas retry e vínculo com logs precisam de correção |
| Sincronização | `[~]` | cron de 15 minutos ativo; faltam reconciliação, lock e observabilidade global |
| Relatórios | `[~]` | visão básica e ficha do jogador entregues; faltam recortes e exceções |
| Homologação final | `[ ]` | depende de todas as entregas abaixo |

## Entrega 1 — Correção do núcleo e idempotência

Objetivo: garantir que o mesmo envio/retry não crie links ou dispatches duplicados
e que a origem apresentada nos relatórios seja confiável.

- [x] Criar chave idempotente determinística por tenant, envio, destinatário e
  posição da URL; não usar UUID novo como identidade de retry.
- [x] Impedir duplicação de link e `link_dispatch` em retries e concorrência.
- [x] Corrigir taxonomia de origem: `manual`, `test`, `campaign`, `sms_flow`,
  `email_flow`, `journey` e `call_flow_sms`.
- [x] Vincular cada dispatch ao log real por `message_log_type/message_log_id`.
- [x] Preservar conteúdo original e conteúdo efetivamente enviado para auditoria.
- [x] Remover/desabilitar o modo agregado da configuração enquanto ele não tiver
  implementação real.
- [x] Remover WhatsApp dos canais de fallback global.
- [x] Proteger links de login único, assinados e temporários com regras explícitas.
- [x] Reforçar proteção SSRF com validação de DNS/IP resolvido antes da criação.
- [x] Adicionar testes de retry, concorrência, fallback e isolamento por tenant.

Critério de aceite: repetir o mesmo envio não cria novo link, dispatch ou mensagem;
o registro aponta para o log correto e aparece na origem correta do dashboard.

## Entrega 2 — Controles e previews de SMS

Objetivo: toda superfície que pode enviar URL por SMS oferece escolha real e calcula
o custo com base no conteúdo estimado de envio.

- [x] Componente compartilhado de escolha e exemplo de URL curta.
- [x] Nova campanha SMS integrada ao backend e à persistência.
- [x] Diálogo de envio individual integrado ao backend.
- [ ] Conectar os controles existentes da página principal de SMS ao `trackLinks`.
- [ ] Adicionar opção ao SMS de teste.
- [ ] Adicionar e persistir opção em cada etapa dos fluxos SMS.
- [ ] Adicionar e persistir opção em cada etapa SMS de jornadas.
- [ ] Adicionar opção ao SMS complementar de fluxos de ligação.
- [ ] Garantir que reenvios preservem a escolha do envio original.
- [ ] Exibir o controle somente quando houver URL HTTP(S) elegível após renderização.
- [ ] Mostrar preview com cada URL elegível representada por `bmkt.click/abc123`.
- [ ] Calcular segmentos GSM-7 e UCS-2 corretamente, incluindo mensagens concatenadas.
- [ ] Mostrar caracteres, partes e créditos original versus estimado.
- [ ] Recalcular após variáveis como `{nome}`, `{link}` e `{link_deposito}`.
- [ ] Registrar no histórico se o envio usou rastreamento.

Critério de aceite: marcar/desmarcar altera preview, segmentos, créditos, conteúdo
enviado e criação de dispatch em todos os caminhos SMS.

## Entrega 3 — Controles e previews de e-mail

Objetivo: toda superfície de e-mail persiste e respeita a escolha, sem alterar
descadastro, imagens ou links técnicos.

- [x] E-mail de teste aceita e respeita `trackLinks`.
- [ ] Template de e-mail carrega, edita, salva e duplica `track_links`.
- [ ] Campanha de e-mail carrega, edita, salva e duplica `track_links`.
- [ ] Automação de e-mail carrega, edita, salva e duplica `track_links`.
- [ ] Fluxos de e-mail persistem a opção por bloco de envio.
- [ ] Jornadas persistem a opção por etapa de e-mail.
- [ ] Dispatcher de campanhas repassa a escolha ao envio final.
- [ ] Dispatcher de automações/fluxos repassa a escolha ao envio final.
- [ ] Preview considera somente links navegáveis `a[href]` elegíveis.
- [ ] Preview representa CTAs selecionados com `bmkt.click/abc123`.
- [ ] Descadastro, `mailto:`, `tel:`, imagens, CSS, pixels e links protegidos permanecem intactos.
- [ ] Registrar no histórico se o envio usou rastreamento.

Critério de aceite: o HTML entregue corresponde à escolha salva e somente âncoras
elegíveis são reescritas por destinatário.

## Entrega 4 — Persistência, configuração e segurança operacional

- [x] Coluna `track_links` em campanhas SMS, etapas SMS, templates, campanhas e
  automações de e-mail.
- [ ] Adicionar persistência equivalente a jornadas e blocos/fluxos que ainda usam JSON.
- [ ] Expor canais habilitados na configuração administrativa.
- [ ] Exibir teste de conexão/domínio, último sync e estado da integração.
- [ ] Validar que somente administradores alteram configuração.
- [ ] Implementar health check sem retornar chave ou dados sensíveis.
- [ ] Definir e documentar retenção; implementar expurgo após decisão de LGPD.
- [ ] Garantir que logs estruturados não contenham credencial ou PII em URL/tag.

Critério de aceite: configurações e escolhas sobrevivem a edição/duplicação, ficam
isoladas por tenant e podem ser auditadas sem exposição de segredo.

## Entrega 5 — Sincronização, observabilidade e relatórios

- [x] Cron autenticado a cada 15 minutos via `pg_cron`/`pg_net`.
- [x] Snapshot agregado de cliques e correção de `clicksStatistics`.
- [x] Dashboard básico por canal/origem.
- [x] Histórico básico de links na ficha do jogador.
- [ ] Registrar toda execução global em `link_tracking_sync_runs`.
- [ ] Adicionar lock para impedir sincronizações sobrepostas.
- [ ] Persistir cursor/data de corte e permitir retomada.
- [ ] Criar reconciliação diária dos últimos sete dias.
- [ ] Coletar `human_clicks` quando suportado pela conta/API; caso contrário,
  registrar formalmente como indisponível.
- [ ] Exibir último sync, links processados, falhas e atraso operacional.
- [ ] Criar fila de exceções com reprocessamento idempotente autorizado.
- [ ] Adicionar filtros de período, canal, campanha, fluxo, jornada e CTA.
- [ ] Corrigir CTR para usar denominador explicitamente definido e documentado.
- [ ] Exibir contatos únicos somente quando a associação individual for inequívoca.
- [ ] Adicionar alerta para erro elevado, cron atrasado e limite da Short.io.

Critério de aceite: os números reconciliam com a Short.io numa janela definida e
qualquer falha pode ser identificada e reprocessada sem duplicação.

## Entrega 6 — Testes, homologação e encerramento

- [x] Teste controlado SMS criou link, entregou, redirecionou e sincronizou clique.
- [ ] Testar rastreamento ligado e desligado em todos os caminhos SMS.
- [ ] Testar rastreamento ligado e desligado em todos os caminhos de e-mail.
- [ ] Cobrir URL com query/fragmento, múltiplas URLs, Unicode e limites SMS.
- [ ] Cobrir HTML malformado, múltiplos CTAs, imagens e descadastro.
- [ ] Cobrir destinatário sem player, lotes, retries e concorrência.
- [ ] Cobrir RLS e ausência de vazamento entre tenants.
- [ ] Executar suíte automatizada, build e validação do runtime.
- [ ] Aplicar migrations e confirmar schema remoto.
- [ ] Fazer deploy e smoke test em produção.
- [ ] Executar teste controlado de e-mail com abertura do link.
- [ ] Validar cron, snapshot, dashboard e histórico após o teste de e-mail.
- [ ] Documentar rollback: desabilitar tenant/canal sem invalidar links enviados.
- [ ] Registrar aceite final do piloto Sorte Alta.

Critério de aceite: todos os itens bloqueadores estão `[x]`, SMS e e-mail passam
nos cenários ligado/desligado e existe evidência de produção e rollback.

## Melhorias futuras — não bloqueiam o fechamento

- [ ] Eventos brutos de clique e atributos individuais aprovados pela LGPD.
- [ ] Garantia/atribuição de conversão financeira após clique.
- [ ] Exportações analíticas avançadas.
- [ ] Modo agregado por campanha/CTA.
- [ ] Credenciais Short.io distintas por tenant.
- [ ] Backfill de links históricos com mapeamento confiável.
- [ ] Inclusão futura de WhatsApp, mediante novo escopo e homologação própria.

## Registro de evidências

| Data | Entrega | Evidência |
| --- | --- | --- |
| 06/10/2026 | Fundação | migrations `20261006150000` a `20261006190000` aplicadas |
| 06/10/2026 | Integração inicial | commit `092bd56` |
| 06/10/2026 | Métricas | commits `77ae128`, `23c3890` e correção `9180870` |
| 06/10/2026 | Configuração e piloto | commits `2f7487e`, `109f747`, `58cf876` |
| 06/10/2026 | Testes e histórico | commits `fd90bb3`, `2de8b8b` |
| 06/10/2026 | Cron | commit `02e3d78`; job remoto ativo em `*/15 * * * *` |
| 06/10/2026 | Escolha por mensagem — parcial | commit `0e5cfd9` |
| 06/10/2026 | Piloto SMS | `bmkt.click/9kZdSI`, envio e redirecionamento confirmados; snapshot com clique |
| 06/10/2026 | Entrega 1 | migration `20261006193000` aplicada; teste de política/idempotência passou; build passou |

## Definição de pronto

A etapa Short.io só será encerrada quando:

- todas as tarefas das Entregas 1 a 6 estiverem `[x]` ou tiverem decisão formal de
  retirada registrada neste documento;
- SMS e e-mail respeitarem a escolha em toda superfície de envio;
- preview e custo SMS representarem corretamente o conteúdo estimado;
- retries forem idempotentes e dispatches estiverem vinculados aos logs;
- cron, observabilidade, dashboard e reprocessamento estiverem operacionais;
- migrations, testes, build, deploy, smoke tests e rollback estiverem documentados;
- o piloto Sorte Alta tiver aceite final registrado.
