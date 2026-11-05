# Web Push (OneSignal) — design

Data: 2026-11-05
Status: proposto (branch feat/web-push)
Piloto: Bravabet

## 1. Intenção

As casas querem um canal barato para promoções e avisos que alcance o jogador mesmo quando ele não
está no site e mesmo sem login: a notificação do navegador (web push). O jogador aceita receber ao
entrar na casa; depois disso a casa dispara campanhas pelo CRM, como já faz com SMS.

A OneSignal entrega o push. O CRM fica com tudo o que é da casa: instalação guiada, texto do
convite, público, link rastreado, cobrança e relatório. A casa nunca entra na OneSignal nem vê
chave nenhuma.

Sucesso no piloto é a Bravabet instalar sozinha pelo assistente, os jogadores aceitarem o convite,
e a casa mandar uma campanha "Bonus 100% / Acesse e aproveite agora" para todos os inscritos ou
para um filtro do CRM, vendo enviados, cliques e depósitos atribuídos.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**
- Uma conta (organização) OneSignal global da Betleads, com **uma app por casa** (a OneSignal exige
  uma app por domínio exato).
- Super admin ativa o web push da casa; o CRM cria a app pela API da OneSignal.
- **Área de integração** no CRM, em formato de **assistente em etapas**, para alguém de plataforma
  (não leigo, não especialista) instalar: baixar e subir o arquivo, colar o script, identificar o
  jogador logado, enviar push de teste. Cada etapa é verificada antes de avançar.
- A casa define no CRM o **convite** (texto, botões, ícone) e o ícone padrão das notificações.
- Convite **assim que o jogador entra**, em duas etapas (caixinha da casa → pergunta do navegador).
- Inscrições anônimas recebem campanhas; a inscrição é **ligada ao jogador** quando ele faz login
  naquele navegador.
- **Campanhas** de push no hub de campanhas: título, mensagem, link, imagem opcional; envio agora ou
  agendado; público "todos os inscritos" ou **filtros do CRM** (só inscritos identificados).
- Link passa pelo **rastreador de clique first-party**; atribuição de depósito como no SMS.
- **Cobrança R$ 0,01 por push** aceito pela OneSignal, debitado da carteira da casa.
- Relatório da campanha: enviados, cliques, depósitos atribuídos.

**Não-objetivos (agora)**
- Push como etapa de **jornada** (próxima fase).
- **iOS** (exige PWA na tela inicial; a casa não tem).
- Confirmação de entrega ("entregue"), que depende de Event Streams pago.
- Várias casas no piloto (o fluxo já fica pronto para elas, mas só a Bravabet entra).
- Editor visual rico, botões de ação na notificação, segmentação por dados do navegador.

**Anti-objetivos**
- Expor à casa qualquer chave ou o painel da OneSignal.
- Pedir à casa algo além de subir um arquivo e colar um script (nada de configurar servidor,
  cabeçalhos, CDN).
- Cobrar push que não saiu (inscrição inativa, erro da OneSignal).
- Ligar uma inscrição ao jogador errado de forma silenciosa (ver 5.4).

## 3. Restrições (da OneSignal)

Levantadas na documentação em 2026-10-27:
- O arquivo `OneSignalSDKWorker.js` (uma linha:
  `importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");`) tem de ser servido
  **pelo próprio domínio da casa**, como `application/javascript`. Usamos a subpasta
  `/push/onesignal/` (escopo `/push/onesignal/`) para não conflitar com outro service worker da casa.
  Mudar o caminho depois é caro (o antigo precisa ficar no ar ~1 ano), então ele é fixo.
- **Uma app por origem exata** (`https://bravabet.com` ≠ `https://www.bravabet.com`). Espelhos são
  outras apps; inscritos não migram entre domínios.
- **Nunca duas apps OneSignal no mesmo site** (os inscritos alternam). Se a casa já usar OneSignal,
  o assistente para e o super admin decide (fora do piloto).
- Não há verificação de identidade (JWT) no Web SDK; `login(externalId)` pode ser forjado.
- Envio: `POST https://api.onesignal.com/notifications?c=push`, até 20.000
  `include_subscription_ids` por chamada, `idempotency_key` válido 30 dias, 429 com `Retry-After`.
  A OneSignal **desativa a app** se enviar mais de 10× a base inscrita em 15 minutos.
