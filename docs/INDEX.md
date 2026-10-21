# Índice da documentação

**Atualizado em:** 16/10/2026 (F3-01)
**Fonte de status do projeto:** a seção 8 de [ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md](ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md). Os status de outros documentos são históricos; em caso de conflito, vale aquela tabela.
**Regra:** todo documento novo entra neste índice no mesmo PR. Material com segredo, credencial ou dado pessoal vai para `docs/private/` (ignorado pelo git) e nunca entra aqui.

Status usados:

- **Vigente**: referência atual; pode ter itens em aberto, rastreados no ESCOPO_CORRECOES.
- **Superado por X**: substituído por outro documento; manter só como histórico.
- **Encerrado**: o trabalho descrito foi concluído ou formalmente fechado.
- **Obsoleto**: descreve um estado que não vale mais e não foi substituído por um documento equivalente.

## Documentos

| Documento | Tipo | Data | Status | Para que serve |
|---|---|---|---|---|
| [ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md](ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md) | escopo | 21/10/2026 | Proposto | Pix da Upper para o plano mensal (R$ 4.000) e créditos com saldo único que não expira (SMS R$ 0,08 por segmento, voz R$ 0,09/30 s, e-mail 100 mil grátis + R$ 0,002); casas isentas no plano `interno`; fases PG0–PG6. |
| [operacoes/RUNBOOK_VIRADA_SALDO_UNICO.md](operacoes/RUNBOOK_VIRADA_SALDO_UNICO.md) | runbook | 21/10/2026 | Proposto | Roteiro de virada em produção do PG1 (saldo único em BRL): checagens, as 5 migrations, conversão dos créditos legados, deploy, refresh da Central de Resultados, hardening e rollback. |
| [AUDITORIA_COMPLETA_SISTEMA_2026-10-16.md](AUDITORIA_COMPLETA_SISTEMA_2026-10-16.md) | auditoria | 16/10/2026 | Vigente | Auditoria de UX, dev, red team, QA e gestão; origem dos IDs SEC/DEV/QA/UX/PM. |
| [ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md](ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md) | escopo | 16/10/2026 | Vigente | Plano de correção em fases F0–F5 e **quadro único de status** (seção 8). |
| [ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15.md](ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15.md) | auditoria | 15/10/2026 | Vigente | Gatilhos de entrada e saída, sobreposição e frequência das jornadas; decisões de 15/10 (2+4/dia, prioridades). |
| [ESCOPO_CENTRAL_RESULTADOS_CRM_2026-10-15.md](ESCOPO_CENTRAL_RESULTADOS_CRM_2026-10-15.md) | escopo | 15/10/2026 | Vigente | Central de Resultados (recuperação, redepósito, custo, funil). Implementada sem aceite (F3-07). |
| [CON-08_RLS_REVISAO_SEGURANCA.md](CON-08_RLS_REVISAO_SEGURANCA.md) | evidência | 15/10/2026 | Vigente | Revisão de segurança da consolidação de RLS e matriz de acesso. Estado em produção em verificação (F0-10). |
| [SEC-01_CORRECAO_PERMISSOES.md](SEC-01_CORRECAO_PERMISSOES.md) | evidência | 15/10/2026 | Vigente | Correção de permissões (achados F1–F6 do CON-08), rollout e rollback. Estado em produção em verificação (F0-10); pendências em F2-12. |
| [RECUPERACAO_EVENTOS_PERDIDOS_2026-10-15.md](RECUPERACAO_EVENTOS_PERDIDOS_2026-10-15.md) | evidência | 15/10/2026 | Vigente | Dry-run da recuperação dos eventos perdidos pelo CON-04. Correções de dados pendentes (F3-08). |
| [CONTRATO_RASTREAMENTO_CLIQUE_WEBHOOK.md](CONTRATO_RASTREAMENTO_CLIQUE_WEBHOOK.md) | contrato | 15/10/2026 (v2.0) | Vigente | Contrato de clique e atribuição com as casas; v2.0 substitui a v1.0 de 09/10. |
| [ESCOPO_ESCALA_TRACKING_ATRIBUICAO_2026-10-14.md](ESCOPO_ESCALA_TRACKING_ATRIBUICAO_2026-10-14.md) | escopo | 14/10/2026 | Vigente | Escala de envio, tracking e atribuição (OBS, CON, WHK, TRK, REP). Itens abertos em F5-13. |
| [AUDITORIA_TRACKING_ATRIBUICAO_ESCALA_2026-10-14.md](AUDITORIA_TRACKING_ATRIBUICAO_ESCALA_2026-10-14.md) | auditoria | 14/10/2026 | Vigente | Diagnóstico de tracking, atribuição e escala que originou o escopo de escala. |
| [BASELINE_BANCO_2026-10-14.md](BASELINE_BANCO_2026-10-14.md) | evidência | 14/10/2026 | Vigente | Baseline do banco após o upgrade Small → Large. Medições P1–P5 pendentes (F2-13). |
| [ESCOPO_FILA_ASSINCRONA_JORNADAS_2026-10-14.md](ESCOPO_FILA_ASSINCRONA_JORNADAS_2026-10-14.md) | escopo | 14/10/2026 | Vigente | Fila assíncrona e processamento confiável de jornadas. DLQ e teste de carga pendentes. |
| [RUNBOOK_OBSERVABILIDADE.md](RUNBOOK_OBSERVABILIDADE.md) | runbook | 14/10/2026 | Vigente | Uptime, heartbeats, métricas de fila e logs do VPS. Configuração real pendente (F2-08). |
| [STATUS_P0_2026-10-14.md](STATUS_P0_2026-10-14.md) | status | 14/10/2026 | Obsoleto | Status da Fase 0 de 14/10. Pendência de deploy contradiz documentos posteriores (§7.3 item 11). |
| [OPERACAO_SEGURA.md](OPERACAO_SEGURA.md) | runbook | 14/10/2026 | Vigente | Regras de webhooks, retenção/LGPD e operação segura. Conflito sobre painel por tenant (§7.3 item 12). |
| [docker-deployment.md](docker-deployment.md) | runbook | 15/10/2026 | Vigente | Build Docker, variáveis, ativação do dispatcher de jornadas e nginx. Contém e-mail pessoal a remover (PM-BL-33). |
| [MATRIZ_ACEITE_CANAIS.md](MATRIZ_ACEITE_CANAIS.md) | evidência | 13/10/2026 | Vigente | Modelo da matriz de aceite por tenant e canal. 0/21 cenários preenchidos (F3-06). |
| [FLUXO_CRM.md](FLUXO_CRM.md) | escopo (negócio) | 13/10/2026 | Superado em parte por ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15 | Régua de mensagens do cliente (onboarding, inatividade, níveis VIP, cashback). Conversão do `.docx`. |
| [FLUXO CRM.docx](FLUXO%20CRM.docx) | escopo (negócio) | 13/10/2026 | Original de FLUXO_CRM.md | Arquivo original enviado pelo cliente. |
| [ESCOPO_RESOLUCAO_LEVANTAMENTO_2026-10-10.md](ESCOPO_RESOLUCAO_LEVANTAMENTO_2026-10-10.md) | escopo | 10/10/2026 | Superado por ESCOPO_CORRECOES_AUDITORIA_2026-10-16 (como fonte de status) | Resolução do levantamento de 09/10 (P0–P3). Conteúdo segue como referência. |
| [LEVANTAMENTO_DOCUMENTACAO_SISTEMA_2026-10-09.md](LEVANTAMENTO_DOCUMENTACAO_SISTEMA_2026-10-09.md) | auditoria | 09/10/2026 | Encerrado | Levantamento da documentação e da aderência ao código; desdobrado no ESCOPO_RESOLUCAO. |
| [ESCOPO_FUNIL_CONVERSAO_CAMPANHAS_JORNADAS_2026-10-08.md](ESCOPO_FUNIL_CONVERSAO_CAMPANHAS_JORNADAS_2026-10-08.md) | escopo | 08/10/2026 | Vigente | Funil de conversão por campanha e jornada (atribuição por clique). Complementado pela Central. |
| [CONVERSION_FUNNEL_OPERATIONS.md](CONVERSION_FUNNEL_OPERATIONS.md) | runbook | 08/10/2026 | Obsoleto | Operação e rollback do funil. Desatualizado: atribuição assistida e A/B foram removidos pela Central (§7.3 item 6). |
| [ESCOPO_JORNADAS_CRUZADAS_E_PROGRESSAO_NIVEIS.md](ESCOPO_JORNADAS_CRUZADAS_E_PROGRESSAO_NIVEIS.md) | escopo | 08/10/2026 | Superado em parte por ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15 | Jornadas de nível × comportamento. Prioridades substituídas pela decisão D-3 (§7.3 item 4). |
| [ESCOPO_AUDITORIA_JORNADAS_2026-10-07.md](ESCOPO_AUDITORIA_JORNADAS_2026-10-07.md) | auditoria | 07/10/2026 | Superado por ESCOPO_AUDITORIA_GATILHOS_JORNADAS_2026-10-15 | Primeira auditoria de jornadas e automações. Itens P3/P4 ainda abertos (PM-BL-22). |
| [ESCOPO_EVOLUCAO_UX_CANAIS_2026-10-07.md](ESCOPO_EVOLUCAO_UX_CANAIS_2026-10-07.md) | escopo | 07/10/2026 | Encerrado | Evolução de UX e operação dos canais SMS, e-mail e voz. Evidência no documento abaixo. |
| [EVIDENCIA_EVOLUCAO_UX_CANAIS_2026-10-07.md](EVIDENCIA_EVOLUCAO_UX_CANAIS_2026-10-07.md) | evidência | 07/10/2026 | Encerrado | Registro das entregas do escopo de evolução de UX dos canais. |
| [ESCOPO_UX_COMPOSER_E_ENVIO_INDIVIDUAL_2026-10-07.md](ESCOPO_UX_COMPOSER_E_ENVIO_INDIVIDUAL_2026-10-07.md) | escopo | 07/10/2026 | Vigente (sem registro de aceite) | Composer de campanhas e envio individual. |
| [TESTE_USABILIDADE_CANAIS_2026-10-07.md](TESTE_USABILIDADE_CANAIS_2026-10-07.md) | plano | 07/10/2026 | Vigente | Roteiro do teste com 3 operadores. Não executado (F3-10). |
| [ESCOPO_REAUDITORIA_CANAIS_2026-10-06.md](ESCOPO_REAUDITORIA_CANAIS_2026-10-06.md) | escopo | 06/10/2026 | Vigente | Reauditoria dos canais. Fechamento técnico em 07/10; aceite operacional pendente (F3-06). |
| [ESCOPO_REMOCAO_BUSINESSCODE_INFOBIP_2026-10-06.md](ESCOPO_REMOCAO_BUSINESSCODE_INFOBIP_2026-10-06.md) | escopo | 06/10/2026 | Encerrado | Remoção da BusinessCode e padronização Infobip. Resíduos em PM-BL-33. |
| [PLANO_DE_ENTREGAS.md](PLANO_DE_ENTREGAS.md) | plano | 06/10/2026 | Superado por ESCOPO_CORRECOES_AUDITORIA_2026-10-16 | Checklist operacional antigo do projeto. |
| [ESCOPO_SHORTIO.md](ESCOPO_SHORTIO.md) | escopo | 06/10/2026 | Encerrado | Escopo original da integração Short.io. |
| [PLANO_FECHAMENTO_SHORTIO.md](PLANO_FECHAMENTO_SHORTIO.md) | plano | 06/10/2026 | Encerrado | Fechamento do piloto Short.io (aceite em 06/10); melhorias futuras fora do escopo. |
| [REAUDITORIA_SISTEMA_2026-10-03.md](REAUDITORIA_SISTEMA_2026-10-03.md) | auditoria | 03/10/2026 | Superado por AUDITORIA_COMPLETA_SISTEMA_2026-10-16 | Reauditoria de 03/10, antigo ponto de continuidade do projeto. |

