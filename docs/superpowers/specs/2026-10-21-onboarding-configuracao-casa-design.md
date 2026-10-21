# Onboarding e configuração da casa (tenant) — design

Data: 2026-10-21 · Status: rascunho para aprovação

## Por quê

Hoje toda casa nova depende do superadmin configurar tudo à mão: domínio do encurtador
(`shortio_settings.domain`, digitado em `/links/configuracoes`), remetente de e-mail
(`email_senders`, só superadmin, tela `RemetentesTab` em `src/routes/email.tsx` nem é renderizada)
e não existe lugar para a URL da casa. Nada conversa com a Short.io nem com a Infobip para
cadastrar domínio ou obter DNS. Isso trava a entrada de casas e concentra trabalho no superadmin.

A ideia: o próprio admin da casa configura tudo, e o sistema cadastra os domínios
automaticamente nas contas centrais da Betleads (Short.io e Infobip) e devolve os registros DNS.

## Objetivos

1. No primeiro acesso do admin (depois da troca de senha obrigatória), um assistente guia a configuração da casa.
2. Uma área permanente de configuração para editar e adicionar tudo depois.
3. Integração automática com Short.io (domínios de encurtador) e Infobip (domínios de e-mail): cadastrar o domínio, mostrar os registros DNS, verificar o status sozinho.
4. Domínios de encurtador, URLs rápidas e remetentes viram itens selecionáveis na criação/edição de campanhas e jornadas.

## Não-objetivos

- Credenciais próprias da casa na Short.io/Infobip. **Decidido:** sempre as contas centrais da Betleads (chaves globais em env, como hoje).
- Limite de domínios por plano. **Decidido:** sem limite por enquanto; a estrutura deve permitir limitar por plano depois (pode virar cobrança).
- Link público de instruções de DNS e "copiar instruções" como recurso separado (descartados pelo usuário; o botão de copiar de cada registro continua).
- Remetente/sender de SMS por casa.
- Gerenciar o DNS da casa por ela (sem integração com registradores/Cloudflare).

## Anti-objetivos (seria falha mesmo funcionando)

- Bloquear o uso do sistema enquanto o DNS não propaga.
- E-mail saindo com domínio não verificado (ou por um domínio "emprestado" da Betleads).
- Uma casa enxergar ou usar domínio, remetente ou URL de outra casa.
- Quebrar o envio das casas que já operam (ex.: Sorte Alta com `bmkt.click`).

## O que a casa cadastra

| Item | Detalhe |
|---|---|
| **URL da casa** | Ex.: `https://suacasa.bet.br`. Destino padrão dos links em campanhas e jornadas. |
| **URLs rápidas** | Atalhos nomeados sobre a URL da casa: Login → `/login`, Depósito → `/deposito`, Promo → `/promo`, livres para adicionar/editar/remover. |
| **Domínios de encurtador** | Um ou vários. Um é o padrão; os demais são reserva (bloqueio por operadora) ou para envios específicos. Cada um é cadastrado na conta central da Short.io. |
| **Domínios de e-mail** | Um ou vários, cadastrados na conta central da Infobip (SPF, DKIM, etc.). Um é o padrão. |
| **Remetentes de e-mail** | Nome + endereço (ex.: `Promo SuaCasa <promo@suacasa.bet.br>`), sempre sob um domínio de e-mail da casa. Um é o padrão. |

## Fluxo de primeiro acesso — decidido: assistente + checklist (A+B)

1. Admin troca a senha (fluxo atual `force_password_change`).
2. Abre o **assistente** em tela cheia com passos: **Casa** (URL + URLs rápidas) → **Encurtador** → **E-mail** (domínio + remetente) → **Pronto**. Cada passo tem "Fazer depois".
3. Se pular ou sair no meio, o **Início** mostra um card **"Configure sua casa"** com progresso e o status de cada item (feito / aguardando DNS / pendente), que leva à página de configuração. O card some quando tudo está concluído e verificado.
4. **Casas que já operam** (decidido): não veem o assistente. A configuração existente entra já como está (ex.: `bmkt.click` como encurtador verificado da Sorte Alta) e elas têm o menu de configuração normal. *Minha decisão:* o checklist também aparece para elas mostrando só o que falta (ex.: URL da casa, domínio de e-mail).

## Tela de um domínio

Mockup aprovado na conversa: nome do domínio, selo de status, tabela de registros DNS
(tipo / nome / valor / status por registro, botão copiar em cada um), "Verificar agora",
última verificação, "Definir como padrão", "Remover".

- Os registros vêm **da API** do provedor; nada é escrito à mão no código.
- **Decidido:** botão **"Enviar instruções por e-mail"** — o admin informa o e-mail de quem cuida do DNS e o sistema manda os registros para ele.
  **Remetente decidido:** `no-reply@betleads.io`, um remetente da plataforma (não da casa), via Infobip. Pré-requisito: `betleads.io` verificado na conta central da Infobip; o endereço fica em env (ex.: `PLATFORM_EMAIL_FROM`). Esse remetente só serve para mensagens do sistema, nunca para campanhas.