- Apps e chaves de app são criadas com a **chave da organização** (`POST /apps`,
  `POST /apps/{id}/auth/tokens`); a chave da app só aparece uma vez.
- Plano contratado: **Growth** (sem o limite de 10.000 inscritos por envio do grátis; 6.000 req/s
  de envio por app). Ainda confirmar: se o Growth libera chave da organização e criação de app por
  API (senão vale o caminho manual de 5.1) e o contrato de dados (LGPD).

## 4. O que foi decidido (pelo usuário)

- Conta OneSignal global; o super admin (Betleads) ativa e cria a app de cada casa.
- A casa consegue hospedar o arquivo; quem instala é alguém da plataforma, não especialista.
- Área de integração como **assistente em etapas** (mockup A), com passo a passo de como subir o
  arquivo.
- Convite assim que o jogador entra; **texto, botões e ícone definidos pela casa no CRM**.
- O jogador **não precisa estar logado** para receber; login só liga a inscrição ao jogador.
- Composer: título + mensagem + link escolhido pelo tenant em cada campanha.
- Piloto: **só campanhas**; público **todos os inscritos ou filtros do CRM**.
- **Cobrança por envio, R$ 0,01**.
- A conta OneSignal (plano Growth) será criada pelo usuário; casa cobrada só por disparo; a Bravabet troca de domínio por bloqueio (hoje
  `https://bravabet365.com`).

## 5. Como funciona

### 5.1 Ativação (super admin)

Em Configurações da casa (super admin), um bloco "Web Push": informa a **origem exata** do site
(pré-preenchida com `tenants.site_url`, normalizada para `https://host` sem barra) e clica
"Ativar". O CRM:
1. cria a app na OneSignal (`POST /apps` com `site_name`, `chrome_web_origin`,
   `chrome_web_default_notification_icon`) usando `ONESIGNAL_ORG_API_KEY` (env);
2. cria uma chave REST da app (`POST /apps/{app_id}/auth/tokens`);
3. grava App ID e a chave **criptografada** (mesmo padrão de `meta_connections` /
   `META_TOKEN_ENCRYPTION_KEY`) em `tenant_webpush_apps`, com status `instalando`.

A tabela é **uma linha por origem** (casa + origem únicas), não uma por casa: a casa pode ter `www`
e sem `www`, espelhos ou trocar de domínio por bloqueio. O loader escolhe a app pelo `Origin` da
requisição; inscrições guardam a app de origem; campanhas mandam para as inscrições ativas de todas
as apps ativas da casa. No piloto a tela de ativação cria uma origem por vez (decisão do construtor:
o esquema já aceita várias para não precisar migrar depois).

Alternativa manual: se a criação por API não estiver disponível no plano, o super admin cria a app
no painel da OneSignal e cola App ID e chave REST no mesmo bloco. A conta OneSignal **ainda não
existe** (2026-11-05): os dois caminhos entram no piloto, e o manual é o garantido.

**Troca de domínio por bloqueio** (a Bravabet costuma trocar; hoje `https://bravabet365.com`):
o super admin adiciona a nova origem → nova app → a casa refaz a etapa 1 (arquivo) no domínio
novo; o script colado é o mesmo. A app antiga **continua enviando**: o push chega pelo serviço de
push do navegador, não pelo domínio da casa, então os inscritos antigos seguem alcançáveis mesmo
com o domínio bloqueado. Ela só deixa de captar inscritos (status `legado`). Por isso o link da
campanha deve apontar para o domínio atual (é o tenant que escolhe), e o ícone das notificações é
servido pela Betleads/OneSignal, nunca pelo domínio da casa. A tela mostra inscritos por origem.

Todas as chamadas à OneSignal levam o cabeçalho `OneSignal-Usage: Betleads | Partner Integration`.
Desativar deixa de servir o script e bloqueia envios; não apaga a app.

### 5.2 Área de integração (casa) — assistente em etapas

Nova tela da casa (Configurações → Integrações → Web Push), visível quando o push está ativado.
Quatro etapas; só avança quando a anterior está verificada; o progresso fica salvo.

