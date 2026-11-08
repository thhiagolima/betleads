// Help article for "SMS" (/sms), três abas: Visão geral, Templates e
// Histórico. Fonte: src/routes/sms.tsx, src/components/channels/channel-page.tsx
// e channel-overview.tsx (barra/visão geral compartilhada com Email/Ligações,
// prefixo "canal."), src/components/sms/{sms-channel-health,
// sms-templates-panel}.tsx, src/components/history/history-shell.tsx
// (prefixo neutro "historico.", reaproveitado por Email/Ligações),
// src/components/providers-paused-banner.tsx,
// src/components/billing/wallet-balance-notice.tsx,
// src/components/send-window-card.tsx, src/components/channels/channel-disabled-state.tsx
// e src/lib/link-tracking-preview.ts (contador de caracteres/segmentos).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "sms",
  route: "/sms",
  defaultTab: "visao-geral",
  title: "SMS",
  purpose:
    "Visão geral dos envios de SMS, o saldo e a saúde do canal, os templates usados em campanhas e jornadas (com contador de caracteres/segmentos e chips de link) e o histórico completo de envios.",
  roles: ["admin", "gestor", "member", "expert"],
  terms: ["segmento-sms", "gsm-7", "ucs-2"],
  sections: [
    // ---------------------------------------------------------------
    // Barra superior — compartilhada com /email e /ligações (prefixo "canal.")
    // ---------------------------------------------------------------
    {
      id: "canal",
      title: "Barra superior (aparece nas 3 abas)",
      intro:
        "Esta faixa é a mesma em /sms, /email e /ligações: o botão de nova campanha, o aviso de disparos pausados, as abas e a janela de envio. Fica acima das abas e não muda quando você troca de aba. O aviso de saldo do SMS (diferente das outras duas telas) só aparece na aba Visão geral — veja essa seção abaixo.",
      items: [
        {
          anchor: "canal.header.nova-campanha",
          label: "Nova campanha",
          what: 'Leva para /campanhas já com o canal "SMS" pré-selecionado no compositor.',
        },
        {
          anchor: "canal.abas",
          label: "Abas Visão geral / Templates / Histórico",
          what: "Alternam entre o painel de números, a lista de templates e o histórico detalhado de envios. A aba escolhida fica na URL (#visao-geral, #templates, #historico).",
        },
        {
          anchor: "canal.pausado.retomar",
          label: 'Faixa "Disparos de SMS pausados" e botão Retomar disparos',
          what: 'Só aparece quando os disparos de SMS da casa estão pausados (saldo esgotado no provedor, manutenção do provedor ou pausa manual). O botão "Retomar disparos" abre a confirmação "Retomar disparos de SMS?", com a descrição de que os envios voltam a sair imediatamente e os botões "Cancelar" / "Retomar disparos".',
          notes:
            "Nada se perde enquanto pausado: campanhas e pendências continuam guardadas e são processadas quando o serviço voltar.",
        },
        {
          anchor: "canal.janela.card",
          label: "Janela de envio",
          what: 'Faixa curta mostrando se o envio está "Dentro da janela de envio" ou "Fora da janela de envio — envios aguardando", com o horário permitido e, fora da janela, quando os envios retomam e quantos estão esperando.',
          notes:
            "A janela vale para todos os canais automáticos (SMS, e-mail e ligações) e é configurada em /configurações.",
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
        "Números do período escolhido, o gráfico de envios, o aviso de saldo e a saúde do canal de SMS.",
      items: [
        {
          anchor: "canal.periodo",
          label: 'Seletor de período ("Hoje", "Ontem", etc.)',
          what: "Escolhe a janela de tempo dos números, do gráfico e da saúde do envio abaixo.",
        },
        {
          anchor: "canal.carteira.aviso",
          label: 'Aviso de saldo ("Seu saldo acabou" / "Saldo baixo")',
          what: 'Aparece só para casas que pagam por SMS/voz (não isentas) com o saldo zerado ou abaixo do limite de aviso da casa. Diferente de /email e /ligações, em /sms esse aviso só aparece nesta aba (ele reflete o saldo que a própria tela está mostrando). O texto explica que SMS e voz ficam bloqueados sem saldo, mas o e-mail continua dentro da franquia mensal. Quando a casa pode comprar por Pix, o texto traz um link "Saldo e consumo" (para /plano-e-creditos); senão, pede para falar com o suporte.',
        },
        {
          anchor: "canal.kpis",
          label: 'KPIs: "Enviados", "Falhas", "Na fila" e "Créditos disponíveis"',
          what: '"Enviados" conta quantos SMS saíram no período e para quantos números diferentes. "Falhas" conta os que não saíram. "Na fila" soma o que está pendente e o que já está na fila de disparo, com o número de campanhas agendadas quando houver alguma. "Créditos disponíveis" mostra o saldo da carteira em reais — ou "Casa isenta" para casas que não pagam por SMS.',
          notes:
            'Casa não isenta: abaixo do saldo aparece "dá para cerca de N SMS" (saldo dividido pelo preço do SMS). Casa isenta: aparece "sem cobrança por envio" no lugar.',
        },
        {
          anchor: "canal.grafico.envios",
          label: 'Gráfico "Envios por dia" / "Envios por hora"',
          what: 'Mostra só "Enviados" por dia no período escolhido (sem a série de falhas, diferente do e-mail). Quando o período é um único dia (ex.: "Hoje"), o gráfico muda para "Envios por hora", com todas as tentativas de envio por hora no horário de Brasília.',
        },
        {
          anchor: "sms.saude.metricas",
          label:
            '"Saúde do canal": Disponibilidade, Saldo para envio, Campanhas agendadas, Jogadores em jornadas, Jornadas de SMS ativas e Depositaram em até 72h após o SMS',
          what: '"Disponibilidade" mostra "Disponível" ou "Indisponível" (status do provedor de SMS). "Saldo para envio" repete o saldo da carteira (ou "Casa isenta"). "Campanhas agendadas" conta as campanhas de SMS programadas para sair. "Jogadores em jornadas" e "Jornadas de SMS ativas" contam quem está e quantas jornadas estão disparando SMS agora. "Depositaram em até 72h após o SMS" conta jogadores que fizeram um depósito até 72 horas depois de receber um SMS.',
        },
        {
          anchor: "sms.saude.acoes",
          label: 'Botões "Plano e créditos" e "Ver histórico"',
          what: '"Plano e créditos" leva para /plano-e-creditos (comprar saldo e ver consumo). "Ver histórico" troca para a aba Histórico desta mesma tela.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Templates
    // ---------------------------------------------------------------
    {
      id: "templates",
      title: "Templates",
      tab: "templates",
      intro:
        "Mensagens de SMS reutilizáveis, usadas em campanhas e jornadas. Diferente do e-mail, o SMS tem um único editor: um formulário simples que abre direto na mesma tela, sem diálogo de escolha.",
      items: [
        {
          anchor: "sms.templates.novo",
          label: "Novo template",
          what: 'Abre, logo abaixo, o formulário "Novo template" (o mesmo usado para editar).',
        },
        {
          label: 'Formulário "Novo template" / "Editar template" — Nome, Categoria e Etiquetas',
          what: '"Nome" identifica o template na lista (obrigatório). "Categoria" agrupa templates parecidos (obrigatório, "Geral" por padrão). "Etiquetas" aceita várias palavras separadas por vírgula (ex.: "reativação, vip"), mostradas como #tag no cartão.',
        },
        {
          anchor: "sms.templates.mensagem",
          label: "Formulário — Mensagem",
          what: "O texto do SMS, até 480 caracteres (obrigatório). Abaixo dele aparece a contagem de caracteres, a codificação e o número de partes.",
          notes:
            'A codificação é GSM-7 (alfabeto padrão do SMS, até 160 caracteres por parte, 153 quando a mensagem passa de uma parte) ou UCS-2 (usada quando a mensagem tem um caractere fora do alfabeto padrão, como emoji ou aspas curvas — cabe só 70 caracteres por parte, 67 quando passa de uma). Acentos comuns do português (á, ã, ç, ü...) continuam em GSM-7 e não mudam a codificação, mas uma única emoji pode dobrar o número de partes mesmo numa mensagem curta.',
        },
        {
          anchor: "sms.templates.links",
          label: 'Formulário — "Inserir link — clique para inserir" (chips)',
          what: 'Clique num chip ("URL da casa" ou uma das URLs rápidas cadastradas) para inserir o link na posição do cursor da Mensagem. O título do bloco é "Inserir link — clique para inserir"; passar o mouse sobre um chip mostra o mesmo aviso com o nome daquele link, por exemplo "URL da casa — clique para inserir".',
          notes:
            'Sem a URL da casa cadastrada, o bloco mostra "Cadastre a URL da casa para inserir links na mensagem." em vez dos chips (veja os estados da tela) — o link leva para /configuracoes/casa.',
        },
        {
          label: "Formulário — Salvar / Cancelar",
          what: '"Salvar" grava o template (novo ou alterado), mostra o aviso "Template salvo" e fecha o formulário. "Cancelar" fecha sem salvar.',
          notes:
            'Erro possível ao salvar: "Variáveis não permitidas: <lista>" — quando a mensagem tem um {token} que o CRM não reconhece (veja os estados da tela).',
        },
        {
          anchor: "sms.templates.card",
          label: "Cartão de template",
          what: 'Cada cartão mostra o nome do template, a versão (ex.: "v2") ou "arquivado", o texto da mensagem, a categoria e as etiquetas (#tag). Um template arquivado aparece com menos destaque (opacidade reduzida).',
        },
        {
          anchor: "sms.templates.editar",
          label: "Editar",
          what: "Abre o formulário com o conteúdo desse template, pronto para alterar.",
        },
        {
          anchor: "sms.templates.menu",
          label: 'Menu "…" (Mais ações)',
          what: 'Abre um menu com "Duplicar" (cria uma cópia do template, com "(cópia)" no nome, e mostra o aviso "Template duplicado") e "Arquivar"/"Reativar" (o rótulo muda conforme o template estar ativo ou não, e mostra "Template arquivado" ou "Template reativado").',
          notes:
            'Um template arquivado continua podendo ser usado em campanhas e jornadas já configuradas com ele — "Arquivar" só reduz o destaque na lista, não bloqueia o uso.',
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
        "Todos os envios de SMS de campanhas e automações, com filtros, um ranking por jornada e o detalhe de cada envio. Esta tela (HistoryShell) é a mesma base usada pelo histórico de Email e de Ligações.",
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
          what: '"Envios" é o total de tentativas, com a variação percentual contra o período anterior. "Enviados" mostra quantos saíram (sem taxa de entrega — o provedor de SMS não confirma entrega: o callback da operadora não informa status, então nenhum SMS é marcado como entregue). "Falhas" conta os que não saíram. "Pendentes" conta os que ainda estão esperando. "Conversões" conta jogadores que depositaram depois do envio.',
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
          what: 'Tabela com as jornadas que mais enviaram SMS no período, cada uma com envios, enviados, falhas e o último envio. Clicar numa linha filtra a tabela de baixo por aquela jornada; "Limpar seleção" tira o filtro.',
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
          what: 'Cada linha mostra data, jogador, contato (o número), a mensagem, a jornada, o status e se houve conversão. Clicar numa linha abre a gaveta de detalhe.',
          notes:
            '"Anterior" / "Próxima" (abaixo da tabela) passam as páginas, 50 registros por vez.',
        },
        {
          label: "Gaveta de detalhe",
          what: 'Abre ao clicar numa linha da tabela: canal e status no topo, data completa, e os campos Jogador, Contato, Jornada, Dia da jornada, "Template / assunto" e Mensagem. Quando o envio falhou, mostra "Falha no envio" com o erro; quando o jogador depositou depois, mostra o aviso de conversão (72h).',
          notes:
            'Os botões "Ver jogador" (abre a ficha do jogador numa aba nova), "Copiar mensagem" (mostra "Mensagem copiada") e "Copiar erro" (quando há erro, mostra "Erro copiado") ficam na parte de baixo da gaveta.',
        },
      ],
    },
  ],

  states: [
    {
      id: "canal-pausado",
      title: "Disparos de SMS pausados",
      what: 'Faixa de aviso mostrada quando os disparos de SMS da casa estão pausados, com o motivo quando reconhecido ("Saldo esgotado no provedor de envio.", "Provedor de envio em manutenção." ou "Pausado manualmente."). Nada é perdido: campanhas e pendências continuam guardadas.',
      action: 'Clique em "Retomar disparos" (depois de confirmar "Retomar disparos de SMS?") para voltar a enviar — aparece o aviso "Disparos de SMS retomados — fila vai drenar nos próximos segundos."',
    },
    {
      id: "canal-saldo-baixo",
      title: '"Seu saldo acabou" / "Saldo baixo"',
      what: "Aviso mostrado na aba Visão geral só para casas que pagam por SMS/voz (não isentas) com saldo zerado ou perto do limite de aviso. Enquanto o saldo estiver zerado, SMS e voz ficam bloqueados; o e-mail continua dentro da franquia mensal.",
      action: 'Compre créditos por Pix em "Saldo e consumo" (quando disponível) ou fale com o suporte.',
    },
    {
      id: "canal-desabilitado",
      title: "Canal SMS desabilitado",
      what: 'Tela cheia mostrada no lugar de toda a página (sem abas, sem "Nova campanha") quando o super admin desligou o canal SMS desta casa e alguém chega em /sms por um link, favorito ou automação antiga.',
      action: "Fale com o suporte para reativar o canal, se precisar dele de volta.",
    },
    {
      id: "templates-vazio",
      title: "Nenhum template ainda",
      what: "Texto mostrado na aba Templates quando a casa ainda não tem nenhum template de SMS.",
      action: 'Clique em "Novo template" para criar o primeiro.',
    },
    {
      id: "templates-sem-url-casa",
      title: "Cadastre a URL da casa para inserir links na mensagem.",
      what: 'Mostrado no lugar dos chips de link, no formulário de template, quando a casa ainda não tem uma URL cadastrada.',
      action: 'Cadastre em Configuração da casa → Casa → "URL da casa".',
    },
    {
      id: "templates-variaveis-invalidas",
      title: "Variáveis não permitidas: <lista>",
      what: 'Erro ao salvar o template quando a Mensagem tem um {token} que o CRM não reconhece como variável válida de SMS.',
      action: "Corrija ou remova a variável apontada e salve de novo.",
    },
    {
      id: "historico-sem-jornada",
      title: "Nenhum envio por jornada no período.",
      what: 'Texto mostrado em "Jornadas com mais envios" quando nenhuma jornada enviou SMS no período escolhido.',
    },
    {
      id: "historico-vazio",
      title: "Nenhum registro com esses filtros. / Nenhum envio nesse período.",
      what: "Texto mostrado na tabela do Histórico quando a busca não encontra nada: a primeira frase quando algum filtro está ativo, a segunda quando não há filtro nenhum e simplesmente não houve envio no período.",
      action: 'Com algum filtro ativo, aparece um botão "Limpar filtros" para voltar a ver tudo.',
    },
  ],

  tours: {
    "visao-geral": [
      {
        anchor: "canal.header.nova-campanha",
        title: "Nova campanha",
        body: "Começa uma campanha de SMS já no canal certo.",
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
        body: 'Enviados, Falhas, Na fila e Créditos disponíveis — com quanto dá para enviar com o saldo atual.',
        articleSection: "visao-geral",
      },
      {
        anchor: "canal.grafico.envios",
        title: "Envios por dia",
        body: "Quantos SMS saíram por dia (ou por hora, num único dia).",
        articleSection: "visao-geral",
      },
      {
        anchor: "sms.saude.metricas",
        title: "Saúde do canal",
        body: "Disponibilidade, saldo, campanhas agendadas, jornadas e depósitos em até 72h após o SMS.",
        articleSection: "visao-geral",
      },
      {
        anchor: "sms.saude.acoes",
        title: "Plano e créditos / Ver histórico",
        body: "Compre saldo ou veja o histórico completo de envios.",
        articleSection: "visao-geral",
      },
    ],
    templates: [
      {
        anchor: "canal.abas",
        title: "Você está em Templates",
        body: "Aqui ficam as mensagens de SMS usadas em campanhas e jornadas.",
        articleSection: "templates",
      },
      {
        anchor: "sms.templates.novo",
        title: "Novo template",
        body: "Abre o formulário de criação logo abaixo.",
        articleSection: "templates",
      },
      {
        anchor: "sms.templates.mensagem",
        title: "Mensagem",
        body: "O texto do SMS, com a contagem de caracteres, a codificação e o número de partes.",
        articleSection: "templates",
      },
      {
        anchor: "sms.templates.links",
        title: "Inserir link",
        body: "Clique num chip para inserir o link da casa ou de uma URL rápida.",
        articleSection: "templates",
      },
      {
        anchor: "sms.templates.card",
        title: "Cartão de template",
        body: "Nome, versão, mensagem, categoria e etiquetas desse template.",
        articleSection: "templates",
      },
      {
        anchor: "sms.templates.editar",
        title: "Editar",
        body: "Abre o formulário com o conteúdo desse template.",
        articleSection: "templates",
      },
      {
        anchor: "sms.templates.menu",
        title: "Mais ações",
        body: "Duplicar ou Arquivar/Reativar o template.",
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
