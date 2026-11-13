// Help article for "Integrações" (/webhooks), com 4 abas: "Plataforma de
// apostas" (plataforma, a aba padrão), "Links curtos" (links), "Meta Ads"
// (meta) e "Web Push" (webpush). Fonte: src/routes/webhooks.tsx (as 4 abas,
// TABS, hash default "plataforma", a aba "webpush" só aparece com o canal
// Web Push ligado para a casa).
//
// Plataforma: src/routes/webhooks.tsx (PlatformSection) e
// src/lib/webhooks.functions.ts (getMyWebhookAccess/Token/Logs/Health,
// provisionMyWebhookHmacSecret, setMyWebhookHmacEnforcement) e
// src/lib/webhook-events.ts (WEBHOOK_EVENTS, describeEventType).
//
// Meta Ads: src/components/integrations/meta-connection.tsx (painel +
// "Montar marcação") e src/components/integrations/meta/* (setup-guide,
// connect-key-sheet, meta-connection-view, connection-card, account-selection,
// account-group, progress-strip, sync-history, disconnect-dialog, meta-badges,
// meta-copy, meta-format) e src/components/integrations/meta-connection-model.ts
// (regras puras) e src/components/integrations/meta/use-meta-actions.ts (as
// mutações e seus avisos).
//
// Web Push: src/components/webpush/webpush-integration-panel.tsx (abas
// Assistente/Convite), src/components/webpush/webpush-setup-wizard.tsx
// (etapas 1 e 2, texto do chamado de suporte) e
// src/components/webpush/webpush-prompt-form.tsx (aba Convite). O bloco de
// super admin (src/components/webpush/webpush-super-admin-block.tsx — ativar
// uma origem na OneSignal, marcar como antiga/desativada) não entra aqui: é
// feito pela equipe Betleads. Para o canal Web Push em si (campanhas,
// inscrições, histórico), ver o artigo de /webpush (screens/webpush.ts) —
// aqui só a configuração da integração.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "webhooks",
  route: "/webhooks",
  // The route's own fallback tab.
  defaultTab: "plataforma",
  title: "Integrações",
  purpose:
    "Conectar a plataforma de apostas (endereços de recebimento e assinatura), configurar os links curtos (encurtador), a conta de anúncios da Meta e o Web Push (notificações no navegador).",
  roles: ["admin", "gestor", "member"],
  terms: ["encurtador", "bm", "usuario-do-sistema", "ads-read", "utm"],
  sections: [
    // ---------------------------------------------------------------
    // Aba Plataforma de apostas (admin)
    // ---------------------------------------------------------------
    {
      id: "plataforma",
      title: "Plataforma de apostas",
      tab: "plataforma",
      intro:
        "Os endereços que a plataforma de apostas da casa chama para avisar o CRM de cada evento (cadastro, depósito, saque...), o que chegou nas últimas 24 horas e a assinatura que comprova que o envio veio mesmo da plataforma. Só o administrador da casa vê esta aba — os outros perfis veem o aviso \"Acesso administrativo necessário\".",
      items: [
        {
          anchor: "webhooks.plataforma.cartoes",
          label: '"Recebidos", "Registrados", "Precisam de atenção" e "Último recebimento"',
          what: 'Quatro números das últimas 24 horas. "Recebidos" conta todo envio que chegou; "Registrados", os que foram gravados com sucesso; "Precisam de atenção" soma os que deram erro com os que chegaram sem achar o jogador (sem_player); "Último recebimento" mostra há quanto tempo foi o envio mais recente, com o evento e a situação dele.',
          notes:
            'O cartão "Recebidos" acrescenta "· N repetidos, ignorados com segurança" quando a plataforma reenviou o mesmo evento (o CRM descarta a repetição sem efeito). "Precisam de atenção" fica destacado em laranja quando maior que zero. São só leitura, atualizados a cada 10 segundos.',
        },
        {
          anchor: "webhooks.plataforma.endereco-base",
          label: "Endereço base (cada evento acrescenta o seu final)",
          what: "O endereço comum a todos os eventos; cada evento é esse endereço com /e um final próprio (por exemplo /cadastro). É exclusivo desta casa: quem tiver o endereço consegue enviar dados para ela, por isso não deve ser compartilhado fora da equipe da plataforma.",
          notes:
            'O botão copia o endereço e mostra "Copiado" por 1,8 segundos (o toast de sucesso é "Endereço copiado"). Enquanto a chave carrega, o campo mostra um esqueleto; se não houver endereço (chave ainda não existe ou a busca falhou), o campo some e o botão de copiar fica desativado.',
        },
        {
          anchor: "webhooks.plataforma.eventos",
          label: "Endereços de integração",
          what: 'Um endereço por evento, agrupados por categoria: Usuário (Cadastro, Login, Logout), Depósito (Depósito Pendente, Depósito Aprovado, Depósito Falhou), Saque (Saque Pendente, Saque Aprovado, Saque Falhou, Saque Concluído), Jogo (Jogo Iniciado) e Bônus (Bônus Ativado, Cashback Pago). Cada linha mostra o nome do evento, o final do endereço e uma descrição curta.',
          notes:
            'Cada linha tem o selo "ativo · há X" (já recebeu esse evento, com a última vez) ou "aguardando" (nunca recebeu), e um botão para copiar o endereço completo daquele evento (mostra "Copiado" por 1,8 segundos). Sem chave carregada, o botão de copiar fica desativado.',
        },
        {
          anchor: "webhooks.plataforma.recebimentos",
          label: "Últimos recebimentos",
          what: 'A lista dos últimos 50 envios da plataforma, atualizada a cada 10 segundos, com o evento, a situação ("recebido", "registrado", "repetido", "com erro" ou "jogador não encontrado"; um status desconhecido aparece como "situação desconhecida") e há quanto tempo chegou.',
          notes:
            'Clicar numa linha abre "Detalhes do recebimento", com o evento, a situação, a data/hora completa e os dados recebidos (JSON), com um botão "Copiar" que copia esses dados (toast "Dados copiados"). Sem nenhum recebimento ainda, a lista mostra "Nada recebido ainda" e, embaixo, "Os dados enviados pela plataforma de apostas vão aparecer aqui em tempo real." (na casa de demonstração, em vez desse texto aparece "Nenhum dado neste ambiente de demonstração").',
        },
        {
          anchor: "webhooks.plataforma.seguranca",
          label: "Segurança avançada: assinatura dos envios",
          what: 'Painel retrátil que explica e controla a assinatura dos envios da plataforma: "Garante que os dados vieram mesmo da plataforma. Ative somente depois de configurar a mesma chave na plataforma da casa." Mostra o selo "assinatura obrigatória" (verde) ou "assinatura ainda opcional" (laranja), e o texto "Chave gerada." ou "Nenhuma chave gerada."',
          notes:
            'Para quem repassa a integração ao desenvolvedor da plataforma: a assinatura é HMAC-SHA256 com a chave, enviada no cabeçalho x-webhook-signature.',
        },
        {
          anchor: "webhooks.plataforma.chave",
          label: '"Gerar chave" / "Trocar chave"',
          what: 'Sem chave, o botão mostra "Gerar chave" e abre a confirmação "Gerar a chave de assinatura?" ("A chave permite que a plataforma de apostas assine cada envio, provando que os dados vieram mesmo dela. Ela aparece uma única vez, então copie-a e entregue-a ao responsável pela integração. Gerar a chave não muda nada no recebimento até você exigir a assinatura.", botão "Gerar chave"). Com chave já gerada, o botão mostra "Trocar chave" e abre "Trocar a chave de assinatura?" ("A chave atual deixa de valer imediatamente e uma nova é gerada; ela aparece uma única vez, então copie-a." — com assinatura já exigida, soma "A exigência de assinatura será desligada até você ativá-la de novo, e os envios da plataforma passam a entrar sem verificação nesse intervalo." — "Atualize a nova chave na plataforma da casa antes de exigir assinatura.", botão destrutivo "Trocar chave").',
          notes:
            'Enquanto gera, o botão mostra "Gerando...". Ao terminar, aparece "Chave gerada. Configure-a na plataforma da casa antes de exigir a assinatura." e a chave aparece uma única vez num campo com botão "Copiar" (toast "Chave copiada"). Fica desativado na casa de demonstração e enquanto a chave atual ainda está carregando.',
        },
        {
          anchor: "webhooks.plataforma.exigir",
          label: '"Exigir assinatura" / "Aceitar sem assinatura por enquanto"',
          what: 'Sem a assinatura exigida ainda, o botão "Exigir assinatura" abre "Exigir assinatura nos envios?" ("A partir de agora, todo envio sem assinatura válida será recusado. Se a plataforma da casa ainda não assina os envios com a chave atual, depósitos, cadastros e os demais eventos deixam de ser registrados até ela configurar a chave. Confirme com a casa antes de ativar.", botão destrutivo "Exigir assinatura"). Com a assinatura já exigida, o botão vira "Aceitar sem assinatura por enquanto" e abre "Aceitar envios sem assinatura?" ("Os envios da plataforma voltam a ser aceitos mesmo sem assinatura, ou seja, sem a verificação de que vieram dela. Use só enquanto a casa troca ou configura a chave, e volte a exigir a assinatura assim que possível.", botão destrutivo "Aceitar sem assinatura").',
          notes:
            'Ao confirmar, aparece "A assinatura dos envios passou a ser obrigatória." ou "Os envios sem assinatura voltaram a ser aceitos." "Exigir assinatura" fica desativado sem chave gerada; os dois ficam desativados na casa de demonstração.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Links curtos (unchanged — fase 1)
    // ---------------------------------------------------------------
    {
      id: "links",
      title: "Links curtos",
      tab: "links",
      intro:
        "Os links enviados por SMS e e-mail viram links curtos (com o domínio da casa, configurado em Configuração da casa) para o CRM contar quem clicou. Esta aba mostra o desempenho desses links e a configuração do encurtador.",
      items: [
        {
          label: "Links enviados / Cliques / Taxa de clique",
          what: 'Três números dos últimos 30 dias: "Links enviados" (quantos links curtos foram criados), "Cliques" (quantos desses links foram clicados pelo menos uma vez) e "Taxa de clique" (cliques ÷ links enviados, em %).',
          notes:
            "São só leitura, atualizados a partir dos cliques no redirecionador do próprio CRM — não precisa atualizar a página manualmente para os números mudarem na próxima visita.",
        },
        {
          label: 'Cartão "Por canal e origem"',
          what: 'Uma linha por combinação de canal e origem (por exemplo "SMS — Campanha" ou "E-mail — Jornada"), cada uma com cliques, envios e a taxa de clique daquela combinação, nos últimos 30 dias.',
          notes:
            'Enquanto carrega mostra um esqueleto; se a busca falhar, mostra "Não foi possível carregar os números de links. Tente de novo em instantes." — veja em "Situações que podem aparecer".',
        },
        {
          anchor: "webhooks.links.enabled",
          label: "Ativar links curtos",
          what: "Liga ou desliga o encurtamento de links nas mensagens da casa.",
          roles: ["admin"],
          notes:
            'Desligado, os links das mensagens saem no tamanho original — o CRM para de registrar cliques por link individual. O que fazer quando o encurtador falhar (uma vez ligado) é configurado em "Se o encurtador falhar", mais abaixo.',
        },
        {
          anchor: "webhooks.links.dominio-link",
          label: "Configuração da casa (link)",
          what: 'Leva até a aba Encurtador de "Configuração da casa", onde fica o domínio próprio usado nos links curtos (por exemplo go.suacasa.bet.br).',
          roles: ["admin"],
          notes:
            "Sem domínio próprio verificado lá, os links continuam saindo pelo domínio padrão do CRM — nada para de funcionar.",
        },
        {
          anchor: "webhooks.links.hosts",
          label: "Sites permitidos",
          what: "Lista de sites (domínios), separados por vírgula, para os quais o encurtador aceita gerar links. Um link para qualquer outro site não é encurtado.",
          roles: ["admin"],
          notes:
            "Em branco, vale para qualquer site de destino. Preencher é uma forma de garantir que só os links da própria casa (ou de parceiros combinados) sejam encurtados.",
        },
        {
          anchor: "webhooks.links.ttl",
          label: "Validade do link (dias)",
          what: "Por quantos dias um link curto continua funcionando depois de criado.",
          roles: ["admin"],
          notes: "Em branco, o link não expira — continua redirecionando para sempre.",
        },
        {
          anchor: "webhooks.links.fallback",
          label: "Se o encurtador falhar",
          what: 'Escolhe o que fazer quando o provedor do encurtador (Short.io) não responde no momento de um envio: "Não enviar a mensagem" (bloqueia o envio até o encurtador voltar) ou "Enviar com o link original" (manda a mensagem com o link completo, sem contar cliques dessa vez).',
          roles: ["admin"],
        },
        {
          anchor: "webhooks.links.save",
          label: "Salvar",
          what: "Grava as configurações de links curtos desta casa.",
          roles: ["admin"],
          notes:
            'Mostra "Salvando…" enquanto grava e o aviso "Configuração de links salva" ao terminar. Se a gravação falhar, mostra "Não foi possível salvar: <motivo>" (quando o servidor manda um motivo específico) ou "Não foi possível salvar a configuração de links".',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Meta Ads
    // ---------------------------------------------------------------
    {
      id: "meta",
      title: "Meta Ads",
      tab: "meta",
      intro:
        "Conecta a conta de anúncios da Meta (Facebook e Instagram) para medir o retorno dos anúncios em Aquisição e LTV, e monta a marcação (UTM) para colar nos próprios anúncios. Só o administrador da casa altera a conexão; os outros perfis veem os mesmos dados travados.",
      items: [
        {
          anchor: "webhooks.meta.guia",
          label: "Guia de preparação (passo a passo)",
          what: 'Aparece sem nenhuma chave conectada ainda (e no painel de adicionar chave), com o passo a passo completo e link direto para cada tela da Meta. "Antes de começar": é preciso ser administrador da BM, fazer pelo computador (uns 10 minutos), e quem já tem Usuário do Sistema com acesso às contas pode ir direto à Parte 3. Parte 1 — Criar o app da operação: criar o app no painel de desenvolvedores (caso de uso "Outro", tipo "Empresa"), escolher a BM da operação em "Portfólio empresarial" e adicionar o produto "API de Marketing"; o app não precisa ser publicado. Parte 2 — Criar o Usuário do Sistema e dar acesso: criar o Usuário do Sistema (função Administrador), em "Atribuir ativos" dar "Ver desempenho" nas contas de anúncio e "Gerenciar app" no app da Parte 1. Parte 3 — Gerar a chave: "Gerar novo token", escolher o app, validade "Nunca", marcar só ads_read, copiar a chave (começa com EAA) e colar no CRM — ela só aparece uma vez na Meta. Cada parte abre e fecha clicando no título.',
          notes:
            'Avisa: "Tem mais de uma BM? Crie um Usuário do Sistema em cada BM e conecte uma chave por BM. Outra opção: atribua as contas das BMs parceiras a um só Usuário do Sistema; uma chave alcança todas." e "Use a chave do Usuário do Sistema. A chave de um usuário comum expira em poucas semanas e é recusada." O bloco "Deu erro ao validar a chave?" (fechado de início) explica o que fazer em cada recusa: chave de perfil pessoal, sem ads_read, sem contas atribuídas, app sem "Ads Management Standard Access" e chave inválida.',
        },
        {
          anchor: "webhooks.meta.chave-input",
          label: "Chave de acesso do Usuário do Sistema",
          what: "Campo onde cola a chave copiada da Meta (aceita um texto longo, tipo senha). É pedido sem nenhuma chave conectada ainda e também ao adicionar outra chave ou trocar a de uma conexão existente.",
          roles: ["admin"],
          notes:
            'Fica guardada de forma criptografada e não volta a aparecer depois. O painel lateral que o pede tem o título "Adicionar Usuário do Sistema" (para somar uma chave) ou "Trocar chave · <nome da chave>" (para substituir a de uma conexão existente).',
        },
        {
          anchor: "webhooks.meta.validar",
          label: "Validar acesso e buscar contas",
          what: "Confirma a chave colada: a Meta valida o acesso e o CRM lista as contas de anúncio que essa chave alcança.",
          roles: ["admin"],
          notes:
            'Fica desativado com menos de 40 caracteres na chave. Ao validar, mostra "Chave "<nome>" conectada: N BMs, N contas (N novas). Marque as que deseja acompanhar e salve." (ou "atualizada" em vez de "conectada", ao trocar a chave de uma conexão existente). Se a chave for de outro Usuário do Sistema ou de outro app, ela entra como uma nova conexão e aparece o aviso "Esta chave é de outro Usuário do Sistema ou de outro app: ela foi adicionada como uma nova conexão e a chave antiga continua conectada." Falhando, mostra "Não foi possível validar a chave de acesso da Meta" ou, quando a Meta informa o motivo, a mensagem específica — as mais comuns são "Use a chave de um Usuário do Sistema: chaves de usuário comum expiram em até 60 dias.", "A chave foi gerada por outro app da Meta." e "A chave de acesso é inválida ou expirou."',
        },
        {
          anchor: "webhooks.meta.progresso",
          label: '"Conectar → Escolher contas → Primeira leitura → Pronto"',
          what: 'Mostra em que etapa a conexão está: conectar uma chave, escolher as contas, a primeira leitura dos últimos 90 dias (com a % de progresso) e "Pronto", que leva a "Ver Aquisição e LTV".',
          notes:
            '"Pronto" com alguma conta com erro na primeira leitura mostra "Pronto · N conta(s) com erro na primeira leitura". Uma conta nova marcada depois que a casa já estava "Pronto" não volta para "Primeira leitura": o resumo mostra "Importando contas novas (N%)" dentro do próprio "Pronto".',
        },
        {
          anchor: "webhooks.meta.adicionar",
          label: "Adicionar Usuário do Sistema",
          what: "Abre o painel lateral para conectar outra chave, somando as BMs e contas que ela alcança às que a casa já tem.",
          roles: ["admin"],
          notes: "Aparece só depois da primeira chave conectada; some na casa de demonstração.",
        },
        {
          anchor: "webhooks.meta.sincronizar",
          label: "Sincronizar agora",
          what: "Coloca na fila uma releitura das contas marcadas (últimos 7 dias), sem esperar a sincronização automática.",
          roles: ["admin"],
          notes:
            'Fica desativado sem nenhuma conta marcada. Mostra "A sincronização já está na fila" (se já havia uma pendente) ou "Sincronização adicionada à fila"; falhando, "Erro ao agendar sincronização".',
        },
        {
          anchor: "webhooks.meta.chaves",
          label: "Chaves conectadas",
          what: 'Um cartão por chave: nome ("Chave "<nome>""), app e trecho da chave, Usuário do Sistema, quantas BMs e contas alcança (e quantas marcadas), validade ("Não expira", "Expira em <data>" ou "Validade desconhecida") e um selo de saúde ("ok", "atenção" ou "erro").',
          notes:
            'Uma chave com problema mostra o motivo ("A chave está com erro. Teste o acesso ou troque a chave.", "A chave expirou. Troque a chave.", "A chave expira em menos de 1 dia. Troque a chave." ou "A chave expira em N dias. Troque a chave.", e/ou "N conta(s) com erro de sincronização.") com o botão "Trocar chave" ao lado. Uma chave da integração antiga (app compartilhado) ganha o selo "Conexão antiga", e a tela mostra o aviso "Conexão antiga precisa ser substituída: A integração anterior usava o app compartilhado da plataforma. Gere uma chave no app da sua operação e conecte; os dados já importados ficam." Cada cartão tem o botão "Testar acesso" e o menu "..." com "Renomear" (até 60 caracteres), "Trocar chave" e "Desconectar". Sem nenhuma chave conectada: para o admin, mostra o guia e o campo de conectar a primeira chave; para os outros perfis, "A Meta ainda não está conectada nesta casa."\n\n"Testar acesso" mostra "Acesso testado · N conta(s) acessível(is) (N nova(s))" (a parte entre parênteses só aparece com conta nova) ou, falhando, "Não foi possível testar o acesso". "Renomear" mostra "Chave renomeada para "<nome>"" ou, falhando, "Não foi possível renomear a chave". O texto embaixo do nome da chave (quando ela está com erro, gravado pela última verificação automática) é um destes: "Conexão antiga: reconecte usando a chave de acesso do Usuário do Sistema.", "Nenhuma chave conectada alcança esta conta.", "A conta foi removida ou deixou de estar selecionada.", "A chave perdeu a permissão ads_read.", "A Meta não devolveu nenhuma conta para esta chave. Teste o acesso.", "A chave de acesso é inválida ou expirou." ou "A chave foi revogada ou expirou. Gere uma nova no Business Manager."',
        },
        {
          label: 'Diálogo "Desconectar a chave "<nome>"?"',
          what: 'Remove a chave de acesso guardada desta casa. Lista o impacto: quantas contas e BMs ela alcança, quantas contas vão parar de sincronizar e quantas continuam por outra chave conectada, e avisa que os dados já importados ficam. Botões "Cancelar" e "Desconectar" (vermelho).',
          notes:
            'Quando pelo menos uma conta vai parar de sincronizar, o botão "Desconectar" só libera depois de digitar o nome da chave no campo "Para confirmar, digite o nome da chave: <nome>" (sem diferença de acento, caixa ou espaços). Ao confirmar, mostra "Chave desconectada" com o resumo do que mudou (contas que seguem por outra chave; contas que pararam), ou, falhando, "Não foi possível desconectar".',
        },
        {
          anchor: "webhooks.meta.contas",
          label: "Contas de anúncio",
          what: 'Lista as contas que alguma chave conectada alcança, mais as já marcadas mesmo sem chave, agrupadas por BM. Tem busca (por nome, ID da conta ou BM) e os filtros "Todas", "Marcadas", "Com erro" e "Novas". O checkbox do cabeçalho de cada BM marca/desmarca o grupo inteiro (fica "misto" com só parte marcada).',
          notes:
            'Só dá para marcar conta alcançada por uma chave conectada — sem chave que a alcance mostra "Nenhuma chave conectada alcança esta conta."; com a chave em erro, "A chave que alcança esta conta está com erro. Teste o acesso." Conta em moeda diferente de BRL mostra "Gasto em outra moeda fica fora do ROAS e do custo por FTD." Sem nenhuma conta na lista: "Nenhuma conta de anúncio apareceu. No Business Manager, dê ao Usuário do Sistema acesso às contas de anúncio e depois clique em "Testar acesso"." (ou, com busca/filtro sem resultado, "Nenhuma conta corresponde à busca ou ao filtro.").',
        },
        {
          anchor: "webhooks.meta.alteracoes",
          label: 'Barra "N alteração(ões) não salva(s)"',
          what: 'Aparece ao marcar ou desmarcar contas sem salvar ainda, com os botões "Descartar" (volta ao que estava salvo) e "Salvar contas".',
          notes:
            'Ao salvar, mostra "N conta(s) marcada(s)" (e, se alguma conta nova entrou, ", a importação dos últimos 90 dias começou"). Se a lista de contas mudou desde que a tela abriu (outra pessoa alterou, ou uma conexão caiu), aparece "A lista de contas mudou desde que você abriu a tela. Revise e salve de novo." e a página relê a lista. Qualquer outra falha ao salvar mostra "Não foi possível salvar as contas".',
        },
        {
          label: 'Diálogo "Sair sem salvar?"',
          what: 'Aparece ao tentar navegar para outra página (ou outra aba desta) com marcações não salvas: "Você tem alterações não salvas nas contas da Meta. Sair mesmo assim?" Botões "Continuar editando" e "Sair sem salvar".',
          notes:
            "Só cobre a navegação dentro do próprio CRM; fechar a aba ou recarregar a página usa o aviso padrão do navegador.",
        },
        {
          anchor: "webhooks.meta.historico",
          label: "Histórico de sincronizações",
          what: 'As últimas 10 leituras da Meta desta casa: tipo (manual, automática, automática (N dias) ou importação inicial), situação (na fila, em andamento, concluída, concluída com atenção, falhou ou cancelada), quando foi pedida, quantas contas foram processadas, linhas importadas e duração. Clicar numa linha mostra o resultado de cada conta (situação, linhas importadas, tentativas e, se houve, o erro).',
          notes:
            'Falhando, mostra "Não foi possível carregar o histórico." (ou, ao abrir uma sincronização, "Não foi possível carregar as contas desta sincronização."). Sem nenhuma sincronização ainda: "Nenhuma sincronização ainda." (ou, dentro de uma, "Nenhuma conta nesta sincronização.").',
        },
        {
          anchor: "webhooks.meta.marcacao",
          label: 'Montar marcação — campo "Link da casa" e parâmetros de UTM',
          what: 'Cole o link de destino do anúncio (por exemplo a página de cadastro) e o CRM monta o link completo já com os parâmetros de UTM, prontos para colar nos anúncios do Facebook e do Instagram.',
          notes:
            'O utm_id leva o ID do anúncio: é ele que liga cada cadastro ao anúncio certo, mesmo quando dois anúncios têm o mesmo nome. Os botões "Copiar" dos blocos "Parâmetros de URL" e "Link completo" copiam o respectivo texto (toast "Copiado"); se o navegador recusar a cópia, mostra "Não foi possível copiar. Selecione o texto e copie manualmente."',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Web Push
    // ---------------------------------------------------------------
    {
      id: "webpush",
      title: "Web Push",
      tab: "webpush",
      intro:
        "Instala e verifica o Web Push (notificações no navegador) no site da casa, e configura o convite de permissão mostrado ao visitante. Só aparece quando o canal Web Push está ligado para a casa; a ativação da origem na OneSignal é feita pela equipe Betleads, não aqui. Para enviar campanhas e ver o histórico de envios, veja o artigo do canal Web Push (/webpush).",
      items: [
        {
          anchor: "webhooks.webpush.abas",
          label: "Abas Assistente / Convite",
          what: '"Assistente" guia a instalação e o teste no site; "Convite" configura o texto e os botões do pedido de permissão mostrado ao visitante.',
        },
        {
          label: "Web Push ainda não ativado",
          what: 'Mensagem mostrada no lugar do assistente quando a casa ainda não tem nenhuma origem (site) ativada para o Web Push: "O Web Push ainda não foi ativado para esta casa. Fale com a Betleads."',
        },
        {
          anchor: "webhooks.webpush.modo-instalacao",
          label: "Como instalar: plataforma ou manual",
          what: '"Minha plataforma já tem integração com a Betleads" é para casas cujo backoffice já traz o arquivo e o script: basta colar o token da casa lá. "Vou instalar manualmente" mostra o arquivo, o script e as instruções para o suporte do site. Os dois caminhos usam o mesmo status logo abaixo.',
        },
        {
          anchor: "webhooks.webpush.bloco-token",
          label: "Token da casa",
          what: "O token público que identifica a casa no script da Betleads. No caminho pela plataforma, é o único dado que a casa cola no backoffice para ativar o Web Push. Não é segredo: ele vai no HTML do site.",
          notes:
            'O botão mostra "Token copiado" ao copiar com sucesso, ou "Não foi possível copiar. Selecione o texto e copie manualmente." se falhar.',
        },
        {
          anchor: "webhooks.webpush.copiar-instrucoes",
          label: "Copiar instruções para o suporte",
          what: "Copia, num só texto, tudo que o suporte do site da casa precisa para instalar o Web Push: o arquivo do service worker, o script e a identificação do jogador — para abrir um único chamado em vez de três.",
          notes:
            'Mostra "Instruções copiadas" ao copiar com sucesso, ou "Não foi possível copiar. Selecione o texto e copie manualmente." se o navegador recusar (sem acesso à área de transferência, ou fora de um contexto seguro).',
        },
        {
          anchor: "webhooks.webpush.bloco-arquivo",
          label: "1. Arquivo",
          what: 'O arquivo OneSignalSDKWorker.js para baixar e colocar, sem renomear, na pasta push/onesignal na raiz do site. Mostra o endereço completo onde ele deve abrir, com botão "Copiar".',
          notes:
            'O botão mostra "Endereço copiado" ao copiar com sucesso, ou "Não foi possível copiar. Selecione o texto e copie manualmente." se falhar.',
        },
        {
          anchor: "webhooks.webpush.bloco-script",
          label: "2. Script",
          what: "O código para colar no <head> de todas as páginas do site, com botão de copiar.",
          notes:
            'O botão mostra "Script copiado" ao copiar com sucesso, ou "Não foi possível copiar. Selecione o texto e copie manualmente." se falhar.',
        },
        {
          anchor: "webhooks.webpush.bloco-jogador",
          label: "3. Jogador logado (opcional)",
          what: "O código que identifica o jogador logado (o mesmo ID enviado nos webhooks da casa), para colar antes do script do passo 2 — opcional, mas recomendado para saber quem recebeu cada push.",
          notes:
            'O botão mostra "Script copiado" ao copiar com sucesso (a mesma mensagem do bloco do Script), ou "Não foi possível copiar. Selecione o texto e copie manualmente." se falhar.',
        },
        {
          anchor: "webhooks.webpush.status",
          label: "Status: Arquivo / Script / Jogador logado",
          what: 'Três verificações. "Arquivo": botão "Verificar agora" que confere se o arquivo está no ar; mostra "Arquivo encontrado" ou o motivo do erro ("Não encontramos o arquivo nesse endereço. Confira se a pasta é push/onesignal e o nome do arquivo não mudou.", "O site devolveu uma página em vez do arquivo. Confira se o arquivo foi enviado para a pasta certa.", "O arquivo está lá, mas o servidor não o entrega como JavaScript. Peça para servir .js como application/javascript.", "O arquivo foi alterado. Baixe de novo e envie sem editar." ou "Não conseguimos acessar o site agora. Tente de novo em alguns minutos."). "Script": mostra "Script detectado" assim que alguém acessa o site com o script instalado, ou "Aguardando o primeiro acesso ao site" com um botão "Verificar". "Jogador logado": mostra "Jogador identificado" ou "Ainda não identificado (opcional)".',
          notes:
            'Se "Verificar agora" falhar por um motivo fora da lista acima (por exemplo, um erro inesperado do servidor), aparece um aviso mostrando o próprio motivo devolvido pelo servidor, em vez de uma das frases fixas.',
        },
        {
          anchor: "webhooks.webpush.proxima-etapa",
          label: "Próxima etapa",
          what: "Avança para a etapa de teste.",
          notes: 'Só libera depois que "Arquivo" e "Script" estiverem confirmados; o jogador identificado é opcional e não bloqueia o avanço.',
        },
        {
          anchor: "webhooks.webpush.teste",
          label: "Etapa 2 — Teste",
          what: 'Pede para abrir o site da casa no mesmo navegador e aceitar as notificações; lista as inscrições recentes (navegador e se já está identificado com um jogador), cada uma com um botão "Enviar teste".',
          notes:
            'Sem nenhuma inscrição ainda: "Nenhuma inscrição ainda." Enquanto envia, o botão mostra "Enviando…"; ao terminar, "Teste enviado". Se o envio falhar, aparece um aviso mostrando o próprio motivo devolvido pelo servidor. Um teste enviado com sucesso é o que faz a casa avançar para o resumo "concluído".',
        },
        {
          anchor: "webhooks.webpush.concluido",
          label: "Resumo (Web Push concluído)",
          what: "Mostra cada site (origem) já verificado, com quantas inscrições ativas e quantas identificadas com jogador, e a situação.",
          notes:
            'O botão "Refazer verificação" volta a mostrar o assistente (etapas 1 e 2), para conferir tudo de novo — por exemplo depois de uma mudança no site.',
        },
        {
          anchor: "webhooks.webpush.convite-texto",
          label: "Texto do convite",
          what: "O texto que a pessoa vê quando o navegador pergunta se aceita receber notificações do site (até 90 caracteres).",
          roles: ["admin"],
        },
        {
          anchor: "webhooks.webpush.convite-rotulos",
          label: "Rótulo de aceitar / Rótulo de cancelar",
          what: "Os textos dos dois botões do convite (até 15 caracteres cada).",
          roles: ["admin"],
        },
        {
          anchor: "webhooks.webpush.convite-icone",
          label: "Ícone (URL https, opcional)",
          what: "O endereço de uma imagem (https) para aparecer ao lado do texto do convite; sem ela, aparece um quadrado neutro no lugar.",
          roles: ["admin"],
        },
        {
          anchor: "webhooks.webpush.convite-salvar",
          label: "Salvar",
          what: "Grava o texto, os rótulos e o ícone do convite.",
          roles: ["admin"],
          notes:
            'Mostra "Salvando…" e, ao terminar, o aviso "Convite de notificações salvo". Falhando, mostra o próprio motivo do erro devolvido pelo servidor (não há uma mensagem padrão fixa aqui).',
        },
        {
          anchor: "webhooks.webpush.convite-preview",
          label: "Pré-visualização",
          what: "Mostra como o convite vai aparecer para o visitante, atualizando a cada alteração nos campos ao lado.",
        },
      ],
    },
  ],

  states: [
    {
      id: "plataforma-acesso-negado",
      title: "Acesso administrativo necessário",
      what: 'Mensagem mostrada no lugar de toda a aba Plataforma de apostas para quem não é administrador da casa: "Os endereços e as chaves que a plataforma de apostas usa para enviar dados são vistos só pelos administradores da casa."',
      action: "Peça a um administrador da casa para configurar a integração com a plataforma.",
    },
    {
      id: "plataforma-erro-endereco",
      title:
        "Não foi possível carregar os endereços de integração da sua casa. Recarregue a página ou contate o suporte.",
      what: 'Mensagem mostrada no lugar do endereço base quando a chave da casa não carrega e a casa não é a de demonstração (na demonstração aparece "Nenhum dado neste ambiente de demonstração").',
      action: "Recarregue a página; se persistir, contate o suporte.",
    },
    {
      id: "plataforma-sem-recebimentos",
      title: "Nada recebido ainda",
      what: 'Mensagem mostrada em "Últimos recebimentos" quando a casa nunca recebeu nenhum envio da plataforma. Abaixo aparece "Os dados enviados pela plataforma de apostas vão aparecer aqui em tempo real." (na casa de demonstração, "Nenhum dado neste ambiente de demonstração").',
    },
    {
      id: "webpush-nao-ativado",
      title: "Web Push ainda não ativado",
      what: 'Mensagem mostrada no lugar do assistente quando a casa ainda não tem nenhuma origem ativada para o Web Push: "O Web Push ainda não foi ativado para esta casa. Fale com a Betleads."',
      action: "Fale com a Betleads para ativar o Web Push para a casa.",
    },
    {
      id: "links-erro-numeros",
      title: "Não foi possível carregar os números de links. Tente de novo em instantes.",
      what: 'Mensagem mostrada no cartão "Por canal e origem" quando a busca dos números falha.',
      action: "Recarregue a página ou tente de novo em alguns instantes.",
    },
    {
      id: "links-sem-envios",
      title: "Nenhum link enviado nos últimos 30 dias.",
      what: 'Mensagem mostrada no cartão "Por canal e origem" quando a casa ainda não enviou nenhum link curto no período.',
    },
    {
      id: "links-sem-envios-demo",
      title: "Nenhum dado neste ambiente de demonstração",
      what: 'A mesma situação acima ("nenhum link enviado"), mas na casa de demonstração: em vez do texto "Nenhum link enviado nos últimos 30 dias.", o cartão "Por canal e origem" mostra este aviso, igual em toda tela do CRM que lista algo vazio num ambiente de demonstração.',
    },
    {
      id: "links-nao-admin",
      title: "Não foi possível abrir as configurações de links",
      what: 'Cartão mostrado no lugar do formulário de configuração para quem não é administrador da casa — o servidor só responde a pedidos de admin. Abaixo do título aparece "Esta área é do administrador da casa. Se você é admin, tente de novo em instantes."',
      action: "Peça a um administrador da casa para ajustar a configuração de links curtos.",
    },
  ],

  tours: {
    plataforma: [
      {
        anchor: "webhooks.plataforma.cartoes",
        title: "Recebimentos das últimas 24h",
        body: "Quantos envios chegaram, quantos foram registrados e quantos precisam de atenção.",
        articleSection: "plataforma",
      },
      {
        anchor: "webhooks.plataforma.endereco-base",
        title: "Endereço base",
        body: "O endereço comum usado por todos os eventos — exclusivo desta casa.",
        articleSection: "plataforma",
      },
      {
        anchor: "webhooks.plataforma.eventos",
        title: "Endereços de integração",
        body: "Um endereço por evento (cadastro, depósito, saque...), agrupados por categoria.",
        articleSection: "plataforma",
      },
      {
        anchor: "webhooks.plataforma.recebimentos",
        title: "Últimos recebimentos",
        body: "A lista dos últimos envios, em tempo real. Clique numa linha para ver os dados recebidos.",
        articleSection: "plataforma",
      },
      {
        anchor: "webhooks.plataforma.seguranca",
        title: "Segurança avançada",
        body: "A assinatura que comprova que o envio veio mesmo da plataforma.",
        articleSection: "plataforma",
      },
      {
        anchor: "webhooks.plataforma.chave",
        title: "Chave de assinatura",
        body: "Gere (ou troque) a chave que a plataforma usa para assinar os envios.",
        articleSection: "plataforma",
      },
      {
        anchor: "webhooks.plataforma.exigir",
        title: "Exigir assinatura",
        body: "Só ative depois que a plataforma já estiver assinando os envios com a chave atual.",
        articleSection: "plataforma",
      },
    ],
    links: [
      {
        anchor: "webhooks.links.enabled",
        title: "Ativar links curtos",
        body: "Liga o encurtamento dos links das mensagens, para o CRM contar quem clica em cada envio.",
        articleSection: "links",
      },
      {
        anchor: "webhooks.links.dominio-link",
        title: "Domínio do encurtador",
        body: "O domínio próprio usado nos links fica em Configuração da casa, na aba Encurtador.",
        articleSection: "links",
      },
      {
        anchor: "webhooks.links.hosts",
        title: "Sites permitidos",
        body: "Limite o encurtador a estes sites, separados por vírgula. Em branco, vale para qualquer site.",
        articleSection: "links",
      },
      {
        anchor: "webhooks.links.ttl",
        title: "Validade do link",
        body: "Quantos dias um link curto continua funcionando. Em branco, nunca expira.",
        articleSection: "links",
      },
      {
        anchor: "webhooks.links.fallback",
        title: "Se o encurtador falhar",
        body: "Escolha bloquear o envio ou mandar a mensagem com o link original quando o encurtador não responder.",
        articleSection: "links",
      },
      {
        anchor: "webhooks.links.save",
        title: "Salvar",
        body: "Grava a configuração de links curtos desta casa.",
        articleSection: "links",
      },
    ],
    meta: [
      {
        anchor: "webhooks.meta.progresso",
        title: "Progresso da conexão",
        body: "Conectar, escolher as contas, a primeira leitura e Pronto.",
        articleSection: "meta",
      },
      {
        anchor: "webhooks.meta.adicionar",
        title: "Adicionar Usuário do Sistema",
        body: "Conecte outra chave para somar mais BMs e contas.",
        articleSection: "meta",
      },
      {
        anchor: "webhooks.meta.sincronizar",
        title: "Sincronizar agora",
        body: "Pede uma releitura das contas marcadas sem esperar a próxima automática.",
        articleSection: "meta",
      },
      {
        anchor: "webhooks.meta.chaves",
        title: "Chaves conectadas",
        body: "Cada cartão mostra o que a chave alcança, a validade e a saúde da conexão.",
        articleSection: "meta",
      },
      {
        anchor: "webhooks.meta.contas",
        title: "Contas de anúncio",
        body: "Só as contas marcadas entram nos relatórios de Aquisição e LTV.",
        articleSection: "meta",
      },
      {
        anchor: "webhooks.meta.alteracoes",
        title: "Alterações não salvas",
        body: "Marcar ou desmarcar contas só vale depois de salvar.",
        articleSection: "meta",
      },
      {
        anchor: "webhooks.meta.historico",
        title: "Histórico de sincronizações",
        body: "As últimas leituras da Meta, com o resultado de cada conta.",
        articleSection: "meta",
      },
    ],
    webpush: [
      {
        anchor: "webhooks.webpush.abas",
        title: "Assistente e Convite",
        body: "O Assistente instala e testa o Web Push; o Convite configura o pedido de permissão.",
        articleSection: "webpush",
      },
      {
        anchor: "webhooks.webpush.modo-instalacao",
        title: "Plataforma ou manual",
        body: "Se o backoffice já tem a integração, só cole o token; senão, instale à mão.",
        articleSection: "webpush",
      },
      {
        anchor: "webhooks.webpush.copiar-instrucoes",
        title: "Instruções para o suporte",
        body: "Copie tudo que o suporte do site precisa num só chamado.",
        articleSection: "webpush",
      },
      {
        anchor: "webhooks.webpush.status",
        title: "Status da instalação",
        body: "Confira se o arquivo e o script já foram detectados no site.",
        articleSection: "webpush",
      },
      {
        anchor: "webhooks.webpush.proxima-etapa",
        title: "Próxima etapa",
        body: "Avança para o teste depois do arquivo e do script confirmados.",
        articleSection: "webpush",
      },
      {
        anchor: "webhooks.webpush.teste",
        title: "Teste",
        body: "Aceite as notificações no site e envie um push de teste para confirmar.",
        articleSection: "webpush",
      },
      {
        anchor: "webhooks.webpush.concluido",
        title: "Web Push concluído",
        body: "O resumo de cada site já verificado, com as inscrições ativas.",
        articleSection: "webpush",
      },
      {
        anchor: "webhooks.webpush.convite-texto",
        title: "Texto do convite",
        body: "O que a pessoa vê quando o navegador pede permissão para notificações.",
        articleSection: "webpush",
      },
    ],
  },
};

export default screen;