1. **Arquivo no servidor.** Passo a passo em linguagem simples (baixar sem renomear, criar a pasta
   `push/onesignal` na raiz do site, colocar o arquivo, abrir o endereço no navegador e ver uma
   linha de texto), botão **Baixar OneSignalSDKWorker.js** (gerado pelo CRM, conteúdo fixo), o
   endereço completo esperado e **Verificar agora**: o servidor do CRM faz GET em
   `<origem>/push/onesignal/OneSignalSDKWorker.js` e confere status 200, `Content-Type`
   JavaScript e a linha `importScripts`. Mensagens de erro específicas (404 → pasta/arquivo no
   lugar errado; HTML → o site está devolvendo página em vez do arquivo; tipo errado → pedir para
   servir como JavaScript).
2. **Script no site.** Mostra o trecho pronto para colar no `<head>` de todas as páginas, com botão
   Copiar:
   `<script src="https://betleads.io/api/public/push/loader.js?t=<token>" async></script>`.
   Verificação: concluída quando o loader registra o primeiro carregamento vindo da origem da casa
   (botão "Já colei, verificar").
3. **Identificar o jogador logado** (opcional para concluir). Mostra o trecho
   `window.betleads = { playerId: "ID_DO_JOGADOR" }` a ser definido antes do script quando o jogador
   está logado, explicando que é o mesmo ID que a casa manda nos webhooks. Verificação: primeira
   inscrição ligada a um jogador existente. Pode ser pulada e retomada depois.
4. **Push de teste.** A pessoa que instala aceita o convite no próprio navegador; a tela lista as
   inscrições mais recentes e envia um push de teste para a escolhida. Concluída quando o teste sai
   sem erro. Status da casa passa a `ativo`.

Depois de concluído, a mesma tela mostra o resumo (inscritos ativos, identificados) e permite
refazer verificações.

### 5.3 Convite (configurado pela casa)

Na mesma área (aba "Convite"): texto da caixinha, texto do botão de aceitar e de recusar, ícone do
convite e ícone padrão das notificações (padrão: logo da casa). Pré-visualização na tela.

O loader monta o `OneSignal.init` em modo código com essa configuração a cada carregamento: slidedown
de push sem atraso (`delay: { pageViews: 1, timeDelay: 0 }`), backoff padrão da OneSignal
(3/7/30 dias), `serviceWorkerPath: "push/onesignal/OneSignalSDKWorker.js"`,
`serviceWorkerParam: { scope: "/push/onesignal/" }`. Mudanças valem no próximo carregamento, sem
tocar no site nem no painel da OneSignal.

### 5.4 Loader e inscrições

`GET /api/public/push/loader.js?t=<token>` (público, cacheável por pouco tempo) devolve JS que:
- carrega o SDK v16 da OneSignal pelo CDN oficial e chama `init` com o App ID e o convite da casa;
- a cada carregamento, e no evento `PushSubscription.change`, envia
  `{ subscriptionId, optedIn, playerId? }` para `POST /api/public/push/subscribe?t=<token>`;
- não chama `OneSignal.login`: o vínculo com o jogador fica **no nosso banco**, e os envios usam
  `include_subscription_ids`.

Tabela `push_subscriptions` (por casa): `subscription_id` (único por casa), `player_id` (nulo =
anônima), `status` (`ativa` / `inativa`), `first_seen_at`, `last_seen_at`, `linked_at`,
`user_agent`. Regras:
- `playerId` informado e existente em `players(tenant_id, player_external_id)` → liga (ou religa)
  a inscrição a esse jogador. `playerId` desconhecido → guarda como anônima (não cria jogador).
- Uma inscrição tem no máximo um jogador; um jogador pode ter várias inscrições (navegadores).
- `optedIn = false` → `inativa`.
- O endpoint valida o token da casa, aceita só requisições com `Origin` igual à origem
  cadastrada, limita taxa por IP e grava o primeiro carregamento para a etapa 2.

Risco aceito no piloto: sem assinatura, alguém que saiba o ID de outro jogador pode ligar o próprio
navegador a ele e receber os pushes dele. Por isso o conteúdo do push **não deve levar dados
pessoais**, e fica previsto (fora do piloto) um modo assinado: a casa passa também
`sig = HMAC(webhook_secret, playerId)` e o CRM só liga com assinatura válida.

