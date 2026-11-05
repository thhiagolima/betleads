# Conta padrão escolhível, CRUD de contas e canais ativos por casa — design

Data: 2026-11-05. Base: origin/main 26ea8c0. Escopo anterior:
docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md.

## Por quê

Hoje a conta padrão de cada canal é fixa no código: as três contas "(padrão)"
(Short Brasil, Infobip, OneSignal) leem as credenciais do ambiente, têm ids
fixos (`DEFAULT_*_ACCOUNT_ID` em src/lib/provider-accounts.server.ts) e não
podem ser editadas nem removidas. O super admin criou a conta OneSignal
"Betleads" com credencial e quer que ela seja a padrão de web push para todas
as casas — hoje isso exigiria ligar casa por casa, e a "OneSignal (padrão)"
está sem credencial (incompleta).

Junto disso, o super admin quer decidir quais canais cada casa tem. Ponto de
partida: SMS, e-mail e voz ligados para todas; web push desligado para todas.

## Objetivos

1. **Conta padrão por canal escolhível** na tela Contas de provedor
   (src/components/admin/provider-accounts-panel.tsx). Casa sem conta própria
   no canal usa a padrão escolhida.
2. **CRUD completo de contas**: criar, editar, desativar/reativar e excluir.
3. **Canais ativos por casa**: liga/desliga por canal (sms, email, voice,
   webpush), definido pelo super admin.
4. **Canal desligado some do painel da casa** e o pessoal da casa vê um aviso
   grande com botão "Ciente".

## Não objetivos

- Fallback entre contas (continua valendo: conta da casa indisponível não cai
  na padrão; o envio falha como `misconfigured`).
- Mover apps OneSignal já criados entre contas (ver comentário em
  src/lib/webpush/apps.server.ts, activateWebpushOrigin).
- A casa ligar/desligar canais sozinha. Só o super admin.

## Anti-objetivos (seria falha mesmo funcionando)

- Trocar a padrão e alguma casa parar de enviar sem o super admin ver o
  aviso antes.
- Canal desligado ainda aparecer em algum canto do painel da casa, ou ainda
  cobrar/enviar.
- Excluir uma conta e quebrar o histórico de envios ou o financeiro (custo
  por conta).

## Decisões do usuário

- A padrão é escolhida por canal, na tela Contas de provedor.
- Contas viram CRUD completo.
- Canais por casa: estado inicial SMS, e-mail, voz ligados; web push
  desligado — para todas as casas existentes.
- Canal desligado **some totalmente do painel da casa**.
- Ao desligar, o **pessoal da casa** vê um aviso grande com botão "Ciente".
- Jornadas em andamento: o passo do canal desligado **é pulado**, o player
  segue para o próximo passo, nada é enviado nem cobrado. Ao religar, os
  passos voltam a enviar dali em diante; o que foi pulado não é reenviado.

## Design

### 1. Conta padrão por canal

- Nova tabela `platform_channel_defaults (channel PK, provider_account_id
  FK provider_accounts, updated_by, updated_at)`, com o mesmo trigger de
  `tenant_channel_providers_check_channel` (a conta precisa atender o canal).
  Semeada com as contas de hoje: sms→a001, email→a002, voice→a002,
  webpush→a003. Só service_role (padrão das tabelas atuais).
- O resolver (`defaultAccountFor`, `resolveChannelAccount`,
  `resolveOneSignalAccount`, `oneSignalAccountById` etc.) passa a ler a
  padrão do snapshot em vez do id fixo. Snapshot inclui a nova tabela; mesma
  regra de cache (30 s, `invalidateProviderAccountsCache`) e mesma regra de
  erro de leitura (último snapshot; sem nenhum, as contas env de hoje).
- `PLATFORM_ACCOUNT_IDS` (usado em `adminSetTenantChannelProviderFor` para
  tratar "padrão" como "sem linha") deixa de significar "padrão": passa a
  significar só "conta com credentials_source='env'". Escolher "usar a
  padrão" na casa continua sendo apagar a linha de `tenant_channel_providers`.
