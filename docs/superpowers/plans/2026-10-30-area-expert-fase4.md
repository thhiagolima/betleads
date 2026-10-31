# Área do Expert — Fase 4 (campanhas do expert): registro de entrega

> Diferente das fases 1 a 3, este documento foi escrito **depois** da entrega. Ele registra o que foi feito, as decisões tomadas com o dono do produto em 30/10/2026 e o que ficou de fora. Não é um roteiro a executar.

**Goal:** o expert envia campanhas de SMS, e-mail e voz para os leads que ele pode ver, cria os próprios públicos, respeita o teto mensal em R$ definido pela casa e, se o admin quiser, passa por aprovação antes de cada disparo.

**Spec:** `docs/superpowers/specs/2026-10-23-area-expert-design.md` §8 e §10 item 4, com o adendo de 30/10/2026 no fim da §8.

**Entregue em:** main `5d028af` (30/10/2026). Migrations `20261125100000_expert_hardening.sql` e `20261126100000_expert_campaigns.sql` aplicadas em produção antes do push.

## Decisões tomadas nesta fase

| Tema | Decisão |
|---|---|
| Canais | SMS, e-mail **e voz**. A spec deixava voz para depois. |
| Fluxos | **Fora.** `sms_flows`, `email_flows`, aprovação na ativação, "parar fluxo no teto" e a ação 6 da ficha ("colocar num fluxo dele") não entram. |
| Telas | O expert usa as **mesmas** `/publicos` e `/campanhas` da casa, adaptadas ao papel. Não há editores próprios. |
| Modo de envio | Por expert, como já estava no cadastro (`envio_modo` livre ou aprovação). Não há padrão da casa. Trocar de "com aprovação" para "livre" não libera as pendentes. |
| Teto | `teto_mensal` em R$ por mês, somando os três canais, pelo preço de venda cobrado da casa (vale também dentro da franquia e para casa isenta). Vazio = sem teto; 0 = bloqueia. Mês em `America/Sao_Paulo` via `billing_now()`. |
| Público | O restrito alcança só os leads dos IDs de afiliado dele. O total alcança qualquer lead da casa. O expert cria públicos próprios. O total também usa os públicos salvos da casa, só leitura. |
| Conteúdo | Texto e HTML livres (HTML sanitizado por allowlist), mas todo link precisa ser do site da casa ou de um domínio liberado pelo admin (`allowed_destination_hosts`). Sem lista configurada, link externo é recusado. Links encurtados são recusados. Remetente e domínio curto são sempre o padrão da casa. |
| Destinatários | Sempre resolvidos no servidor a partir de um público ou critério. O expert não manda telefone, e-mail avulso, lista externa nem envio de teste para endereço livre. |

## O que foi construído

### 4a — segurança e bugs da casa (`20261125100000_expert_hardening.sql`)

Pré-requisito auditado em 30/10 (UX, dev sênior, QA, gestão e red team).

- O expert não lê mais `players`, `deposits` e `withdrawals` pelo PostgREST. As policies de expert e os helpers `current_expert_tenant_id`, `current_expert_tipo` e `current_expert_affiliate_ids` foram removidos. Lista de leads e home do expert leem com `supabaseAdmin`, filtro de casa e afiliado e colunas explícitas.
- `link_dispatches` e `tracked_links` viraram só leitura para `authenticated`.
- Regra de crédito versão 2: quando o lead tem afiliado de um expert elegível, só os cliques desse expert contam. Um clique não toma mais o depósito do afiliado de outro expert. Recálculos seguem limitados aos últimos 8 dias, então créditos antigos ficam na versão 1.
- Voz: cada item da fila é reservado (`audio_ready` → `calling`) antes de discar, e a cobrança é única por item (`voice:<queue_id>`).
- E-mail: "Enviar agora" reserva a campanha antes de enviar; pausar ou cancelar interrompe a execução; o final não sobrescreve pausa.
- SMS: público por seleção carrega o jogador escolhido, sem resolver de novo pelo telefone.
- HTML de e-mail sanitizado com `sanitize-html` (allowlist). Comentários HTML, inclusive os condicionais do Outlook, são removidos.
- `assertDestinationAllowed({ tenantId, url, strict })` em `shortio.server.ts`; `strict: true` falha fechado.

### 4b — campanhas do expert (`20261126100000_expert_campaigns.sql`)