Consentimento: inscrição ativa = consentimento para o canal `webpush`; o jogador sai pelo próprio
navegador. LGPD (decisão do construtor, sem tela nova): o CRM ainda não tem exclusão de jogador;
`push_subscriptions.player_id` fica com FK `on delete cascade` e existe um utilitário servidor que
remove as inscrições na OneSignal, para quando a exclusão existir. Nada além disso no piloto.

### 5.5 Campanha de push

Novo canal `webpush` no hub de campanhas e no composer existente (mesmo fluxo de rascunho,
confirmação e agendamento do SMS):
- campos: título (obrigatório), mensagem (obrigatória), link (obrigatório), imagem (opcional);
  pré-visualização de como aparece no Chrome;
- público: **todos os inscritos ativos** (anônimos incluídos) ou os **filtros do CRM** existentes,
  que resolvem jogadores e daí as inscrições ativas deles; a confirmação mostra quantas inscrições
  vão receber e o custo estimado (`inscrições × R$ 0,01`).

Disparo: o mesmo padrão de tick por cron do SMS. Em lotes de até 1.000 inscrições (bem abaixo do
teto de 20.000, para limitar a cobrança reservada por chamada), com `idempotency_key` determinístico
por campanha+lote, ritmo controlado por `channel_rate_limits` (novo canal `webpush`) e trava de
segurança que nunca envia mais que a base ativa da casa por campanha (evita a desativação 10×/15 min).
Por lote: reserva na carteira (`inscrições × 1`, item `webpush`), envia, e estorna as inscrições
que a OneSignal recusou (`invalid_player_ids` / "not subscribed", que também viram `inativa`).
Erro total do lote → estorno total e nova tentativa com a mesma chave.

Link: o link é reescrito pelo rastreador first-party (`/api/public/click/$token`,
`link_dispatches` com `channel = 'webpush'`). **Requisito:** o clique tem de ficar ligado à
inscrição (e, se identificada, ao jogador), porque a atribuição de depósito
(`attributeFromLastFirstPartyClick`) depende de `recipient_player_id`; um link único por campanha
daria zero depósitos atribuídos. O plano escolhe o mecanismo, nesta ordem: (a) personalização do
`url` pela OneSignal com o id da inscrição, se a documentação/teste confirmar; (b) o loader capturar
`notification.click` e registrar `subscriptionId` + campanha no nosso endpoint antes de abrir o
link; (c) uma chamada por inscrição identificada, com link próprio (anônimas num lote com link da
campanha).

Registro por envio: tabela `webpush_send_logs` (campanha, inscrição, jogador, id da notificação
OneSignal, status `enviado`/`recusado`, cobrança).

### 5.6 Cobrança

Novo item `webpush` no catálogo de preços (`billing_price_book`, constraint e `wallet_reserve`), com
preço padrão **R$ 0,01**; `reserveUsage` ganha o item. Casas com plano interno continuam isentas.
A casa é cobrada **só por disparo**; nenhuma tela da casa mostra custo por inscrito nem o custo da
OneSignal. No painel financeiro o custo de provedor do push fica 0 por envio.

### 5.7 Relatório

No relatório da campanha: inscrições alvo, enviados, recusados, cliques (do rastreador) e depósitos
atribuídos (mesma regra do SMS). Sem "entregue".

## 6. Fica a critério de quem constrói

- Nomes exatos de tabelas, rotas e componentes, e onde a tela entra na navegação de Configurações.
- O texto final do passo a passo (simples, com imagens se ajudar) e das mensagens de erro.
- Cache do loader e formato do token público (pode reusar `tenants.webhook_token` ou um token
  próprio do push — preferir um próprio, para não expor o do webhook).
- Pontos do código onde `webpush` entra nas constraints de canal (lista no mapeamento de
  2026-10-27: `campaign_drafts`, `channel_consents`, `link_dispatches`, `channel_rate_limits`,
  tipos TS de canal etc.). Jornadas não mudam.

## 7. Pontos em aberto

- Mecanismo do clique por inscrição (5.5): validar (a) no início da implementação.
- Confirmar com a OneSignal plano, chave da organização e contagem de inscritos antes de ativar.