- Na tela: coluna/selo "padrão de SMS", "padrão de web push" etc. em cada
  conta; ação "Tornar padrão de <canal>" (só canais que a conta atende e só
  se ativa). Antes de confirmar, o diálogo mostra quantas casas passam a usar
  a conta nova (as sem conta própria no canal **e com o canal ligado**).
- O rótulo fixo "(padrão)" sai do nome das contas env. Elas viram "Short
  Brasil (ambiente)" etc. — *chamada minha*; o selo de padrão é o que indica
  a padrão.
- **E-mail**: domínios de e-mail vivem numa conta Infobip.
  `adminSetTenantChannelProviderFor` já move os domínios da casa ao trocar a
  conta. Trocar a padrão de e-mail precisa fazer o mesmo para todas as casas
  sem conta própria (domínios voltam a pendente). **Troca direta com aviso**
  (decidido com o usuário; troca em etapas descartada por ser rara e cara de
  construir): o diálogo lista quantas casas têm domínio de e-mail verificado
  e avisa que elas ficam sem enviar e-mail até revalidar o DNS na conta
  nova; o super admin confirma digitando ou clicando num segundo botão.
  Depois da troca, a tela mostra o resultado por domínio (como
  `SetTenantChannelProviderResult.emailDomains` já faz para uma casa).
- **E-mails da plataforma** (faturas, alertas de cobrança, convites — envio
  sem casa): continuam na conta Infobip do ambiente, não seguem a padrão
  escolhida (*chamada minha*). O resolver separa "padrão das casas" de
  "conta da plataforma" e o diálogo de troca diz isso.
- **Web push**: trocar a padrão não move apps já criados (mesma regra de
  hoje); só as próximas ativações usam a conta nova.

### 2. CRUD de contas

- Criar/editar: já existem (`adminSaveProviderAccountFor`). Contas env: só o
  nome e os canais são editáveis; credenciais continuam vindo do ambiente
  (*chamada minha* — não faz sentido gravar cifrado algo que está no env).
- Desativar: bloqueado se a conta for padrão de algum canal (troque a padrão
  antes). Se casas usam a conta como própria, o diálogo lista quantas e avisa
  que elas param de enviar naquele canal (regra sem fallback já existente).
- Excluir: só se a conta não é padrão de nenhum canal e nenhuma casa a usa
  (`tenant_channel_providers`) e nenhum app OneSignal (`tenant_webpush_apps.
  provider_account_id`) aponta para ela. Contas env não podem ser excluídas.
  Os logs de envio guardam `provider_account_id` sem FK, então o histórico
  continua; telas que mostram o nome da conta mostram "conta excluída"
  (*chamada minha*). Verificar o financeiro: custo do provedor é por conta?
  Se for, excluir não pode apagar o custo dos envios antigos — se houver FK
  ou join obrigatório, trocar por exclusão lógica (`status='deleted'`, some
  das listas).
- Auditoria: toda ação grava em `auditAdminAction`, como hoje.

### 3. Canais ativos por casa

- Nova tabela `tenant_channels (tenant_id, channel, enabled bool, updated_by,
  updated_at, PK (tenant_id, channel))` — *chamada minha* sobre a forma;
  semeada para todas as casas existentes com sms/email/voice=true,
  webpush=false. Casa nova nasce com o mesmo padrão (sem linha =
  sms/email/voice ligados, webpush desligado — o código trata a ausência
  assim, então não depende de semear casa nova).
- Onde o super admin liga/desliga: na configuração da casa, junto da escolha
  de conta por canal (mesmo bloco que chama `adminSetTenantChannelProvider`)
  — *chamada minha*. Desligar pede confirmação mostrando quantas jornadas
  ativas e campanhas agendadas da casa usam o canal.
- Leitura pela casa: a RLS precisa deixar o usuário da casa ler os próprios
  canais (o painel precisa saber o que esconder). Escrita só service_role.

