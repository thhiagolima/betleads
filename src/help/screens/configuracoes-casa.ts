// Help article for "Configuração da casa" (/configuracoes/casa), três abas:
// Casa, Encurtador e E-mail. É a tela onde o domínio/DNS e o remetente de
// e-mail travam com mais frequência — por isso cada erro e cada estado
// aparecem em detalhe. Fonte: src/routes/configuracoes_.casa.tsx e os
// componentes em src/components/house-config/ (house-site-section,
// link-domain-dialog, domains-section, domain-detail, email-senders-section),
// mais as mensagens de erro de src/lib/house-config.functions.ts,
// src/lib/tenant-domains.server.ts e src/lib/house-config.ts.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "configuracoes-casa",
  route: "/configuracoes/casa",
  defaultTab: "casa",
  title: "Configuração da casa",
  purpose:
    "Endereço do site da casa, atalhos usados em campanhas e jornadas, os domínios próprios do encurtador de links e de e-mail (com o DNS de cada um) e os remetentes que enviam os e-mails.",
  roles: ["admin", "gestor", "member", "expert"],
  terms: ["dns", "subdominio", "registro-dns", "remetente", "encurtador"],
  sections: [
    // ---------------------------------------------------------------
    // Aba Casa
    // ---------------------------------------------------------------
    {
      id: "casa",
      title: "Casa",
      tab: "casa",
      intro:
        "URL do site da casa e os atalhos ('URLs rápidas') usados em campanhas e jornadas. Só o administrador da casa pode editar; os outros perfis veem os mesmos campos travados.",
      items: [
        {
          anchor: "casa.site.url",
          label: "URL da casa",
          what: "O endereço do site da casa, por exemplo https://suacasa.bet.br. É usado como base para as URLs rápidas e para sugerir o domínio do encurtador.",
          notes:
            "Aceita colar com ou sem \"https://\" — o sistema completa. Erros possíveis: \"Informe a URL do site\" (campo vazio) e \"URL inválida\" (texto que não forma um endereço válido).",
        },
        {
          anchor: "casa.site.save",
          label: "Salvar",
          what: "Grava a nova URL da casa.",
          roles: ["admin"],
          notes:
            "Se a URL mudar de domínio (por exemplo de casa-antiga.bet.br para suacasa.bet.br), o CRM compara o domínio antigo com o novo por conta própria e, quando encontra jornadas, templates ou URLs rápidas que ainda usam o domínio antigo, abre sozinho o diálogo \"Trocar domínio nos links\" já com a prévia pronta — sem precisar clicar em nada.",
        },
        {
          anchor: "casa.site.troca-dominio",
          label: "Trocar domínio nos links",
          what: "Abre o mesmo diálogo manualmente, para procurar e trocar um domínio em jornadas, templates de SMS/e-mail e URLs rápidas sem precisar mudar a URL da casa antes.",
          roles: ["admin"],
          notes:
            "Útil quando o domínio mudou há algum tempo e ainda sobraram links antigos espalhados, ou quando só o domínio do encurtador mudou (não o site).",
        },
        {
          anchor: "casa.quick-links.add",
          label: "Adicionar (URLs rápidas)",
          what: "Cria uma nova linha em branco para cadastrar mais um atalho (nome + caminho), como \"Depósito\" → \"/deposito\".",
          roles: ["admin"],
          notes:
            "Ao abrir a aba por 1ª vez sem nenhuma URL rápida salva, o CRM já sugere algumas linhas prontas (Login, Depósito, Promoção...) como dica — elas só são gravadas de fato quando você editar e clicar em \"Salvar URLs rápidas\".",
        },
        {
          anchor: "casa.quick-links.label",
          label: "Nome da URL rápida",
          what: "O nome do atalho, como \"Login\" ou \"Depósito\". É o que aparece para escolher ao montar uma campanha ou jornada.",
          roles: ["admin"],
        },
        {
          anchor: "casa.quick-links.path",
          label: "Caminho da URL rápida",
          what: "O caminho depois do domínio da casa, como \"/login\". Junto com a URL da casa, forma o link completo.",
          roles: ["admin"],
        },
        {
          anchor: "casa.quick-links.remove",
          label: "Remover (ícone de lixeira)",
          what: "Apaga essa linha da lista. Repete-se em cada URL rápida cadastrada; a âncora marca só a primeira.",
          roles: ["admin"],
        },
        {
          anchor: "casa.quick-links.save",
          label: "Salvar URLs rápidas",
          what: "Grava a lista de URLs rápidas.",
          roles: ["admin"],
          notes:
            'Se alguma linha tiver só o nome ou só o caminho preenchido, a gravação é bloqueada com o erro "Preencha o nome e o caminho de todas as URLs rápidas." Uma linha deixada totalmente em branco (criada por engano) é descartada em silêncio, sem erro.',
        },
        {
          label: "Diálogo \"Trocar domínio nos links\" — passo 1 (Domínio antigo / Domínio novo)",
          what: 'Dois campos de texto, "Domínio antigo" e "Domínio novo", e o botão "Procurar", que lista tudo que a casa tem com o domínio antigo: etapas de jornada, templates de SMS, templates de e-mail, URLs rápidas e (se existir) a lista de domínios permitidos do rastreio de links.',
          notes:
            "Quando o diálogo abre sozinho (depois de salvar uma nova URL da casa), esses dois campos já vêm preenchidos e o diálogo pula direto para o passo 2 com a prévia pronta.",
        },
        {
          label: "Diálogo \"Trocar domínio nos links\" — passo 2 (prévia e seleção)",
          what: 'A lista encontrada aparece agrupada por tipo (Jornadas, Templates de SMS, Templates de e-mail, URLs rápidas), cada item com uma caixinha marcada por padrão, um "antes → depois" do texto e, quando existir, um aviso de que a troca aumenta o número de partes do SMS (rastreio desligado) por cruzar um limite de caracteres. Um item sem caixinha (travado) tem um motivo escrito ao lado — por exemplo, está fora do alcance desta troca. Quando a casa tem uma lista de domínios permitidos para o rastreio de links, aparece também uma seção "Domínios permitidos do rastreio" com uma única caixinha (marcada por padrão) mostrando "domínios atuais → domínios novos" — ela decide se esse domínio também é adicionado à lista de domínios liberados para o rastreio, além de ser trocado nos links; desmarcá-la tira esse domínio da contagem de "Trocar N itens" (a lista de rastreio simplesmente não muda) sem afetar as outras caixinhas. Uma seção à parte, "Ainda com <domínio> (não trocados aqui)", lista campanhas agendadas, fluxos antigos e links em subdomínio que continuam com o domínio antigo mesmo depois da troca. Os botões são "Voltar" (volta ao passo 1) e "Trocar N itens" (abre a confirmação), onde N conta os itens marcados mais a caixinha do rastreio, quando marcada.',
          notes:
            "Sem nenhum item com esse domínio, aparece só o texto \"Nenhum link com <domínio> encontrado.\"",
        },
        {
          label: "Confirmação \"Trocar domínio nos links\"",
          what: 'Pergunta "Trocar o domínio em N itens? Isso não pode ser desfeito automaticamente." com os botões "Cancelar" e "Trocar".',
          roles: ["admin"],
          notes:
            "A troca em si é imediata nos registros do CRM; não há um \"desfazer\" de um clique — para voltar atrás é preciso repetir o processo trocando o domínio novo pelo antigo de novo.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Encurtador
    // ---------------------------------------------------------------
    {
      id: "encurtador",
      title: "Encurtador",
      tab: "encurtador",
      intro:
        "Domínio próprio do encurtador de links (o que aparece nos SMS e e-mails em vez do domínio padrão do CRM). Sem domínio verificado, os links continuam saindo pelo encurtador padrão do CRM — nada para de funcionar.",
      items: [
        {
          anchor: "casa.encurtador.hostname",
          label: "Campo do novo domínio (ex.: go.suacasa.bet.br)",
          what: "Onde você digita o subdomínio que vai hospedar os links curtos.",
          roles: ["admin"],
          notes:
            "Pode ser o domínio raiz da casa (ex.: suacasa.bet.br) ou um subdomínio dele (ex.: go.suacasa.bet.br) — usar um subdomínio dedicado ao encurtador é a prática recomendada, porque libera o domínio raiz para o site.",
        },
        {
          anchor: "casa.encurtador.add-domain",
          label: "Adicionar domínio",
          what: "Cadastra o domínio digitado e gera os registros DNS que faltam colar no provedor onde o domínio foi comprado.",
          roles: ["admin"],
          notes:
            'Erros possíveis: "Informe um domínio" (campo vazio) e "Domínio inválido" (endereço IP, "localhost" ou texto que não forma um domínio); "Esse é o domínio do site da casa — use um subdomínio, ex.: go.<domínio>" (tentou cadastrar exatamente a URL da casa como encurtador); "Esse domínio é reservado da plataforma e não pode ser usado pela casa." (é um domínio do próprio CRM); "Esse domínio já está em uso por outra conta" (outra casa já cadastrou esse domínio); "Esse domínio já está cadastrado no provedor." / "O provedor recusou esse domínio. Confira se o nome está correto." / "O provedor está indisponível no momento. Tente novamente em alguns minutos." (respostas do Short.io, o provedor do encurtador).',
        },
        {
          anchor: "casa.dominio.card",
          label: "Cartão do domínio",
          what: 'Um cartão por domínio cadastrado, com o nome do domínio, quando foi verificado por último, o selo de status ("Padrão" quando é o domínio em uso e o status "Aguardando DNS" / "Verificado" / "Falhou"), a tabela de registros DNS e os botões de ação.',
        },
        {
          anchor: "casa.dominio.status",
          label: "Selo de status",
          what: '"Aguardando DNS" (ainda não verificado), "Verificado" (pronto para usar) ou "Falhou" (a última checagem não encontrou o registro esperado). O selo "Padrão" aparece ao lado quando esse é o domínio ativo.',
        },
        {
          anchor: "casa.dominio.dns-table",
          label: "Tabela de registros DNS",
          what: 'Cada linha é um registro DNS que precisa ser colado no painel do domínio: Tipo (A ou CNAME), Nome, Valor e Situação ("ok", "pendente" ou "—" quando ainda não foi checado).',
          notes:
            'Quando o domínio é a raiz (ex.: suacasa.bet.br, sem nada na frente), o registro é do tipo A com Nome "@" — "@" é a forma padrão de dizer "o próprio domínio, sem subdomínio" num painel de DNS. Quando o domínio é um subdomínio (ex.: go.suacasa.bet.br), o registro é do tipo CNAME e o Nome é só a parte antes do domínio da casa (ex.: "go") — o painel do domínio já entende que isso é go.suacasa.bet.br.',
        },
        {
          anchor: "casa.dominio.copy",
          label: "Copiar valor (ícone)",
          what: "Copia o valor daquele registro para a área de transferência, para colar direto no painel do domínio. Repete-se em cada linha; a âncora marca só a primeira.",
        },
        {
          anchor: "casa.dominio.next-check",
          label: "Próxima verificação automática / Próxima checagem",
          what: 'Quando o CRM vai checar esse domínio de novo sozinho, sem precisar clicar em nada. Mostra só a hora quando é hoje, a data e a hora quando é outro dia, e "em instantes" quando a hora marcada já chegou (a checagem roda na próxima passada automática).',
          notes:
            "O calendário automático: a cada 10 minutos nas primeiras 6 horas depois de cadastrar o domínio; depois, de hora em hora até completar 72 horas; depois disso, uma vez por dia. Um domínio já verificado é checado 1x por dia, só para confirmar que continua certo.",
        },
        {
          anchor: "casa.dominio.verify",
          label: "Verificar agora",
          what: "Checa o DNS na hora, sem esperar a próxima verificação automática.",
          roles: ["admin"],
          notes:
            'Mostra "Verificando…" enquanto checa. Se o domínio tiver sido apagado do lado do provedor (Short.io ou Infobip) por fora do CRM, a checagem encontra "Domínio não encontrado no provedor." e esse texto passa a aparecer na faixa de erro do cartão, abaixo do nome do domínio — a mesma faixa onde aparece o motivo de um "Falhou". Nesse caso, remova o domínio aqui e cadastre-o de novo do zero. A mesma checagem (e o mesmo erro) também pode acontecer sozinha, na verificação automática — veja "Próxima verificação automática".',
        },
        {
          anchor: "casa.dominio.send-instructions",
          label: "Enviar instruções por e-mail",
          what: 'Abre um diálogo para mandar os registros DNS deste domínio por e-mail a quem cuida do DNS da casa (que pode não ser quem está usando o CRM). O diálogo tem o campo "E-mail de destino" e o botão "Enviar".',
          roles: ["admin"],
          notes:
            'Erro possível: "Limite de envios atingido para este domínio. Tente novamente mais tarde." — há um limite de quantos envios de instrução cabem por domínio em um período, para não virar uma forma de disparar e-mails em massa.',
        },
        {
          anchor: "casa.dominio.set-default",
          label: "Definir como padrão",
          what: "Passa a usar este domínio nos novos links curtos gerados pelo CRM.",
          roles: ["admin"],
          notes:
            'Fica desabilitado até o domínio ficar "Verificado" — não existe "padrão" de um domínio que ainda não está funcionando. Passando o mouse (ou, no teclado/leitor de tela, pelo motivo associado ao botão) aparece "Disponível depois que o domínio for verificado".',
        },
        {
          anchor: "casa.dominio.remove",
          label: "Remover",
          what: 'Abre a confirmação "Remover domínio", com os botões "Cancelar" e "Remover": o domínio some dos novos envios, mas continua existindo no provedor; campanhas e jornadas já agendadas passam a usar o domínio padrão da casa no lugar. Quando o domínio está em uso, a confirmação lista em quais campanhas/jornadas.',
          roles: ["admin"],
          notes:
            "Isso não apaga o domínio do provedor (Short.io) — só para de usá-lo em envios novos. Apagar de fato no provedor é uma ação de super admin, feita a partir da lista de \"Domínios removidos\", fora desta tela.",
        },
        {
          label: "Registradores: onde colar o DNS, propagação e o que fazer com \"Falhou\"",
          what: 'Cada provedor de domínio chama a tela de DNS por um nome diferente, mas o caminho é parecido: Registro.br → "Painel de controle" do domínio → "DNS" ou "Editar zona", e adicionar um "novo registro" com o Tipo/Nome/Valor da tabela. Cloudflare → o domínio → aba "DNS" → "Add record"; para o CNAME do encurtador, a nuvem ao lado do registro precisa ficar cinza/desligada ("DNS only"), não laranja ("Proxied") — com o proxy ligado, a verificação nunca funciona. GoDaddy → "Meus produtos" → o domínio → "DNS" → "Adicionar" um registro. Hostinger → "Domínios" → o domínio → "DNS / Nameservers" → "Adicionar registro".',
          notes:
            'A mudança no DNS pode levar de minutos a algumas horas para valer em todo lugar ("propagação") — "Aguardando DNS" pouco depois de colar o registro é normal, não é erro. O CRM confere sozinho no calendário descrito em "Próxima verificação automática" (10 em 10 minutos nas primeiras 6 horas, de hora em hora até 72 horas, depois 1x por dia) — não precisa ficar clicando em "Verificar agora". Quando aparece "Falhou", a última checagem não encontrou o registro esperado (ou encontrou um valor diferente); confira se o registro foi colado no domínio e no "Nome" certos, sem espaços extras, e sem outro registro do mesmo tipo e nome conflitando — depois disso, a próxima checagem automática (ou "Verificar agora") resolve sozinha.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba E-mail
    // ---------------------------------------------------------------
    {
      id: "email",
      title: "E-mail",
      tab: "email",
      intro:
        "Domínio próprio de e-mail (para enviar com @suacasa.bet.br em vez de um domínio genérico) e os remetentes que de fato mandam as campanhas e jornadas por e-mail.",
      items: [
        {
          anchor: "casa.email.hostname",
          label: "Campo do novo domínio (ex.: mail.suacasa.bet.br)",
          what: "Onde você digita o domínio ou subdomínio que vai enviar os e-mails da casa.",
          roles: ["admin"],
        },
        {
          anchor: "casa.email.add-domain",
          label: "Adicionar domínio",
          what: "Cadastra o domínio de e-mail e gera os registros DNS (geralmente mais de um — autenticação do remetente costuma exigir vários registros, diferente do encurtador) que precisam ser colados no provedor do domínio.",
          roles: ["admin"],
          notes:
            'As mesmas mensagens de erro do encurtador se aplicam aqui: "Informe um domínio", "Domínio inválido", "Esse domínio é reservado da plataforma e não pode ser usado pela casa.", "Esse domínio já está em uso por outra conta", "Esse domínio já está cadastrado no provedor.", "O provedor recusou esse domínio. Confira se o nome está correto." e "O provedor está indisponível no momento. Tente novamente em alguns minutos." (aqui o provedor é a Infobip, não o Short.io).',
        },
        {
          anchor: "casa.dominio.card",
          label: "Cartão do domínio de e-mail",
          what: "O mesmo cartão explicado na aba Encurtador: nome do domínio, status, tabela de registros DNS e os botões Verificar agora / Enviar instruções por e-mail / Definir como padrão / Remover.",
          notes:
            'Veja a aba "Encurtador" para o detalhe de cada registro DNS, o calendário de verificação e o item dedicado aos registradores (Registro.br, Cloudflare, GoDaddy, Hostinger) — vale do mesmo jeito para o domínio de e-mail.',
        },
        {
          anchor: "casa.remetente.list",
          label: "Lista de remetentes cadastrados",
          what: 'Cada remetente mostra "Nome do remetente <endereço@dominio>" e o selo "Padrão" quando é o remetente usado por padrão nas campanhas e jornadas.',
          notes:
            'Um remetente cujo domínio não está mais verificado mostra o aviso "Domínio ainda não verificado" abaixo do nome — ele continua cadastrado, mas os envios por ele vão falhar até o domínio voltar a ficar verificado.',
        },
        {
          anchor: "casa.remetente.hint",
          label: 'Aviso "Domínio verificado. Agora crie um remetente..."',
          what: 'Aparece só quando já existe um domínio de e-mail verificado e ainda não existe nenhum remetente. Clicar nele rola a tela até o formulário de remetente e já coloca o cursor no campo "Endereço".',
          roles: ["admin"],
        },
        {
          anchor: "casa.remetente.remove",
          label: "Remover (remetente)",
          what: 'Pede confirmação ("Remover remetente?", com os botões "Cancelar" e "Remover remetente") antes de apagar — o texto explica que o remetente deixa de poder ser usado em novas campanhas e jornadas de e-mail. Repete-se em cada remetente; a âncora marca só o primeiro.',
          roles: ["admin"],
          notes:
            "Campanhas e jornadas que já foram enviadas com esse remetente não são afetadas; só os envios futuros deixam de poder escolhê-lo.",
        },
        {
          anchor: "casa.remetente.domain",
          label: "Domínio de e-mail (seletor)",
          what: "Escolhe, entre os domínios de e-mail já cadastrados nesta casa, qual vai hospedar o novo remetente.",
          roles: ["admin"],
          notes:
            'Erro possível ao salvar: "Selecione um domínio de e-mail da casa." — acontece se o domínio escolhido não existir mais ou não for um domínio de e-mail (não deveria aparecer no uso normal, só se o cadastro ficou desatualizado).',
        },
        {
          anchor: "casa.remetente.local-part",
          label: "Endereço",
          what: 'A parte antes do "@" do endereço de e-mail do remetente, por exemplo "promo" para formar promo@suacasa.bet.br. O domínio escolhido acima aparece ao lado, depois do "@".',
          roles: ["admin"],
          notes:
            'Erro possível: "Não foi possível formar um e-mail de remetente válido com esse valor." quando o texto digitado, junto com o domínio, não forma um e-mail válido (por exemplo com espaço ou acento).',
        },
        {
          anchor: "casa.remetente.from-name",
          label: "Nome do remetente",
          what: 'O nome que aparece como quem enviou o e-mail na caixa de entrada do jogador, por exemplo "Promo SuaCasa".',
          roles: ["admin"],
          notes:
            'Não confunda com o campo "Nome do remetente" que existe dentro do editor de template de e-mail (tela /email): aquele é só um texto de exemplo/prévia dentro do template e pode ser editado por campanha; o remetente cadastrado aqui é quem de fato envia — o endereço real e o nome que vão no e-mail, válido para todas as campanhas e jornadas que o usarem.',
        },
        {
          anchor: "casa.remetente.reply-to",
          label: "Responder para (opcional)",
          what: "Um endereço de e-mail diferente para onde as respostas do jogador vão, quando ele responde ao e-mail recebido. Deixe em branco para as respostas irem para o próprio endereço do remetente.",
          roles: ["admin"],
        },
        {
          anchor: "casa.remetente.default",
          label: "Remetente padrão",
          what: "Marca este remetente como o escolhido automaticamente ao criar uma campanha ou jornada de e-mail nova.",
          roles: ["admin"],
          notes: "Marcar um remetente como padrão desmarca automaticamente o que era padrão antes — só existe um por vez.",
        },
        {
          anchor: "casa.remetente.save",
          label: "Salvar remetente",
          what: "Grava o remetente (ou as alterações, se estiver editando um já existente).",
          roles: ["admin"],
          notes:
            'Fica desabilitado até escolher um domínio, preencher o endereço e o nome do remetente. Mesmo salvando com sucesso, se o domínio escolhido ainda não estiver verificado o remetente é gravado, mas mostra "Domínio ainda não verificado" até o DNS passar a verificação.',
        },
      ],
    },
  ],

  states: [
    {
      id: "nao-admin",
      title: "Só o administrador da casa pode alterar estas configurações.",
      what: "Aviso mostrado no topo da tela para quem não é administrador da conta — todos os campos e botões de escrita ficam desabilitados, mas tudo continua visível para consulta.",
      action: "Peça a um administrador da casa para fazer a alteração, ou peça para ser promovido a administrador em Configurações → Usuários.",
    },
    {
      id: "sem-dominio",
      title: "Nenhum domínio cadastrado ainda.",
      what: "Texto mostrado nas abas Encurtador e E-mail quando a casa ainda não cadastrou nenhum domínio daquele tipo.",
      action: 'Cadastre um domínio no campo "Adicionar domínio" da aba.',
    },
    {
      id: "sem-remetente",
      title: "Nenhum remetente cadastrado ainda.",
      what: "Texto mostrado na aba E-mail quando a casa ainda não tem nenhum remetente cadastrado.",
      action: 'Verifique um domínio de e-mail e depois preencha o formulário de remetente abaixo.',
    },
    {
      id: "encurtador-pendente",
      title: "Seu domínio personalizado ainda não foi verificado — os links estão saindo pelo encurtador padrão do CRM.",
      what: 'Aviso mostrado no topo da aba Encurtador quando existe pelo menos um domínio do encurtador aguardando DNS ou com falha, e nenhum verificado ainda. Nada para de funcionar enquanto isso: os links continuam saindo, só que com o domínio padrão do CRM em vez do domínio próprio da casa.',
      action: "Finalize a verificação do DNS do domínio personalizado (veja o item dos registradores).",
    },
    {
      id: "dominio-aguardando-dns",
      title: "Aguardando DNS",
      what: "O domínio foi cadastrado, mas a última checagem ainda não encontrou o registro DNS esperado.",
      action: "Confira se o registro foi colado certo no provedor; a verificação automática tenta de novo sozinha.",
    },
    {
      id: "dominio-verificado",
      title: "Verificado",
      what: "O DNS do domínio está correto e o domínio já pode ser usado (inclusive marcado como padrão).",
    },
    {
      id: "dominio-falhou",
      title: "Falhou",
      what: "A última checagem automática encontrou um problema no DNS (registro ausente ou com valor diferente do esperado) — o motivo exato aparece no cartão do domínio, abaixo do nome.",
      action: 'Corrija o registro no provedor do domínio seguindo o item dos registradores e aguarde a próxima verificação (ou clique em "Verificar agora").',
    },
    {
      id: "remetente-dominio-nao-verificado",
      title: "Domínio ainda não verificado",
      what: "Aviso sob um remetente cujo domínio de e-mail deixou de estar verificado (ou nunca chegou a verificar). Os envios por esse remetente falham enquanto isso durar.",
      action: "Verifique o domínio de e-mail na aba Encurtador/E-mail correspondente — o remetente volta a funcionar sozinho depois disso.",
    },
    {
      id: "dica-criar-remetente",
      title: "Domínio verificado. Agora crie um remetente para enviar campanhas e jornadas por e-mail.",
      what: "Dica mostrada quando a casa já tem um domínio de e-mail verificado, mas ainda nenhum remetente cadastrado.",
      action: "Clique na dica para ir direto ao formulário de remetente.",
    },
  ],

  tours: {
    casa: [
      {
        anchor: "casa.site.url",
        title: "URL da casa",
        body: "O endereço do site da sua casa. É usado para sugerir o domínio do encurtador e montar as URLs rápidas.",
        articleSection: "casa",
      },
      {
        anchor: "casa.site.save",
        title: "Salvar a URL",
        body: "Grava a URL. Se o domínio mudar, o CRM pode abrir sozinho o diálogo para trocar o domínio nos links antigos.",
        articleSection: "casa",
      },
      {
        anchor: "casa.site.troca-dominio",
        title: "Trocar domínio nos links",
        body: "Procura e troca um domínio antigo por um novo em jornadas, templates e URLs rápidas, sem precisar mudar a URL da casa.",
        articleSection: "casa",
      },
      {
        anchor: "casa.quick-links.add",
        title: "URLs rápidas",
        body: "Atalhos como Login e Depósito, usados ao montar campanhas e jornadas. Clique aqui para adicionar um novo.",
        articleSection: "casa",
      },
      {
        anchor: "casa.quick-links.label",
        title: "Nome e caminho",
        body: "Dê um nome e o caminho do atalho (ex.: Depósito → /deposito). Os dois precisam estar preenchidos.",
        articleSection: "casa",
      },
      {
        anchor: "casa.quick-links.save",
        title: "Salvar URLs rápidas",
        body: "Grava a lista de atalhos.",
        articleSection: "casa",
      },
    ],
    encurtador: [
      {
        anchor: "casa.encurtador.hostname",
        title: "Domínio do encurtador",
        body: "Digite o domínio ou subdomínio (ex.: go.suacasa.bet.br) que vai hospedar os links curtos da casa.",
        articleSection: "encurtador",
      },
      {
        anchor: "casa.encurtador.add-domain",
        title: "Adicionar domínio",
        body: "Cadastra o domínio e gera os registros DNS para colar no provedor onde ele foi comprado.",
        articleSection: "encurtador",
      },
      {
        anchor: "casa.dominio.dns-table",
        title: "Registros DNS",
        body: "Copie cada registro e cole no painel do seu domínio (Registro.br, Cloudflare, GoDaddy, Hostinger...).",
        articleSection: "encurtador",
      },
      {
        anchor: "casa.dominio.verify",
        title: "Verificar agora",
        body: "A verificação é automática, mas você pode forçar uma checagem imediata aqui.",
        articleSection: "encurtador",
      },
      {
        anchor: "casa.dominio.send-instructions",
        title: "Enviar instruções por e-mail",
        body: "Não cuida do DNS pessoalmente? Mande os registros por e-mail para quem cuida.",
        articleSection: "encurtador",
      },
      {
        anchor: "casa.dominio.set-default",
        title: "Definir como padrão",
        body: "Depois de verificado, marque este domínio como o padrão para os novos links curtos.",
        articleSection: "encurtador",
      },
      {
        anchor: "casa.dominio.remove",
        title: "Remover",
        body: "Tira o domínio dos novos envios sem apagá-lo do provedor.",
        articleSection: "encurtador",
      },
    ],
    email: [
      {
        anchor: "casa.email.hostname",
        title: "Domínio de e-mail",
        body: "Digite o domínio ou subdomínio (ex.: mail.suacasa.bet.br) que vai enviar os e-mails da casa.",
        articleSection: "email",
      },
      {
        anchor: "casa.email.add-domain",
        title: "Adicionar domínio",
        body: "Cadastra o domínio e gera os registros DNS para colar no provedor onde ele foi comprado.",
        articleSection: "email",
      },
      {
        anchor: "casa.dominio.dns-table",
        title: "Registros DNS",
        body: "Copie cada registro e cole no painel do seu domínio. Pode levar algumas horas para valer.",
        articleSection: "email",
      },
      {
        anchor: "casa.remetente.domain",
        title: "Escolha o domínio do remetente",
        body: "Depois do domínio verificado, escolha-o aqui para criar o primeiro remetente.",
        articleSection: "email",
      },
      {
        anchor: "casa.remetente.local-part",
        title: "Endereço do remetente",
        body: "A parte antes do @ do e-mail que vai enviar as campanhas, por exemplo \"promo\".",
        articleSection: "email",
      },
      {
        anchor: "casa.remetente.from-name",
        title: "Nome do remetente",
        body: "O nome que aparece na caixa de entrada do jogador como quem enviou.",
        articleSection: "email",
      },
      {
        anchor: "casa.remetente.save",
        title: "Salvar remetente",
        body: "Grava o remetente. Ele já pode ser usado em campanhas e jornadas de e-mail.",
        articleSection: "email",
      },
    ],
  },
};

export default screen;
