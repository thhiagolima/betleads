// Help article for "Voz" (/ligacoes), quatro abas: Visão geral, Envio em
// massa, Áudios e roteiros e Histórico. Fonte: src/routes/ligacoes.tsx,
// src/components/channels/{channel-page,channel-tabs,channel-overview,
// channel-disabled-state}.tsx (barra/visão geral compartilhada com SMS/Email,
// prefixo "canal."), src/components/ligacoes/{dashboard-tab,bulk-call-tab,
// voice-assets-tab,voice-asset-upload-dialog,scripts-tab,script-form-dialog,
// variable-picker,queue-tab,shared}.tsx, src/components/history/history-shell.tsx
// (prefixo neutro "historico.", reaproveitado por SMS/Email — aqui com
// cardLabels/showsDelivery/showStep diferentes), src/components/providers-paused-banner.tsx,
// src/components/billing/active-tenant-wallet-notice.tsx e
// src/components/send-window-card.tsx. "Fluxos de voz" (antigo #fluxos) mudou
// para /automações e não faz parte deste artigo.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "ligacoes",
  route: "/ligacoes",
  defaultTab: "visao-geral",
  title: "Voz (Ligações)",
  purpose:
    "Visão geral das ligações, o disparo em massa com roteiro ou áudio fixo, a biblioteca de áudios e roteiros (com as configurações de voz gerada) e o histórico completo, incluindo a fila de ligações preparadas.",
  roles: ["admin", "gestor", "member", "expert"],
  terms: [
    "estabilidade-voz",
    "similaridade-voz",
    "estilo-voz",
    "velocidade-voz",
    "speaker-boost",
  ],
  sections: [
    // ---------------------------------------------------------------
    // Barra superior — compartilhada com /sms e /email (prefixo "canal.")
    // ---------------------------------------------------------------
    {
      id: "canal",
      title: "Barra superior (aparece nas 4 abas)",
      intro:
        "Esta faixa é a mesma em /sms, /email e /ligações: o botão de nova campanha, o aviso de disparos pausados, o aviso de saldo e a janela de envio. Fica acima das abas e não muda quando você troca de aba.",
      items: [
        {
          anchor: "canal.header.nova-campanha",
          label: "Nova campanha",
          what: 'Leva para /campanhas já com o canal "Voz" pré-selecionado no compositor.',
        },
        {
          anchor: "canal.abas",
          label: "Abas Visão geral / Envio em massa / Áudios e roteiros / Histórico",
          what: "Alternam entre o painel de números, o disparo em massa, a biblioteca de áudios e roteiros, e o histórico detalhado de ligações. A aba escolhida fica na URL (#visao-geral, #massa, #audios, #historico).",
          notes:
            'Os "Fluxos de voz" (jornadas automáticas de ligação) mudaram para /automações: um link antigo com #fluxos é levado para lá.',
        },
        {
          anchor: "canal.pausado.retomar",
          label: 'Faixa "Disparos de Ligações pausados" e botão Retomar disparos',
          what: 'Só aparece quando os disparos de voz da casa estão pausados (saldo esgotado no provedor, manutenção do provedor ou pausa manual). O botão "Retomar disparos" abre a confirmação "Retomar disparos de Ligações?", com a descrição de que os envios voltam a sair imediatamente e os botões "Cancelar" / "Retomar disparos".',
          notes:
            'Nada se perde enquanto pausado: campanhas e pendências continuam guardadas e são processadas quando o serviço voltar. Ao retomar, aparece o aviso "Disparos de Ligações retomados — fila vai drenar nos próximos segundos."',
        },
        {
          anchor: "canal.carteira.aviso",
          label: 'Aviso de saldo ("Seu saldo acabou" / "Saldo baixo")',
          what: 'Aparece só para casas que pagam por SMS/voz (não isentas) com o saldo zerado ou abaixo do limite de aviso da casa. O texto explica que SMS e voz ficam bloqueados sem saldo, mas o e-mail continua dentro da franquia mensal. Quando a casa pode comprar por Pix, o texto traz um link "Saldo e consumo" (para /plano-e-creditos); senão, pede para falar com o suporte.',
        },
        {
          anchor: "canal.janela.card",
          label: "Janela de envio",
          what: 'Faixa curta mostrando se o envio está "Dentro da janela de envio" ou "Fora da janela de envio — envios aguardando", com o horário permitido e, fora da janela, quando os envios retomam e quantos estão esperando.',
          notes:
            "A janela vale para todos os canais automáticos (SMS, e-mail e ligações) e é configurada em /configurações. Fora da janela, as ligações disparadas (em massa ou pela fila) ficam pendentes e saem no próximo horário permitido.",
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
        "Números do período escolhido, o gráfico de ligações, os roteiros mais usados e as ligações mais recentes.",
      items: [
        {
          anchor: "canal.periodo",
          label: 'Seletor de período ("Hoje", "Ontem", etc.)',
          what: "Escolhe a janela de tempo dos números, do gráfico e dos dois blocos abaixo.",
        },
        {
          anchor: "canal.kpis",
          label: 'KPIs: "Enviados", "Falhas", "Na fila" e "Atendidas"',
          what: '"Enviados" conta o total de ligações feitas no período, com quantas não foram atendidas ou deram ocupado. "Falhas" conta as ligações que não completaram (erro do provedor, número inválido etc.). "Na fila" conta as que ainda aguardam para ligar. "Atendidas" conta as ligações que a pessoa atendeu, com a porcentagem sobre o total.',
        },
        {
          anchor: "canal.grafico.envios",
          label: 'Gráfico "Envios por dia" / "Envios por hora"',
          what: 'Três séries por dia no período escolhido: "Total", "Atendidas" e "Falhas". Quando o período é um único dia (ex.: "Hoje"), o gráfico muda para "Envios por hora", com todas as tentativas de ligação por hora no horário de Brasília (nesse modo, as três séries somem e sobra uma única linha com o total de tentativas).',
        },
        {
          anchor: "ligacoes.visao.top-roteiros",
          label: '"Top roteiros"',
          what: 'Lista os roteiros mais usados no período, cada um com quantas ligações atenderam sobre o total ("N de M · X%") e uma barra de progresso com essa taxa. Um roteiro já excluído aparece como "Roteiro excluído".',
          notes: 'Sem nenhuma ligação com roteiro no período, mostra "Nenhuma ligação com roteiro no período."',
        },
        {
          anchor: "ligacoes.visao.recentes",
          label: '"Últimas ligações"',
          what: 'As 10 ligações mais recentes do período, cada uma com o nome do jogador (ou "Número avulso", quando a ligação foi para um número sem jogador vinculado), o roteiro usado (ou "Sem roteiro"), a duração em segundos quando houve, um selo de status e há quanto tempo foi feita.',
          notes: 'Sem nenhuma ligação no período, mostra "Nenhuma ligação no período."',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Envio em massa
    // ---------------------------------------------------------------
    {
      id: "massa",
      title: "Envio em massa",
      tab: "massa",
      intro:
        "Dispara ligações para vários jogadores de uma vez, lendo um roteiro com voz gerada ou reproduzindo um áudio fixo da biblioteca.",
      items: [
        {
          anchor: "ligacoes.massa.fonte",
          label: '"Fonte do áudio"',
          what: 'Escolhe entre "Roteiro com voz gerada" (lê um roteiro de texto com uma das vozes geradas) e "Áudio fixo da biblioteca" (reproduz um arquivo de áudio já enviado).',
        },
        {
          anchor: "ligacoes.massa.selecao",
          label: '"Roteiro" / "Áudio reutilizável"',
          what: 'Lista para escolher, conforme a fonte: os roteiros cadastrados (aba Áudios e roteiros) ou os áudios ativos da biblioteca. Sem nenhum roteiro cadastrado, aparece "Nenhum roteiro: crie um na aba Áudios e roteiros."; sem áudio ativo, aparece "Nenhum áudio ativo na biblioteca."',
          notes:
            'Um campo opcional de "Nome da campanha" (ao lado) só identifica o disparo para você mesmo; não é obrigatório.',
        },
        {
          anchor: "ligacoes.massa.busca",
          label: "Buscar jogadores",
          what: "Procura jogadores por nome ou telefone; cada resultado mostra o telefone e se é VIP ou o status. Clique num jogador para adicioná-lo aos destinatários — ele passa a mostrar “adicionado” e não pode ser clicado de novo.",
          notes: 'Enquanto busca, mostra "Buscando..."; sem resultado, mostra "Nenhum jogador encontrado".',
        },
        {
          anchor: "ligacoes.massa.avulsos",
          label: '"Ou cole números avulsos"',
          what: "Cole vários telefones separados por vírgula, ponto e vírgula, espaço ou linha — cada um vira um destinatário sem jogador vinculado. O texto abaixo mostra quantos números avulsos foram reconhecidos.",
          notes:
            "Sem jogador vinculado, as variáveis do roteiro (nome, saldo, etc.) ficam com o texto padrão (ex.: \"amigo\").",
        },
        {
          anchor: "ligacoes.massa.destinatarios",
          label: '"Destinatários (N)"',
          what: 'Lista cada destinatário adicionado (pelo jogador buscado ou pelo número avulso), com o telefone e se é "jogador" ou "avulso". O ícone de lixeira remove um destinatário vindo de jogador (os números avulsos colados se removem editando o texto de cima).',
          notes: 'Sem nenhum destinatário, mostra "Nenhum destinatário adicionado ainda."',
        },
        {
          anchor: "ligacoes.massa.resumo",
          label: '"Resumo do disparo"',
          what: 'Mostra o roteiro escolhido (ou "—"), o total de destinatários e o canal ("Voz") antes de disparar.',
        },
        {
          anchor: "ligacoes.massa.disparar",
          label: '"Disparar N ligações"',
          what: 'Abre a confirmação "Disparar N ligações?", com a descrição de que elas começam a ser disparadas agora e não podem ser canceladas, que o custo depende da duração de cada chamada e do contrato do provedor, e que fora da janela de envio as ligações ficam pendentes até o próximo horário permitido. Os botões são "Cancelar" / "Disparar N ligações".',
          notes:
            'Fica desabilitado sem roteiro/áudio escolhido ou sem destinatário. Depois do disparo aparece a caixa "Último disparo" com Total, Disparadas, Pendentes e Falhas; havendo falha, aparecem os detalhes de cada uma (veja os estados da tela). O aviso que aparece no canto da tela depende do resultado: "N ligações disparadas" quando tudo foi disparado sem falha nem pendência; "N ligação(ões) ficaram pendentes para retentativa" quando não houve falha mas alguma ficou pendente; "Falha em todas (N)" (com a descrição "Não foi possível concluir esta chamada. Tente novamente ou contate o suporte.") quando nenhuma foi disparada; e "N disparadas, M falharam" quando o resultado foi misto. Em qualquer um desses quatro, se parte dos destinatários não chegou a ser tentada por falta de saldo, o aviso ganha o complemento ", X não tentadas por saldo insuficiente". Se o disparo nem chegar a rodar (erro de rede ou de validação), aparece "Falha no disparo em massa" (ou a mensagem específica do servidor, quando houver uma).',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Áudios e roteiros — biblioteca de áudios
    // ---------------------------------------------------------------
    {
      id: "biblioteca-audios",
      title: "Biblioteca de áudios",
      tab: "audios",
      intro:
        "Ativos de áudio fixos (arquivos enviados, não voz gerada), reutilizáveis em jornadas, campanhas e no disparo em massa.",
      items: [
        {
          anchor: "ligacoes.audios.novo",
          label: "Novo áudio",
          what: 'Abre o diálogo "Enviar áudio fixo" para enviar um arquivo novo para a biblioteca.',
        },
        {
          anchor: "ligacoes.audios.busca",
          label: "Buscar por nome, tag, idioma ou origem",
          what: "Filtra a lista de áudios abaixo por qualquer um desses campos.",
        },
        {
          anchor: "ligacoes.audios.filtro",
          label: '"Ativos" / "Arquivados" / "Todos"',
          what: "Restringe a lista pelo estado do áudio (ativo por padrão).",
        },
        {
          anchor: "ligacoes.audios.cartao",
          label: "Cartão de áudio",
          what: 'Cada cartão mostra o nome, a origem ("Voz gerada", "Importado" ou "Upload"), se está "Arquivado", o idioma, a duração (quando conhecida), o tamanho em KB, as tags e a data da última atualização. Um áudio arquivado aparece com menos destaque (opacidade reduzida).',
          notes:
            'Os botões do cartão são "Ouvir" (reproduz o áudio no navegador), "Editar" (abre o formulário "Editar metadados" abaixo, com Nome, Tags e Idioma, e os botões "Salvar" — desabilitado sem nome — e "Cancelar", que ao gravar mostra "Metadados atualizados"), "Arquivar"/"Reativar" (o rótulo muda conforme o áudio estar ativo ou não; ao confirmar, mostra "Estado do áudio atualizado") e o ícone de lixeira, que pede a confirmação "Excluir áudio permanentemente?" e, ao excluir, mostra "Áudio e objeto de armazenamento excluídos" (veja os estados da tela).',
        },
        {
          label: 'Diálogo "Enviar áudio fixo"',
          what: 'Abre com a descrição "Adicione um áudio reutilizável à biblioteca. Formatos: MP3, WAV, M4A/MP4 ou OGG, até 50 MB." Os campos são: "Selecionar arquivo de áudio" (a área de clicar para escolher o arquivo; depois de escolhido, mostra o nome do arquivo e o tamanho em MB no lugar do texto), "Nome na biblioteca" (preenchido sozinho com o nome do arquivo, mas pode ser trocado), "Idioma" (texto livre, começa em "pt-BR") e "Tags" (palavras separadas por vírgula).',
          notes:
            'Os botões são "Cancelar" (fecha sem enviar) e "Enviar e selecionar" (desabilitado sem arquivo ou sem nome; mostra "Enviando…" enquanto sobe o arquivo e, ao terminar, "Áudio enviado e selecionado").',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Áudios e roteiros — roteiros
    // ---------------------------------------------------------------
    {
      id: "roteiros",
      title: "Roteiros",
      tab: "audios",
      intro:
        "Textos de fala reutilizáveis, lidos com voz gerada (não um arquivo de áudio fixo). Quando ligar é definido na campanha ou na automação que usa o roteiro.",
      items: [
        {
          anchor: "ligacoes.roteiros.novo",
          label: "Novo roteiro",
          what: 'Abre o diálogo "Novo roteiro", vazio.',
        },
        {
          anchor: "ligacoes.roteiros.tabela",
          label: "Tabela de roteiros",
          what: 'Cada linha mostra o nome, a versão (ex.: "v2"), o status (Ativo, Rascunho, Arquivado ou Inativo), quando foi atualizado e as ações Editar (abre o diálogo com o conteúdo desse roteiro) e Excluir.',
          notes:
            'Excluir pede a confirmação "Excluir \\"<nome>\\"?", com a descrição "O roteiro será removido e não poderá ser usado em novas ligações." e os botões "Cancelar" / "Excluir roteiro". Ao confirmar, mostra "Roteiro excluído"; se der erro, mostra a mensagem do servidor ou, na falta de uma, "Erro ao excluir".',
        },
        {
          label: 'Diálogo "Novo roteiro" / "Editar roteiro" — Nome, Status e Voz',
          what: '"Nome" identifica o roteiro na lista (obrigatório). "Status" define se o roteiro está Rascunho, Ativo ou Inativo. "Voz" escolhe qual voz gerada vai ler o texto, entre uma lista de vozes prontas (ex.: "George — masculino BR", "Sarah — feminino", "Laura — feminino jovem").',
        },
        {
          label: '"Variáveis disponíveis — clique para inserir"',
          what: 'Lista de chips como {primeiro_nome} ou {saldo}: clicar insere o texto no ponto do cursor dentro do campo "Conteúdo do roteiro". São as mesmas variáveis usadas em SMS e e-mail, trocadas pelo dado real do jogador quando a ligação é feita.',
        },
        {
          label: '"Conteúdo do roteiro"',
          what: "O texto que a voz gerada vai falar na ligação, com variáveis entre chaves para personalizar por jogador (obrigatório).",
          notes: 'Erro ao salvar sem nome ou sem conteúdo: "Nome e conteúdo são obrigatórios".',
        },
        {
          label: '"Prévia com jogador de teste"',
          what: "Mostra como o texto fica depois de trocar as variáveis pelos dados de um jogador fictício de exemplo, sem precisar salvar nem ligar para ninguém.",
        },
        {
          anchor: "ligacoes.roteiros.voz",
          label: '"Ajustes de voz": Estabilidade, Similaridade, Estilo, Velocidade e Speaker boost',
          what: 'Cinco controles deslizantes (mais um interruptor) que ajustam como a voz gerada fala este roteiro. "Estabilidade" controla o quanto a entonação varia: baixa deixa a fala mais expressiva e imprevisível, alta deixa mais uniforme e previsível. "Similaridade" controla o quanto a voz tenta se manter fiel ao timbre original escolhido; valores muito altos podem deixar pequenos ruídos. "Estilo" controla o quanto a fala exagera a expressão/emoção: baixo é mais neutro, alto é mais dramático (e menos estável). "Velocidade" é a velocidade da fala: menos que 1 fala mais devagar, mais que 1 fala mais rápido. "Speaker boost" (interruptor) reforça a semelhança com a voz original e a clareza ao telefone, ao custo de um processamento um pouco mais lento.',
          notes: "Novos roteiros já começam com valores equilibrados; a Prévia não reflete esses ajustes (ela só troca o texto, não gera áudio).",
        },
        {
          label: "Cancelar / Salvar roteiro",
          what: '"Cancelar" fecha sem salvar. "Salvar roteiro" grava o roteiro (novo ou alterado) e mostra "Roteiro criado" ou "Roteiro atualizado".',
          notes: 'Erro ao salvar: a mensagem do servidor, ou "Erro ao salvar roteiro" quando não houver uma mais específica.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Histórico — Fila de ligações + HistoryShell (prefixo neutro "historico.")
    // ---------------------------------------------------------------
    {
      id: "fila",
      title: "Fila de ligações",
      tab: "historico",
      intro:
        "Itens já preparados (áudio gerado ou escolhido) aguardando disponibilidade do canal de voz para ligar.",
      items: [
        {
          anchor: "ligacoes.fila.retentar",
          label: "Retentar pendentes",
          what: 'Tenta disparar de novo todos os itens com retentativa disponível. Ao terminar, mostra "Nenhuma ligação pendente para retentar", "N ligação(ões) disparada(s)" ou "N disparadas, M ainda falhando".',
          notes: 'Se o pedido em si falhar (erro de rede ou do servidor), mostra a mensagem do servidor ou, na falta de uma, "Erro ao retentar".',
        },
        {
          anchor: "ligacoes.fila.tabela",
          label: "Tabela da fila",
          what: 'Cada linha mostra o status ("Aguardando áudio", "Áudio pronto", "Na fila", "Processando envio", "Ligando", "Concluída", "Falhou", "Cancelada" ou "Pausada"), o telefone, um player de áudio (quando já tem um) e o horário programado.',
          notes: 'Sem nenhum item, mostra "Nenhum item na fila."; enquanto carrega, mostra "Carregando..."',
        },
        {
          label: "Ações da linha",
          what: '"Disparar agora" (só aparece com status "Áudio pronto") dispara a ligação na hora, mostrando "Ligação disparada" ou "Ligação pendente para retentativa". "Pausar"/"Retomar" alterna o item entre pausado e pronto (desabilitado quando cancelado, concluído ou falhou). "Cancelar" cancela o item e mostra "Item cancelado" (desabilitado quando já cancelado ou concluído).',
          notes: 'Erros possíveis: "Erro ao disparar", "Erro ao atualizar" e "Erro ao cancelar" (ou a mensagem do servidor, quando houver uma mais específica).',
        },
      ],
    },
    {
      id: "historico",
      title: "Histórico",
      tab: "historico",
      intro:
        "Todas as ligações feitas para os jogadores, com filtros, um ranking por jornada e o detalhe de cada ligação. Esta tela (HistoryShell) é a mesma base usada pelo histórico de SMS e de Email, com os cartões e os nomes ajustados para voz.",
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
          label: 'Cartões "Ligações", "Atendidas", "Não atendidas / falhas", "Pendentes" e "Convertidas"',
          what: '"Ligações" é o total de tentativas no período, com a variação percentual contra o período anterior. "Atendidas" mostra quantas a pessoa atendeu, com a taxa de atendimento ao lado (diferente de SMS e e-mail, o provedor de voz confirma se a ligação foi atendida). "Não atendidas / falhas" conta as que não foram atendidas ou falharam. "Pendentes" conta as que ainda aguardam. "Convertidas" conta jogadores que depositaram depois da ligação.',
        },
        {
          anchor: "historico.grafico",
          label: 'Gráfico "Envios por dia" / "Envios por hora"',
          what: "Mini gráfico de barras com o total de ligações por dia (ou por hora, quando o período é um único dia), com o total geral do período ao lado do título.",
          notes: "Só aparece quando há mais de um ponto no período — com um único ponto, o gráfico fica escondido.",
        },
        {
          anchor: "historico.jornadas",
          label: "Jornadas com mais envios",
          what: 'Tabela com as jornadas que mais ligaram no período, cada uma com envios, atendidas/falhas e a última ligação. Clicar numa linha filtra a tabela de baixo por aquela jornada; "Limpar seleção" tira o filtro.',
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
          notes:
            'Diferente de SMS e e-mail, esta tela não tem o filtro "Dia da jornada" (a coluna "Dia" também não aparece na tabela), porque as ligações não seguem etapas de jornada numeradas do mesmo jeito.',
        },
        {
          anchor: "historico.filtros.busca",
          label: "Busca",
          what: "Procura por nome, telefone ou e-mail do jogador na tabela abaixo.",
        },
        {
          anchor: "historico.tabela",
          label: "Tabela de ligações",
          what: 'Cada linha mostra data, jogador, contato (o telefone), a jornada, o status e se houve conversão. Clicar numa linha abre a gaveta de detalhe.',
          notes:
            '"Anterior" / "Próxima" (abaixo da tabela) passam as páginas, 50 registros por vez.',
        },
        {
          label: "Gaveta de detalhe",
          what: 'Abre ao clicar numa linha da tabela: canal e status no topo, data completa, e os campos Jogador, Contato, Jornada, Dia da jornada, Template / assunto e Mensagem. Quando a ligação falhou, mostra "Falha no envio" com o erro; quando o jogador depositou depois, mostra o aviso de conversão (72h).',
          notes:
            'O campo "Dia da jornada" aparece mesmo sem a coluna correspondente na tabela. Os botões "Ver jogador" (abre a ficha do jogador numa aba nova), "Copiar mensagem" e "Copiar erro" (quando há erro) ficam na parte de baixo da gaveta.',
        },
      ],
    },
  ],

  states: [
    {
      id: "canal-pausado",
      title: "Disparos de Ligações pausados",
      what: 'Faixa de aviso mostrada quando os disparos de voz da casa estão pausados, com o motivo quando reconhecido ("Saldo esgotado no provedor de envio.", "Provedor de envio em manutenção." ou "Pausado manualmente."). Nada é perdido: campanhas e pendências continuam guardadas.',
      action: 'Clique em "Retomar disparos" (depois de confirmar "Retomar disparos de Ligações?") para voltar a ligar — aparece o aviso "Disparos de Ligações retomados — fila vai drenar nos próximos segundos."',
    },
    {
      id: "canal-saldo-baixo",
      title: '"Seu saldo acabou" / "Saldo baixo"',
      what: "Aviso mostrado só para casas que pagam por SMS/voz (não isentas) com saldo zerado ou perto do limite de aviso. Enquanto o saldo estiver zerado, SMS e voz ficam bloqueados; o e-mail continua dentro da franquia mensal.",
      action: 'Compre créditos por Pix em "Saldo e consumo" (quando disponível) ou fale com o suporte.',
    },
    {
      id: "canal-desabilitado",
      title: "Canal Voz desabilitado",
      what: 'Tela cheia mostrada no lugar de toda a página (sem abas, sem "Nova campanha") quando o super admin desligou o canal de voz desta casa e alguém chega em /ligacoes por um link, favorito ou automação antiga. A mensagem exata é "O canal Voz está desabilitado para esta casa."',
      action: "Fale com o suporte para reativar o canal, se precisar dele de volta.",
    },
    {
      id: "massa-sem-roteiro",
      title: "Nenhum roteiro: crie um na aba Áudios e roteiros.",
      what: 'Mostrado no lugar da lista, no seletor de roteiro do Envio em massa, quando a casa ainda não tem nenhum roteiro cadastrado.',
      action: 'Vá para a aba "Áudios e roteiros" e clique em "Novo roteiro".',
    },
    {
      id: "massa-sem-audio",
      title: "Nenhum áudio ativo na biblioteca.",
      what: 'Mostrado no lugar da lista, no seletor de áudio do Envio em massa, quando a casa não tem nenhum áudio ativo na biblioteca.',
      action: 'Vá para a aba "Áudios e roteiros" e clique em "Novo áudio".',
    },
    {
      id: "massa-sem-destinatario",
      title: "Nenhum destinatário adicionado ainda.",
      what: "Texto mostrado no cartão de Destinatários do Envio em massa antes de buscar um jogador ou colar algum número avulso.",
    },
    {
      id: "massa-disparo-sucesso",
      title: "N ligações disparadas",
      what: 'Aviso de sucesso depois de um disparo em massa em que nada falhou e nada ficou pendente: todas as ligações preparadas foram enviadas ao provedor.',
    },
    {
      id: "massa-disparo-pendente",
      title: "N ligação(ões) ficaram pendentes para retentativa",
      what: 'Aviso mostrado quando nenhuma ligação falhou de verdade, mas parte delas não pôde ser disparada na hora (ex.: fora da janela de envio) e ficou aguardando uma nova tentativa.',
      action: 'Acompanhe pela Fila de ligações ou pelo Histórico; o sistema tenta de novo sozinho.',
    },
    {
      id: "massa-disparo-falha-todas",
      title: "Falha em todas (N)",
      what: 'Erro mostrado quando nenhuma ligação do disparo em massa foi enviada. A descrição do aviso é "Não foi possível concluir esta chamada. Tente novamente ou contate o suporte."',
      action: "Corrija o que for apontado nos detalhes (ver estado seguinte) e dispare de novo.",
    },
    {
      id: "massa-disparo-parcial",
      title: "N disparadas, M falharam",
      what: "Aviso misto mostrado quando parte das ligações foi disparada e parte falhou.",
    },
    {
      id: "massa-disparo-nao-tentadas",
      title: ", N não tentadas por saldo insuficiente",
      what: 'Complemento que se junta a qualquer um dos quatro avisos acima quando parte dos destinatários nem chegou a ser tentada por falta de saldo na carteira da casa.',
      action: 'Compre créditos em "Saldo e consumo" e dispare de novo só para quem faltou.',
    },
    {
      id: "massa-disparo-erro-geral",
      title: "Falha no disparo em massa",
      what: 'Erro mostrado quando o próprio pedido de disparo em massa não chega a rodar (falha de rede ou de validação) — nenhuma ligação chega a ser preparada. Quando o servidor devolve uma mensagem mais específica, ela aparece no lugar deste texto padrão.',
      action: "Tente disparar de novo; se persistir, contate o suporte.",
    },
    {
      id: "massa-falha-audio",
      title: "Áudio temporariamente indisponível",
      what: 'Aviso mostrado depois de um disparo em massa quando todas as falhas tiverem a mesma causa: o serviço de voz não conseguiu acessar o áudio. O texto completo é "O serviço de voz não conseguiu acessar o áudio. Tente novamente mais tarde ou contate o suporte; os dados preparados foram preservados."',
      action: "Tente disparar de novo mais tarde ou contate o suporte; nada precisa ser refeito.",
    },
    {
      id: "massa-falhas-detalhadas",
      title: "Falhas detalhadas (N)",
      what: 'Lista, depois de um disparo em massa com alguma falha, cada destinatário que não foi chamado com a mensagem "Não foi possível concluir esta chamada. Tente novamente ou contate o suporte."',
    },
    {
      id: "audios-vazio",
      title: "Nenhum áudio encontrado",
      what: 'Mostrado na aba Áudios e roteiros quando a busca/filtro não encontra nenhum áudio (ou a biblioteca está vazia). O texto completo é "Envie o primeiro ativo ou ajuste a busca e o filtro."',
      action: 'Clique em "Enviar áudio" (ou "Novo áudio") para enviar o primeiro.',
    },
    {
      id: "audios-upload-erro",
      title: '"Formato inválido. Envie MP3, WAV, M4A/MP4 ou OGG." / "O áudio deve ter no máximo 50 MB."',
      what: 'Erros ao enviar um áudio na biblioteca: arquivo de um formato não aceito, ou maior que 50 MB. "Selecione o áudio e informe um nome." aparece ao tentar enviar sem escolher o arquivo ou sem nome.',
      action: "Escolha um arquivo nos formatos aceitos e dentro do limite, informe um nome e tente de novo.",
    },
    {
      id: "audios-excluir-confirmacao",
      title: "Excluir áudio permanentemente?",
      what: 'Confirmação ao clicar no ícone de lixeira de um áudio: "O arquivo será removido do armazenamento. Áudios referenciados não podem ser excluídos; nesses casos, arquive o item." Botões "Cancelar" / "Excluir áudio".',
      action: "Se o áudio ainda estiver em uso em alguma jornada ou campanha, arquive em vez de excluir.",
    },
    {
      id: "roteiros-vazio",
      title: "Nenhum roteiro criado ainda.",
      what: "Texto mostrado na lista de roteiros quando a casa ainda não tem nenhum.",
      action: 'Clique em "Novo roteiro" para criar o primeiro.',
    },
    {
      id: "roteiros-excluir-confirmacao",
      title: 'Excluir "<nome>"?',
      what: 'Confirmação ao excluir um roteiro: "O roteiro será removido e não poderá ser usado em novas ligações." Botões "Cancelar" / "Excluir roteiro".',
    },
    {
      id: "roteiro-form-obrigatorios",
      title: "Nome e conteúdo são obrigatórios",
      what: 'Erro ao salvar o diálogo de roteiro com o campo Nome ou o Conteúdo do roteiro vazio.',
      action: "Preencha os dois campos e salve de novo.",
    },
    {
      id: "fila-vazia",
      title: "Nenhum item na fila.",
      what: "Texto mostrado na Fila de ligações quando não há nenhum item preparado aguardando.",
    },
    {
      id: "historico-sem-jornada",
      title: "Nenhum envio por jornada no período.",
      what: 'Texto mostrado em "Jornadas com mais envios" quando nenhuma jornada ligou no período escolhido.',
    },
    {
      id: "historico-vazio",
      title: "Nenhum registro com esses filtros. / Nenhuma ligação nesse período.",
      what: "Texto mostrado na tabela do Histórico quando a busca não encontra nada: a primeira frase quando algum filtro está ativo, a segunda quando não há filtro nenhum e simplesmente não houve ligação no período.",
      action: 'Com algum filtro ativo, aparece um botão "Limpar filtros" para voltar a ver tudo.',
    },
  ],

  tours: {
    "visao-geral": [
      {
        anchor: "canal.header.nova-campanha",
        title: "Nova campanha",
        body: "Começa uma campanha de voz já no canal certo.",
        articleSection: "canal",
      },
      {
        anchor: "canal.abas",
        title: "Abas",
        body: "Visão geral, Envio em massa, Áudios e roteiros e Histórico — a aba escolhida fica na URL.",
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
        body: "Enviados, Falhas, Na fila e Atendidas, com a porcentagem sobre o total.",
        articleSection: "visao-geral",
      },
      {
        anchor: "canal.grafico.envios",
        title: "Envios por dia",
        body: "Total, Atendidas e Falhas por dia (ou por hora, num único dia).",
        articleSection: "visao-geral",
      },
      {
        anchor: "ligacoes.visao.top-roteiros",
        title: "Top roteiros",
        body: "Os roteiros mais usados no período e quantos atenderam.",
        articleSection: "visao-geral",
      },
      {
        anchor: "ligacoes.visao.recentes",
        title: "Últimas ligações",
        body: "As 10 ligações mais recentes, com o status de cada uma.",
        articleSection: "visao-geral",
      },
    ],
    massa: [
      {
        anchor: "canal.abas",
        title: "Você está em Envio em massa",
        body: "Dispara ligações para vários jogadores de uma vez.",
        articleSection: "massa",
      },
      {
        anchor: "ligacoes.massa.fonte",
        title: "Fonte do áudio",
        body: "Roteiro com voz gerada ou áudio fixo da biblioteca.",
        articleSection: "massa",
      },
      {
        anchor: "ligacoes.massa.selecao",
        title: "Roteiro ou áudio",
        body: "Escolha qual roteiro ou áudio vai ser usado nas ligações.",
        articleSection: "massa",
      },
      {
        anchor: "ligacoes.massa.busca",
        title: "Buscar jogadores",
        body: "Clique num jogador para adicioná-lo aos destinatários.",
        articleSection: "massa",
      },
      {
        anchor: "ligacoes.massa.avulsos",
        title: "Números avulsos",
        body: "Cole números sem jogador vinculado para ligar para eles também.",
        articleSection: "massa",
      },
      {
        anchor: "ligacoes.massa.destinatarios",
        title: "Destinatários",
        body: "Todos os jogadores e números que vão receber a ligação.",
        articleSection: "massa",
      },
      {
        anchor: "ligacoes.massa.resumo",
        title: "Resumo do disparo",
        body: "Confira o roteiro e o total de destinatários antes de disparar.",
        articleSection: "massa",
      },
      {
        anchor: "ligacoes.massa.disparar",
        title: "Disparar ligações",
        body: "Dispara agora, depois de confirmar — não pode ser cancelado.",
        articleSection: "massa",
      },
    ],
    audios: [
      {
        anchor: "canal.abas",
        title: "Você está em Áudios e roteiros",
        body: "A biblioteca de áudios fixos e os roteiros de voz gerada.",
        articleSection: "biblioteca-audios",
      },
      {
        anchor: "ligacoes.audios.novo",
        title: "Novo áudio",
        body: "Envia um arquivo de áudio para a biblioteca.",
        articleSection: "biblioteca-audios",
      },
      {
        anchor: "ligacoes.audios.busca",
        title: "Buscar áudio",
        body: "Procure por nome, tag, idioma ou origem.",
        articleSection: "biblioteca-audios",
      },
      {
        anchor: "ligacoes.audios.filtro",
        title: "Filtro",
        body: "Mostra só os ativos, só os arquivados ou todos.",
        articleSection: "biblioteca-audios",
      },
      {
        anchor: "ligacoes.audios.cartao",
        title: "Cartão de áudio",
        body: "Ouvir, editar, arquivar/reativar ou excluir esse áudio.",
        articleSection: "biblioteca-audios",
      },
      {
        anchor: "ligacoes.roteiros.novo",
        title: "Novo roteiro",
        body: "Abre o diálogo para criar um roteiro com voz gerada.",
        articleSection: "roteiros",
      },
      {
        anchor: "ligacoes.roteiros.tabela",
        title: "Tabela de roteiros",
        body: "Nome, versão, status e as ações de cada roteiro.",
        articleSection: "roteiros",
      },
    ],
    historico: [
      {
        anchor: "canal.abas",
        title: "Você está em Histórico",
        body: "A fila de ligações e o histórico completo de ligações.",
        articleSection: "fila",
      },
      {
        anchor: "ligacoes.fila.retentar",
        title: "Retentar pendentes",
        body: "Tenta de novo todos os itens da fila com retentativa disponível.",
        articleSection: "fila",
      },
      {
        anchor: "ligacoes.fila.tabela",
        title: "Fila de ligações",
        body: "Itens já preparados aguardando disponibilidade do canal.",
        articleSection: "fila",
      },
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
        body: "Ligações, Atendidas, Não atendidas / falhas, Pendentes e Convertidas.",
        articleSection: "historico",
      },
      {
        anchor: "historico.jornadas",
        title: "Jornadas com mais envios",
        body: "Clique numa jornada para filtrar a tabela abaixo.",
        articleSection: "historico",
      },
      {
        anchor: "historico.tabela",
        title: "Tabela de ligações",
        body: "Cada linha abre o detalhe completo daquela ligação.",
        articleSection: "historico",
      },
    ],
  },
};

export default screen;