### 4. Canal desligado no painel da casa

"Pessoal da casa" = todo usuário que entra no painel da casa: admins (todos,
multi-admin), gestores e experts (restrito e total), incluindo a área do
expert (*chamada minha*). Todos precisam de leitura dos canais da própria
casa e todos veem o aviso "Ciente".

Desligar o e-mail de uma casa bloqueia só envios a players; e-mails para a
equipe da casa (fatura, alerta de cobrança, convite) continuam
(*chamada minha*).

- Some de tudo que é do canal: tipos de passo no editor de jornada, opções
  de campanha, menus/páginas do canal (ex.: web push, voz), filtros, cards e
  relatórios por canal, configuração de domínio de e-mail. Passos já
  existentes numa jornada aparecem como "canal desabilitado — será pulado"
  em vez de sumir (*chamada minha*: sumir com o passo deixaria a jornada
  ilegível e religar o canal não teria onde aparecer). Rota do canal
  acessada direto mostra "canal desabilitado".
- Servidor também bloqueia: criar/editar passo, campanha ou envio manual
  naquele canal falha com mensagem clara (não confiar só na UI).
- Aviso "Ciente": quando o canal é desligado, cada usuário da casa vê, ao
  entrar no painel, um aviso grande ("O canal Voz foi desabilitado para a
  sua casa…") com botão "Ciente". Aparece uma vez por usuário por
  desligamento; se o canal for religado e desligado de novo, aparece de
  novo. Precisa de uma tabela de confirmações (usuário × desligamento) ou
  guardar `disabled_at` em `tenant_channels` e a confirmação por usuário com
  esse timestamp. Ao religar, nenhum aviso (*chamada minha*).
- Super admin entrando numa casa (seletor de casa no header) vê o painel
  como a casa vê, mas não recebe o aviso "Ciente" (*chamada minha*).

### 5. Envios e jornadas

- Motor de jornada: ao chegar num passo de canal desligado, marca o passo
  como pulado (status próprio, ex. `skipped_channel_disabled`) e segue para o
  próximo. Não envia, não cobra, não conta como falha.
- Campanhas agendadas / envios em fila no canal: não enviam; marcadas como
  canceladas por canal desabilitado (*chamada minha*).
- A checagem fica no ponto único onde o envio resolve a conta
  (`resolveChannelAccount`/`resolveOneSignalAccount`) **e** no motor da
  jornada antes de enfileirar — para pular sem gerar erro `misconfigured`.
- Web push hoje: verificar quais casas já têm app OneSignal ativo em
  `tenant_webpush_apps`. Com web push desligado para todas, elas param de
  receber; o deploy do web push ainda está pendente, então provavelmente
  nenhuma, mas a migração deve listar no comentário.

## Ordem e migrações

- Uma migração aditiva: `platform_channel_defaults` (semeada),
  `tenant_channels` (semeada), tabela/colunas do aviso "Ciente", RLS de
  leitura para a casa. Aplicar antes do app (o app antigo ignora). Precisa de
  ok explícito do usuário para aplicar em prod.
- Seed do demo (Casa Betleads) com os mesmos padrões.
- `npm run build` antes de mergear (vazamento de `*.server` no bundle).

## Deixado para quem constrói

- Nomes exatos de tabelas/colunas/status, desde que sigam o padrão das
  migrações de provider_accounts.
- Inventário de todos os lugares do painel da casa que são por canal (fazer
  a lista no plano, um item por tela).
- Textos finais dos avisos, em pt-BR, no tom das telas atuais.
- Preencher os `provider_account_id` NULL (= "padrão") de
  `tenant_domains` e das chaves de breaker com o id da conta env atual, para
  que trocar a padrão não mude retroativamente o que eles significam.
- Devolver crédito já reservado de envios cancelados por canal desligado.
- Passo pulado conta como "não clicou/não abriu" em condições seguintes da
  jornada.
