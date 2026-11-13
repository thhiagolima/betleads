// Help article for "Email" (/email), três abas: Visão geral, Templates e
// Histórico. Fonte: src/routes/email.tsx, src/components/channels/channel-page.tsx
// e channel-overview.tsx (barra compartilhada com SMS/Ligações, prefixo
// "canal."), src/components/email/quick-editor-dialog.tsx,
// src/components/email/template-editor-dialog.tsx (+ template-presets.ts),
// src/components/history/history-shell.tsx (prefixo neutro "historico.",
// reaproveitado por telas futuras), src/components/providers-paused-banner.tsx,
// e src/components/billing/{active-tenant-wallet-notice,wallet-balance-notice}.tsx.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "email",
  route: "/email",
  defaultTab: "visao-geral",
  title: "Email",
  purpose:
    "Visão geral dos envios de e-mail, os templates usados em campanhas e jornadas (com dois jeitos de criar: Editor Rápido e Editor Avançado) e o histórico completo de envios.",
  roles: ["admin", "gestor", "member"],
  terms: ["cta", "preheader", "hero", "alt-text", "remetente"],
  sections: [
    // ---------------------------------------------------------------
    // Barra superior — compartilhada com /sms e /ligacoes (prefixo "canal.")
    // ---------------------------------------------------------------
    {
      id: "canal",
      title: "Barra superior (aparece nas 3 abas)",
      intro:
        "Esta faixa é a mesma em /email, /sms e /ligações: o botão de nova campanha, o aviso de disparos pausados e o aviso de saldo. Fica acima das abas e não muda quando você troca de aba.",
      items: [
        {
          anchor: "canal.header.nova-campanha",
          label: "Nova campanha",
          what: 'Leva para /campanhas já com o canal "E-mail" pré-selecionado no compositor.',
        },
        {
          anchor: "email.header.automacoes",
          label: "Automações",
          what: "Leva para /automações, onde ficam as jornadas que também disparam e-mail.",
        },
        {
          anchor: "canal.abas",
          label: "Abas Visão geral / Templates / Histórico",
          what: "Alternam entre o painel de números, a lista de templates e o histórico detalhado de envios. A aba escolhida fica na URL (#visao-geral, #templates, #historico).",
        },
        {
          anchor: "canal.pausado.retomar",
          label: 'Faixa "Disparos de Email pausados" e botão Retomar disparos',
          what: 'Só aparece quando os disparos de e-mail da casa estão pausados (saldo esgotado no provedor, manutenção do provedor ou pausa manual). O botão "Retomar disparos" abre a confirmação "Retomar disparos de Email?", com a descrição de que os envios voltam a sair imediatamente e os botões "Cancelar" / "Retomar disparos".',
          notes:
            "Nada se perde enquanto pausado: campanhas e pendências continuam guardadas e são processadas quando o serviço voltar.",
        },
        {
          anchor: "canal.carteira.aviso",
          label: 'Aviso de saldo ("Seu saldo acabou" / "Saldo baixo")',
          what: 'Aparece só para casas que pagam por SMS/voz (não isentas) com saldo zerado ou abaixo do limite de aviso da casa. O texto explica que SMS e voz ficam bloqueados sem saldo, mas o e-mail continua dentro da franquia mensal. Quando a casa pode comprar por Pix, o texto traz um link "Saldo e consumo" (para /plano-e-creditos); senão, pede para falar com o suporte.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Visão geral
    // ---------------------------------------------------------------
    {
      id: "visao-geral",
      title: "Visão geral",
      tab: "visao-geral",
      intro:
        "Números do período escolhido, o gráfico de envios e a saúde do canal de e-mail.",
      items: [
        {
          anchor: "canal.periodo",
          label: 'Seletor de período ("Hoje", "Ontem", etc.)',
          what: "Escolhe a janela de tempo dos números, do gráfico e da saúde do envio abaixo.",
        },
        {
          anchor: "canal.kpis",
          label: 'KPIs: "Enviados", "Falhas", "Na fila" e "Cliques"',
          what: '"Enviados" conta quantos e-mails saíram no período e para quantos endereços diferentes. "Falhas" conta os que não saíram, com quantos foram devolvidos pelo destino (bounce) quando houver. "Na fila" soma o que está pendente e o que já está na fila de disparo, com o número de campanhas ativas quando houver alguma.',
          notes:
            '"Cliques" mostra sempre "—": o CRM ainda não conta cliques em links de e-mail (o servidor sempre devolve 0 aqui), diferente do SMS. O histórico de cada template mostra "0" cliques pelo mesmo motivo.',
        },
        {
          anchor: "canal.grafico.envios",
          label: 'Gráfico "Envios por dia" / "Envios por hora"',
          what: 'Mostra "Enviados" e "Falhas" por dia no período escolhido. Quando o período é um único dia (ex.: "Hoje"), o gráfico muda para "Envios por hora", com todas as tentativas de envio por hora no horário de Brasília.',
        },
        {
          anchor: "email.saude.dominio",
          label: 'Saúde do envio: "Domínio do remetente", "Capacidade de envio", "Campanhas ativas" e "Depositaram em até 72h após o email"',
          what: '"Domínio do remetente" mostra "Configurado" (verde) ou "Não configurado" (amarelo, com um link "Configurar" para /configurações/casa#email). "Capacidade de envio" mostra "Disponível" ou "Indisponível". "Campanhas ativas" conta as campanhas de e-mail em andamento. "Depositaram em até 72h após o email" conta jogadores que fizeram um depósito até 72 horas depois de receber um e-mail.',
          notes:
            'O link "Configurar" leva direto para a aba E-mail de Configuração da casa, onde se cadastra o domínio e o remetente de verdade (veja o artigo dessa tela).',
        },
        {
          anchor: "email.saude.ultimos-envios",
          label: "Lista de últimos envios",
          what: "Até 10 envios mais recentes, com o endereço de destino e um selo de status (Enviado, Falha, Devolvido, Pendente, Enviando ou Cancelado). Passar o mouse no selo de falha mostra o erro, quando houver.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Templates — lista, cartões e o menu "…"
    // ---------------------------------------------------------------
    {
      id: "templates",
      title: "Templates",
      tab: "templates",
      intro:
        "Modelos reutilizáveis de e-mail, usados em campanhas e jornadas. Cada template pode ser criado por dois editores diferentes.",
      items: [
        {
          anchor: "email.templates.novo",
          label: "Novo template",
          what: 'Abre o diálogo "Como você quer criar este template?", que pede para escolher entre o Editor Rápido e o Editor Avançado antes de abrir o editor escolhido.',
        },
        {
          label: 'Diálogo "Como você quer criar este template?"',
          what: 'Duas opções, cada uma com um botão: "⚡ Editor Rápido BETLEADS" ("Padrão Pixreals. Preencha campos, suba banner, ajuste cores e salve.") e "🧩 Editor Avançado HTML" ("Modo livre com blocos, IA, presets e HTML customizado."). Clicar em qualquer uma fecha o diálogo e abre o editor escolhido.',
        },
        {
          anchor: "email.templates.card",
          label: "Cartão de template",
          what: 'Cada cartão mostra o nome do template, o assunto (ou "(sem assunto)"), um selo de status ("publicado", "rascunho" ou "arquivado"), a categoria, as tags (#tag), um resumo com envios/falhas/descadastros somando todas as campanhas que usaram esse template, e a versão + data da última atualização. Um template pausado (desativado) aparece com menos destaque (opacidade reduzida).',
          notes:
            'Esse resumo também soma "Cliques", mas o número sempre aparece 0 — o mesmo motivo do KPI "Cliques" da Visão geral: o CRM ainda não conta cliques de e-mail.',
        },
        {
          anchor: "email.templates.editar",
          label: "Editar",
          what: "Abre o Editor Avançado com o conteúdo desse template, pronto para alterar.",
        },
        {
          anchor: "email.templates.menu",
          label: 'Menu "…" (Mais ações)',
          what: 'Abre um menu com "Duplicar" (cria uma cópia do template), "Pausar"/"Reativar" (o rótulo muda conforme o template estar ativo ou não) e "Excluir".',
          notes:
            'Excluir pede confirmação: "Excluir template?", com a descrição "O template será removido e não poderá mais ser usado em novas campanhas." e os botões "Cancelar" / "Excluir template".',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Editor Rápido
    // ---------------------------------------------------------------
    {
      id: "editor-rapido",
      title: "Editor Rápido BETLEADS",
      tab: "templates",
      intro:
        "Editor por formulário: você preenche campos e vê o e-mail montar em tempo real, sem escrever HTML. Tem 5 seções, uma prévia ao vivo e um atalho para o modo avançado.",
      items: [
        {
          anchor: "email.rapido.nome",
          label: "1. Identificação — Nome do template",
          what: "O nome interno do template, usado para encontrá-lo na lista.",
          notes: 'Obrigatório: ao salvar sem nome, aparece o erro "Dê um nome para o template".',
        },
        {
          anchor: "email.rapido.modelo",
          label: "1. Identificação — Modelo do e-mail",
          what: 'Escolhe um dos 6 modelos prontos (Retorno, VIP, Conversão, Dinheiro parado, Primeiro depósito, Relacionamento). Trocar o modelo preenche de novo o título, a saudação, o texto, o cupom, o benefício, o texto do botão e o aviso de urgência com um texto padrão para aquele objetivo — o que já foi digitado nos outros campos (nome, assunto, preheader, remetente, imagens, cores) não é apagado.',
        },
        {
          label: "1. Identificação — Objetivo do e-mail, Assunto e Preheader",
          what: '"Objetivo do e-mail" é um campo livre, só para sua própria referência. "Assunto" é o texto que aparece como assunto do e-mail. "Preheader" é o trecho de prévia mostrado do lado do assunto, antes de abrir a mensagem.',
        },
        {
          anchor: "email.rapido.remetente",
          label: "1. Identificação — Nome do remetente",
          what: 'O nome que aparece como quem enviou, dentro do próprio corpo do e-mail (na prévia, ao lado do assunto). Não é o remetente real do envio.',
          notes:
            'Esse campo é só um texto de exemplo, editável por template — ele não envia nada por conta própria. Quem de fato envia (o endereço de e-mail e o nome que chegam na caixa de entrada do jogador) é o remetente cadastrado em Configuração da casa → E-mail, válido para todas as campanhas e jornadas.',
        },
        {
          anchor: "email.rapido.logo",
          label: "2. Imagens — Logo",
          what: 'Imagem pequena no topo do e-mail. Cole uma URL ou clique em "Enviar" para subir um arquivo (máx. 220px de largura).',
          notes:
            'Erros possíveis ao subir: "Imagem muito grande (máx 5MB)" (arquivo maior que o limite) e "Falha no upload" (erro ao enviar). O ícone de lixeira remove a imagem.',
        },
        {
          anchor: "email.rapido.banner",
          label: "2. Imagens — Banner principal",
          what: 'Imagem grande abaixo da logo (o mesmo tipo de imagem que o Editor Avançado chama de "Hero"). Tem os mesmos botões de URL/upload/remover do campo Logo, mais um campo de "Alt text" (texto alternativo, mostrado se a imagem não carregar ou lido por leitores de tela).',
        },
        {
          label: "3. Conteúdo",
          what: 'Os textos do corpo do e-mail: Saudação, Título principal, Texto principal, Texto secundário (bloco extra), Benefício, Cupom, Link alternativo, Texto de urgência e Rodapé.',
        },
        {
          anchor: "email.rapido.cta",
          label: "3. Conteúdo — CTA (texto e URL)",
          what: 'O botão principal do e-mail: "CTA — texto" é o texto do botão (ex.: "Voltar para minha conta") e "CTA — URL" é o link para onde ele leva.',
        },
        {
          anchor: "email.rapido.blocos",
          label: "4. Blocos visíveis",
          what: 'Quatro interruptores que mostram ou escondem partes do e-mail sem apagar o texto digitado: "Card de benefício" (a caixa com o benefício/cupom), "Bloco extra" (o texto secundário), "Link alternativo" e "Aviso de urgência".',
        },
        {
          anchor: "email.rapido.cores",
          label: "5. Cores",
          what: "Oito seletores de cor (com campo de texto ao lado para o código hexadecimal): Fundo geral, Fundo do container, Texto principal, Texto secundário, Destaque, Botão, Texto do botão e Borda do card.",
        },
        {
          anchor: "email.rapido.preview",
          label: "Prévia ao vivo",
          what: 'Mostra o e-mail montado em tempo real, com o alternador Desktop/Mobile mudando a largura da prévia. Acima da prévia aparece o assunto e, junto, o nome do remetente e o preheader, como apareceriam na caixa de entrada.',
        },
        {
          anchor: "email.rapido.avancado",
          label: "Editar no modo avançado",
          what: "Leva o HTML montado até agora (e os campos preenchidos) para o Editor Avançado, em modo HTML, sem perder nada do que foi digitado aqui.",
        },
        {
          label: "Cancelar",
          what: "Fecha o Editor Rápido sem salvar.",
        },
        {
          anchor: "email.rapido.salvar",
          label: "Salvar template",
          what: "Grava o template com o HTML montado a partir dos campos preenchidos.",
          notes:
            'Erro possível: "Dê um nome para o template" (campo Nome do template vazio). O template salvo aqui fica como "rascunho": as jornadas já podem usá-lo, mas uma campanha só envia template publicado, e ele não conta para a etapa "Publique um template de e-mail" do guia. Para publicar, clique em "Editar" no cartão, escolha "Publicado" em Status e salve.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Editor Avançado
    // ---------------------------------------------------------------
    {
      id: "editor-avancado",
      title: "Editor Avançado HTML",
      tab: "templates",
      intro:
        "Editor por etapas (objetivo, modelo, imagens, campos e variáveis), com um modo HTML livre para quem quiser escrever o e-mail do zero, templates prontos e geração por IA.",
      items: [
        {
          anchor: "email.avancado.templates-prontos",
          label: "Templates prontos",
          what: "Abre uma lista de templates já configurados (modelo, assunto, categoria e tags). Clicar em um aplica tudo de uma vez (objetivo, modelo, nome, assunto, preheader, remetente e os campos de conteúdo) e mostra o aviso \"Template \\\"<nome>\\\" aplicado\".",
          notes: "Aplicar um template pronto sempre volta para o modo visual (desliga o HTML avançado, se estiver ligado).",
        },
        {
          anchor: "email.avancado.gerar-ia",
          label: "Gerar com IA",
          what: 'Abre um diálogo com 5 campos: "Gatilho / contexto" (obrigatório), "Benefício / oferta", "Tom da mensagem" (Amigável, Urgente, Premium/VIP, Direto e curto ou Casual), "Cupom (opcional)" e "Link do botão". O botão "Gerar" chama a IA e preenche assunto, preheader, título, texto e CTA; o botão fica "Gerando..." enquanto espera.',
          notes:
            'Erro possível ao gerar: "Descreva o gatilho ou contexto" (campo obrigatório vazio) ou a mensagem de erro do serviço de IA. Ao terminar com sucesso, aparece "Conteúdo gerado pela IA" e o editor volta para o modo visual.',
        },
        {
          anchor: "email.avancado.status",
          label: "Status (Rascunho / Publicado / Arquivado)",
          what: "Define a situação do template. Só um template Publicado pode ser agendado ou enviado numa campanha; um Rascunho ainda pode ser usado nas jornadas; um Arquivado fica visível na lista, mas fora de uso.",
          notes:
            'O Editor Rápido não tem este seletor: o template salvo por lá fica como "rascunho". As jornadas já podem usar esse rascunho, mas agendar ou enviar uma campanha com ele dá erro ("Apenas templates publicados podem ser agendados." / "O template desta campanha não está publicado."), e ele não conta para a etapa "Publique um template de e-mail" do guia. Para publicar, abra o template em "Editar", escolha "Publicado" aqui e salve. Use "Pausar" no menu "…" do cartão para tirá-lo de uso de verdade.',
        },
        {
          anchor: "email.avancado.rastreio",
          label: '"Encurtar e medir os links"',
          what: 'Caixa de marcar que decide se os links do e-mail passam pelo encurtador da casa (para medir cliques). Sem nenhuma URL no conteúdo, mostra um aviso pedindo para adicionar uma; com URLs, mostra como elas vão aparecer (encurtadas ou originais) conforme a caixa estiver marcada.',
        },
        {
          anchor: "email.avancado.toggle-html",
          label: "HTML avançado (interruptor)",
          what: "Alterna entre o modo visual (passos 1 a 5 abaixo) e o modo HTML livre.",
          notes:
            "Abrir um template que já tem HTML salvo começa direto no modo HTML, para não perder o que já foi escrito.",
        },
        {
          anchor: "email.avancado.objetivo",
          label: "Passo 1 — Objetivo do email",
          what: "Sete botões de objetivo (Recuperação, Cashback, Bônus, VIP, Primeiro depósito, Dinheiro parado, Aviso geral), cada um com uma descrição curta.",
        },
        {
          anchor: "email.avancado.modelo",
          label: "Passo 2 — Modelo visual",
          what: "Seis modelos visuais (Simples, Promocional, VIP, Urgência, Cashback, Cupom), cada um com uma cor de destaque própria para o botão.",
        },
        {
          anchor: "email.avancado.imagens",
          label: "Passo 3 — Imagens do e-mail",
          what: 'Quatro campos de imagem: "Logo do e-mail" (topo, máx. 220px), "Banner principal (Hero)" (imagem grande responsiva, com Alt text), "Banner secundário" (opcional, com interruptor para mostrar/esconder) e "Ícone do benefício" (opcional, também com interruptor). Cada um aceita colar uma URL ou enviar um arquivo.',
          notes: 'Mesmos erros de upload do Editor Rápido: "Imagem muito grande (máx 5MB)" e "Falha no upload".',
        },
        {
          anchor: "email.avancado.campos",
          label: "Passo 4 — Campos rápidos",
          what: 'Dez campos de texto (Nome do template, Assunto, Pré-header, Nome do remetente, Título principal, Texto principal, Cupom, Benefício, Botão/CTA, Link do botão). O campo em uso no momento ganha um selo "ativo", usado pelas variáveis do passo 5. O campo "Link do botão" tem um menu que lista "URL da casa" e, abaixo, cada URL rápida cadastrada pelo próprio nome (ex.: "Depósito") — clicar insere o link escolhido no campo.',
          notes:
            'Sem nenhuma URL da casa cadastrada, o menu some e aparece "Cadastre a URL da casa para inserir links na mensagem" no lugar (veja os estados da tela).',
        },
        {
          anchor: "email.avancado.variaveis",
          label: "Passo 5 — Variáveis",
          what: 'Lista de variáveis clicáveis (ex.: {primeiro_nome}, {link_login}). Clicar insere o token no campo marcado como "ativo" no passo 4.',
        },
        {
          anchor: "email.avancado.meta",
          label: "Modo HTML — Nome, Assunto, Pré-header, Remetente",
          what: "Os mesmos 4 campos de identificação do modo visual, agora junto com o HTML.",
        },
        {
          anchor: "email.avancado.html",
          label: "Modo HTML — editor de HTML",
          what: "Caixa de texto para escrever o HTML do e-mail diretamente, com variáveis {token} substituídas de verdade só no envio.",
        },
        {
          label: "Cancelar",
          what: "Fecha o Editor Avançado sem salvar.",
        },
        {
          anchor: "email.avancado.salvar",
          label: "Salvar template",
          what: "Grava o template com o HTML do modo visual (montado a partir dos campos) ou do modo HTML, conforme o interruptor.",
          notes:
            'Erros possíveis: "Dê um nome para o template" (nome vazio) e "Link ou imagem inválido: <link>" — quando algum link ou imagem do HTML não começa com "http://", "https://", "{" (variável), "cid:" ou "data:image/".',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Histórico — HistoryShell (prefixo neutro "historico.")
    // ---------------------------------------------------------------
    {
      id: "historico",
      title: "Histórico",
      tab: "historico",
      intro:
        "Todos os envios de e-mail de campanhas e automações, com filtros, um ranking por jornada e o detalhe de cada envio. Esta tela (HistoryShell) é a mesma base usada pelo histórico de SMS e de Ligações.",
      items: [
        {
          anchor: "historico.filtros.periodo",
          label: "Seletor de período",
          what: "Escolhe a janela de tempo de todos os cartões, do gráfico, do ranking de jornadas e da tabela abaixo.",
        },
        {
          anchor: "historico.atualizar",
          label: "Atualizar",
          what: 'Busca os dados de novo na hora (os cartões, o gráfico, o ranking e a tabela já atualizam sozinhos a cada minuto). Mostra o aviso "Histórico atualizado" ao terminar.',
        },
        {
          anchor: "historico.cards",
          label: 'Cartões "Envios", "Enviados", "Falhas", "Pendentes" e "Conversões"',
          what: '"Envios" é o total de tentativas, com a variação percentual contra o período anterior. "Enviados" mostra quantos saíram (sem taxa de entrega — o provedor de e-mail não confirma entrega). "Falhas" conta os que não saíram. "Pendentes" conta os que ainda estão esperando. "Conversões" conta jogadores que depositaram depois do envio.',
        },
        {
          anchor: "historico.grafico",
          label: 'Gráfico "Envios por dia" / "Envios por hora"',
          what: "Mini gráfico de barras com o total de envios por dia (ou por hora, quando o período é um único dia), com o total geral do período ao lado do título.",
          notes: "Só aparece quando há mais de um ponto no período — com um único ponto, o gráfico fica escondido.",
        },
        {
          anchor: "historico.jornadas",
          label: "Jornadas com mais envios",
          what: 'Tabela com as jornadas que mais enviaram e-mail no período, cada uma com envios, enviados, falhas e o último envio. Clicar numa linha filtra a tabela de baixo por aquela jornada; "Limpar seleção" tira o filtro.',
        },
        {
          anchor: "historico.filtros.jornada",
          label: "Filtro de jornada",
          what: 'Restringe a tabela a uma única jornada ("Todas as jornadas" por padrão).',
        },
        {
          anchor: "historico.filtros.status",
          label: "Filtro de status",
          what: 'Restringe a tabela por status: Sucesso, Pendente / retry, Falha, Processando ou Cancelado ("Todos os status" por padrão).',
        },
        {
          anchor: "historico.filtros.busca",
          label: "Busca",
          what: "Procura por nome, telefone ou e-mail do jogador na tabela abaixo.",
        },
        {
          anchor: "historico.tabela",
          label: "Tabela de envios",
          what: 'Cada linha mostra data, jogador, contato (o e-mail), a mensagem (assunto/preview), a jornada, o status e se houve conversão. Clicar numa linha abre a gaveta de detalhe.',
          notes:
            '"Anterior" / "Próxima" (abaixo da tabela) passam as páginas, 50 registros por vez.',
        },
        {
          label: "Gaveta de detalhe",
          what: 'Abre ao clicar numa linha da tabela: canal e status no topo, data completa, e os campos Jogador, Contato, Jornada, Dia da jornada, "Template / assunto" e Mensagem. Quando o envio falhou, mostra "Falha no envio" com o erro; quando o jogador depositou depois, mostra o aviso de conversão (72h).',
          notes:
            'Os botões "Ver jogador" (abre a ficha do jogador numa aba nova), "Copiar mensagem" e "Copiar erro" (quando há erro) ficam na parte de baixo da gaveta.',
        },
      ],
    },
  ],

  states: [
    {
      id: "canal-pausado",
      title: "Disparos de Email pausados",
      what: 'Faixa de aviso mostrada quando os disparos de e-mail da casa estão pausados, com o motivo quando reconhecido ("Saldo esgotado no provedor de envio.", "Provedor de envio em manutenção." ou "Pausado manualmente."). Nada é perdido: campanhas e pendências continuam guardadas.',
      action: 'Clique em "Retomar disparos" para voltar a enviar — a fila é processada nos segundos seguintes.',
    },
    {
      id: "canal-saldo-baixo",
      title: '"Seu saldo acabou" / "Saldo baixo"',
      what: "Aviso mostrado só para casas que pagam por SMS/voz (não isentas) com saldo zerado ou perto do limite de aviso. Não afeta o envio de e-mail, que continua dentro da franquia mensal.",
      action: 'Compre créditos por Pix em "Saldo e consumo" (quando disponível) ou fale com o suporte.',
    },
    {
      id: "canal-desabilitado",
      title: "Canal E-mail desabilitado",
      what: 'Tela cheia mostrada no lugar de toda a página (sem abas, sem "Nova campanha") quando o super admin desligou o canal E-mail desta casa e alguém chega em /email por um link, favorito ou automação antiga. A mensagem exata é "O canal E-mail está desabilitado para esta casa."',
      action: "Fale com o suporte para reativar o canal, se precisar dele de volta.",
    },
    {
      id: "templates-vazio",
      title: "Crie seu primeiro template",
      what: 'Texto mostrado na aba Templates quando a casa ainda não tem nenhum template de e-mail.',
      action: 'Clique em "Novo template" para criar o primeiro.',
    },
    {
      id: "saude-sem-envios",
      title: "Quando começar a enviar, os envios aparecem aqui.",
      what: 'Texto mostrado na lista "Últimos envios" da Visão geral quando ainda não houve nenhum envio no período.',
    },
    {
      id: "historico-sem-jornada",
      title: "Nenhum envio por jornada no período.",
      what: 'Texto mostrado em "Jornadas com mais envios" quando nenhuma jornada enviou e-mail no período escolhido.',
    },
    {
      id: "historico-vazio",
      title: "Nenhum registro com esses filtros. / Nenhum envio nesse período.",
      what: "Texto mostrado na tabela do Histórico quando a busca não encontra nada: a primeira frase quando algum filtro está ativo, a segunda quando não há filtro nenhum e simplesmente não houve envio no período.",
      action: 'Com algum filtro ativo, aparece um botão "Limpar filtros" para voltar a ver tudo.',
    },
    {
      id: "upload-imagem-erro",
      title: '"Imagem muito grande (máx 5MB)" / "Falha no upload"',
      what: "Erros ao subir uma imagem (logo, banner, ícone) em qualquer um dos dois editores: arquivo maior que 5MB, ou falha no envio em si.",
      action: "Escolha um arquivo menor ou tente enviar de novo.",
    },
    {
      id: "editor-nome-vazio",
      title: "Dê um nome para o template",
      what: 'Erro ao salvar (nos dois editores) com o campo "Nome do template" vazio.',
      action: "Preencha o nome e salve de novo.",
    },
    {
      id: "editor-link-invalido",
      title: "Link ou imagem inválido: <link>",
      what: 'Erro ao salvar no Editor Avançado quando algum link/imagem do HTML final não começa com "http://", "https://", "{" (variável), "cid:" ou "data:image/".',
      action: "Corrija o link ou a imagem apontada e salve de novo.",
    },
    {
      id: "ia-sem-gatilho",
      title: "Descreva o gatilho ou contexto",
      what: 'Erro ao clicar em "Gerar" no diálogo "Gerar com IA" com o campo "Gatilho / contexto" vazio.',
      action: "Preencha o gatilho/contexto e clique em Gerar de novo.",
    },
    {
      id: "sem-url-casa",
      title: "Cadastre a URL da casa para inserir links na mensagem",
      what: 'Mostrado no lugar do menu de inserir link (campo "Link do botão", passo 4 do Editor Avançado) quando a casa ainda não tem uma URL cadastrada.',
      action: 'Cadastre em Configuração da casa → Casa → "URL da casa".',
    },
  ],

  tours: {
    "visao-geral": [
      {
        anchor: "canal.header.nova-campanha",
        title: "Nova campanha",
        body: "Começa uma campanha de e-mail já no canal certo.",
        articleSection: "canal",
      },
      {
        anchor: "canal.abas",
        title: "Abas",
        body: "Visão geral, Templates e Histórico — a aba escolhida fica na URL.",
        articleSection: "canal",
      },
      {
        anchor: "canal.periodo",
        title: "Período",
        body: "Escolha a janela de tempo dos números e do gráfico abaixo.",
        articleSection: "visao-geral",
      },
      {
        anchor: "canal.kpis",
        title: "KPIs",
        body: 'Enviados, Falhas e Na fila do período. "Cliques" sempre mostra "—": o CRM ainda não conta cliques de e-mail.',
        articleSection: "visao-geral",
      },
      {
        anchor: "canal.grafico.envios",
        title: "Envios por dia",
        body: "Enviados e Falhas por dia (ou por hora, num único dia).",
        articleSection: "visao-geral",
      },
      {
        anchor: "email.saude.dominio",
        title: "Saúde do envio",
        body: "Domínio do remetente, capacidade de envio, campanhas ativas e depósitos em até 72h após o e-mail.",
        articleSection: "visao-geral",
      },
      {
        anchor: "email.saude.ultimos-envios",
        title: "Últimos envios",
        body: "Os envios mais recentes, com o status de cada um.",
        articleSection: "visao-geral",
      },
    ],
    templates: [
      {
        anchor: "canal.abas",
        title: "Você está em Templates",
        body: "Aqui ficam os templates usados em campanhas e jornadas de e-mail.",
        articleSection: "templates",
      },
      {
        anchor: "email.templates.novo",
        title: "Novo template",
        body: "Escolha entre o Editor Rápido (formulário) e o Editor Avançado (HTML livre).",
        articleSection: "templates",
      },
      {
        anchor: "email.templates.card",
        title: "Cartão de template",
        body: "Nome, assunto, status, categoria, tags e o resumo de envios desse template.",
        articleSection: "templates",
      },
      {
        anchor: "email.templates.editar",
        title: "Editar",
        body: "Abre o Editor Avançado com o conteúdo desse template.",
        articleSection: "templates",
      },
      {
        anchor: "email.templates.menu",
        title: "Mais ações",
        body: "Duplicar, Pausar/Reativar ou Excluir o template.",
        articleSection: "templates",
      },
    ],
    historico: [
      {
        anchor: "historico.filtros.periodo",
        title: "Período",
        body: "Escolhe a janela de tempo de tudo nesta aba.",
        articleSection: "historico",
      },
      {
        anchor: "historico.atualizar",
        title: "Atualizar",
        body: "Busca os dados de novo na hora.",
        articleSection: "historico",
      },
      {
        anchor: "historico.cards",
        title: "Cartões",
        body: "Envios, Enviados, Falhas, Pendentes e Conversões do período.",
        articleSection: "historico",
      },
      {
        anchor: "historico.jornadas",
        title: "Jornadas com mais envios",
        body: "Clique numa jornada para filtrar a tabela abaixo.",
        articleSection: "historico",
      },
      {
        anchor: "historico.filtros.jornada",
        title: "Filtro de jornada",
        body: "Restringe a tabela a uma única jornada.",
        articleSection: "historico",
      },
      {
        anchor: "historico.filtros.status",
        title: "Filtro de status",
        body: "Restringe a tabela por status de envio.",
        articleSection: "historico",
      },
      {
        anchor: "historico.filtros.busca",
        title: "Busca",
        body: "Procure por nome, telefone ou e-mail do jogador.",
        articleSection: "historico",
      },
      {
        anchor: "historico.tabela",
        title: "Tabela de envios",
        body: "Cada linha abre o detalhe completo daquele envio.",
        articleSection: "historico",
      },
    ],
  },
};

export default screen;
