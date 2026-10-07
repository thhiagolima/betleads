# Evidência de execução — evolução de UX dos canais

**Data:** 07/10/2026
**Escopo:** `ESCOPO_EVOLUCAO_UX_CANAIS_2026-10-07.md`

## Entregas na ordem aprovada

### P0 — governança de provedores

- SMTP, remetentes globais, callbacks, rotas e credenciais exigem `super_admin` no servidor.
- RLS de `email_smtp_configs` e `email_senders` foi restringida a superadmin.
- SMS, e-mail e voz mostram apenas disponibilidade/capacidade operacional ao tenant.
- Histórico, banners e erros entregues ao tenant não retornam marca, endpoint, callback, credencial, ID ou resposta crua de fornecedor.
- Super Admin recebeu a central **Provedores de canais** para SMS, e-mail e voz.

### P1 — rascunho e autosalvamento

- Criado contrato unificado `campaign_drafts`, isolado por tenant.
- Autosave com debounce, chave idempotente, versão otimista e estados visíveis: salvando, salvo e falha.
- Rascunhos aparecem separados no hub de campanhas, com continuar edição e excluir.
- Apenas registros em `draft` podem ser alterados ou excluídos; a submissão torna o snapshot imutável.
- Fechamento durante gravação pendente exige confirmação.

### P2 — entrada única e ativos

- O hub usa uma única ação **Criar** para campanha, envio individual/teste e automação.
- Envio individual/teste permite escolher SMS, e-mail ou voz e informa que não é campanha.
- Templates de SMS/e-mail e script de voz podem ser criados dentro do composer; o ativo novo é selecionado sem perder os demais campos.
- Rastreamento permanece salvo no rascunho e o snapshot do ativo é preservado na submissão.

### P3 — audiência por canal

- Novo contrato `resolveCampaignAudience` exige canal explícito.
- SMS e voz usam telefone BR normalizado em E.164; e-mail usa endereço sintaticamente válido.
- Consentimento e supressão entram no mesmo total mostrado no composer.
- A interface mostra total do público, elegíveis por identificador do canal e excluídos.
- As rotinas de envio continuam revalidando consentimento/política de contato no despacho.

### P4 — arquitetura de informação

- Alternador de canal e menu secundário foram removidos das páginas de SMS, e-mail, voz e biblioteca SMS.
- Sidebar passou a ser a fonte das rotas de canais e bibliotecas.
- Hashes legados de configuração de e-mail redirecionam para a visão segura; configuração legada de SMS resolve para saúde.

## Validações executadas

- `npm test -- --run`: **23 testes aprovados em 8 arquivos**.
- Lint direcionado aos arquivos novos e aos componentes centrais alterados: **aprovado**.
- `npm run build`: **build cliente e SSR aprovado**.
- `git diff --check`: **aprovado**.
- Migration `20261007120000_channel_provider_governance_and_campaign_drafts.sql`: **aplicada e confirmada no projeto Supabase vinculado**.
- Servidor local reiniciado; `GET /campanhas`: **HTTP 200**.

## Limitações da validação

- Nenhum fornecedor real foi chamado.
- Não foi realizado teste moderado com operadores; esse aceite depende de participantes e evidências humanas.
- O lint global já contém pendências anteriores fora deste escopo; por isso a evidência usa lint direcionado e build completo.