- `expert_id` em `sms_audiences`, `sms_campaigns`, `email_campaigns` e `campaign_drafts`. Nova tabela `expert_voice_campaigns`; `call_queue` ganha `expert_id` e `expert_voice_campaign_id`. Um trigger impede o papel da casa de escrever linhas de expert pelo REST.
- Aprovação: `approval_status` (`pendente` | `aprovada` | `recusada`), `approved_by`, `approved_at`, `rejection_reason`. Pendente fica em `status = 'aguardando_aprovacao'`, que nenhum worker pega. Editar devolve para pendente.
- Teto: `expert_monthly_usage`, `expert_usage_entries` e `expert_cap_alerts`. `expert_wallet_reserve` checa e soma o teto na mesma transação do `wallet_reserve`. Estorno e settle devolvem ao mês da reserva. Replays idempotentes não contam duas vezes.
- `resolve_sms_audience_v2` reescrita por inteiro, com filtro opcional `affiliateIds` aplicado só quando o servidor o envia.
- Workers de SMS, e-mail e voz reaplicam o escopo e checam se o expert está ativo a cada execução. No teto, só a campanha do expert pausa (`expert_cap`), sem o alerta de "sem saldo" da casa. O admin recebe um e-mail por expert por mês.
- Links das campanhas do expert usam `source_type = 'expert'` e `source_id = expertId`.
- Server functions em `src/lib/expert-campaigns.functions.ts` (expert) e `src/lib/expert-campaigns-admin.functions.ts` (admin: detalhe, uso por expert), além de aprovar, recusar, pausar e retomar.
- E-mail sem limite de destinatários, para a casa e para o expert: lotes de até 150 destinatários ou 20 s por execução; o worker continua no minuto seguinte, sem reenviar nem cobrar duas vezes.

### Telas

- Expert: seção "Envios" (Campanhas e Públicos); no celular, uma aba "Envios". Adapter `src/lib/campaign-data-source.ts` + `src/hooks/use-campaign-data-source.ts`. Card "Uso do mês" em `/campanhas` e "Meu consumo" na home. Composer com custo nos três canais, restante do teto e "Enviar para aprovação".
- Admin: abas "Rendimento | Campanhas" em `/rendimento/equipe/$expertId` (`?aba=campanhas`), com revisão de conteúdo, aprovar, recusar com motivo, pausar e retomar. Na lista de Experts: colunas Envio, Teto e Uso do mês, e o card "Aprovações pendentes". Formulário com textos explicativos e R$ em pt-BR.
- Status novos, também para a casa: Aguardando aprovação, Recusada, Pausada pelo teto, Enviando em lotes.

## Ordem de deploy usada

1. Merge de `origin/main` na branch e verificação completa: typecheck, lint (0 erros), 4237 testes, build.
2. `supabase migration up` em produção, com arquivos vazios para `20261026200000` e `20261026200100` (versões só do remoto).
3. Push para a main.

A `20261125` remove o acesso direto que o código antigo usava. Entre a migration e o fim do deploy, a lista de leads e a home do expert podem aparecer vazias. Foi aceito porque o inverso (código antes da `20261126`) quebraria os envios.

## Fora desta entrega

- Fluxos do expert e a ação 6 da ficha.
- Página de relatório de cada campanha do expert (`/campanhas/$id/relatorio` segue só da casa).
- Editar uma campanha já criada a partir do hub.
- Ignorar cliques do próprio expert por IP ou user-agent: não há dados de sessão do expert para comparar.
- Notificação do teto dentro do sistema (hoje só e-mail). O link do e-mail abre na casa ativa do admin.

## Riscos conhecidos

- Para o expert restrito sem leads, a tela não distingue "sem IDs de afiliado" de "IDs sem leads ainda".
- Lead com espaços em volta do `affiliate_id` salvo não aparece na lista do expert restrito (a ficha ainda casa com `btrim`).
- Telefone compartilhado entre um lead do escopo e outro fora dele pode fazer o lead do escopo ser pulado num público por regra.
- Entre lotes, uma campanha de e-mail grande aparece como `agendada`; a interface mostra "Enviando em lotes".
- Nenhuma tela foi testada em navegador antes do deploy. Roteiro de teste manual: público como expert restrito → SMS em modo aprovação → aprovação pelo admin → teto baixo recusando ou pausando.