Referências "§7.x" apontam para a AUDITORIA_COMPLETA_SISTEMA_2026-10-16.md. Os IDs F0-xx a F5-xx apontam para o ESCOPO_CORRECOES_AUDITORIA_2026-10-16.md.

## Lacunas conhecidas

Ainda não existem (F3-03): arquitetura, catálogo de ambientes, ADRs, dicionário de dados, matriz RBAC formal, runbook de deploy e rollback, política LGPD e de retenção, backup/PITR com RPO/RTO, on-call. O registro de operações em produção previsto nas regras de execução ficará em `docs/operacoes/AAAA-MM-DD_<tema>.md`.

## Próximo passo: estrutura de pastas (F3-02)

Os arquivos continuam na raiz de `docs/` para não quebrar links. A reorganização proposta é:

| Pasta | Conteúdo | Candidatos atuais |
|---|---|---|
| `00-canonico/` | Arquitetura, ambientes, RBAC, dicionário de dados, regras de negócio, LGPD | (a criar no F3-03); FLUXO_CRM reconciliado |
| `adr/` | Decisões registradas, uma por arquivo | (a criar no F3-04) |
| `escopos/` | Escopos vigentes | ESCOPO_CORRECOES, ESCOPO_CENTRAL, ESCOPO_ESCALA, ESCOPO_FILA_ASSINCRONA, ESCOPO_FUNIL, ESCOPO_REAUDITORIA_CANAIS, ESCOPO_UX_COMPOSER, CONTRATO_RASTREAMENTO |
| `auditorias/` | Auditorias e levantamentos | AUDITORIA_COMPLETA, ESCOPO_AUDITORIA_GATILHOS, AUDITORIA_TRACKING |
| `runbooks/` | Procedimentos de operação | docker-deployment, OPERACAO_SEGURA, RUNBOOK_OBSERVABILIDADE |
| `evidencias/` | Revisões, baselines, matrizes e dry-runs | CON-08, SEC-01, BASELINE_BANCO, RECUPERACAO_EVENTOS, MATRIZ_ACEITE_CANAIS, TESTE_USABILIDADE |
| `operacoes/` | Registro de cada escrita em produção | (novo) |
| `_arquivo/` | Superados, encerrados e obsoletos | PLANO_DE_ENTREGAS, REAUDITORIA_SISTEMA, STATUS_P0, CONVERSION_FUNNEL_OPERATIONS, ESCOPO_SHORTIO, PLANO_FECHAMENTO_SHORTIO, ESCOPO_AUDITORIA_JORNADAS, ESCOPO_EVOLUCAO_UX_CANAIS, EVIDENCIA_EVOLUCAO_UX_CANAIS, ESCOPO_REMOCAO_BUSINESSCODE, LEVANTAMENTO, ESCOPO_RESOLUCAO, ESCOPO_JORNADAS_CRUZADAS, FLUXO CRM.docx |

Ao mover, atualizar os links relativos entre documentos (vários se referenciam por caminho `docs/...`) e este índice no mesmo PR.