- **Remover** (*minha decisão*): desvincula o domínio da casa e o tira dos novos envios, mas **não apaga no provedor**, para links já enviados e o histórico continuarem funcionando. Apagar de fato no provedor é ação só do superadmin.
- Status: `pendente` (aguardando DNS) → `verificado`; também `falhou`/`erro` quando o provedor rejeita.
- *Minha decisão:* verificação automática periódica (ex.: a cada 10 min nas primeiras horas, depois espaçando) + botão manual. Ao verificar, aviso no sistema ao admin.

## Comportamento enquanto não verifica — decidido

- **Admin usa todo o sistema** normalmente; nada é bloqueado além do e-mail.
- **Links (SMS, etc.):** saem pelo **encurtador padrão do CRM** (o fallback atual de `SHORTIO_DOMAIN`), com aviso visível de que o domínio personalizado ainda não propagou. Quando o domínio da casa verifica, passa a ser usado automaticamente (vira padrão se não houver outro).
- **E-mail:** **bloqueado** para a casa até existir pelo menos um domínio de e-mail verificado com remetente. Sem domínio "emprestado".
  **Confirmado:** nenhuma casa envia e-mail hoje, então a regra entra sem migração de remetentes nem risco de cortar envio em produção. O caminho legado `email_smtp_configs` em `resolveSender` deve deixar de servir como fonte de remetente para casas (o envio passa a exigir remetente de domínio verificado).

## Campanhas e jornadas — decidido

Na criação e edição de campanhas e jornadas (SMS e e-mail, onde houver link/remetente):

- seletor de **domínio do encurtador** (padrão pré-selecionado; só verificados aparecem — se nenhum, o padrão do CRM com o aviso);
- inserção de **URLs rápidas** e da URL da casa como destino padrão do link;
- seletor de **remetente de e-mail** (só de domínios verificados).

*Minha decisão:* se um domínio/remetente usado por campanha agendada ou jornada ativa for removido ou deixar de verificar, o envio cai para o padrão da casa (encurtador) ou é bloqueado com alerta (e-mail), e a remoção avisa onde está em uso.

## Permissões

- *Minha decisão:* editam a configuração os papéis de admin da casa (`owner`, `admin`, via `requireTenantAdmin`); `gestor`/`member` só visualizam. Superadmin vê e edita a configuração de qualquer casa.
- Tenant demo: segue o bloqueio atual de escrita (`assertTenantNotDemo`).

## Integrações (a confirmar na documentação do provedor pelo builder)

- **Short.io:** API de domínios da conta (adicionar hostname, consultar estado/registros, remover). Guardar o `domain_id` (coluna já existe em `shortio_settings`, nunca usada). Chave global `SHORTIO_API_KEY`.
- **Infobip:** API de domínios de e-mail (criar domínio, obter `dnsRecords`, disparar verificação, consultar status). Chave global `INFOBIP_API_KEY`. O envio continua por `sendInfobipEmail` / `resolveSender`, passando a exigir remetente de domínio verificado.
- Tratar erros do provedor de forma legível para o admin (domínio já em uso em outra conta, hostname inválido, etc.).
- Um domínio só pode pertencer a uma casa.
- **Confirmado:** as contas centrais não têm limite de domínios (Short.io e Infobip ilimitados), então o cadastro é imediato, sem fila nem aprovação do superadmin.

## O que já existe e deve ser aproveitado

- `shortio_settings` (por tenant, 1 domínio) e `/links/configuracoes` — hoje 1 domínio digitado à mão; o modelo de vários domínios substitui esse campo (com migração de dados).
- `email_senders` (tem `tenant_id`, `domain`, `is_default`) e `RemetentesTab` (não renderizada).
- `tenants.metadata` jsonb existe mas não é usado.
- `/configuracoes` é quase toda placeholder — local natural para a área permanente (ou uma rota própria; decisão do builder, coerente com o shell do redesign).
- Primeiro acesso: `AuthGate` + `InitialPasswordScreen` (`src/components/auth-gate.tsx`).

## Deixado para o builder

- Modelo de dados (tabelas de domínios com tipo encurtador/e-mail, URLs rápidas, marcação de onboarding concluído/pulado) e migração das configurações existentes.
- Onde exatamente fica a área permanente no menu e o desenho final das telas (seguindo o shell atual, dark only).
- Mecanismo da verificação periódica (cron/edge function/job existente).
- Formato e envio do e-mail de instruções de DNS (pode usar o próprio envio Infobip da plataforma).
- Estrutura para limite futuro por plano (ex.: em `tenants.limits`), sem aplicar limite agora.
