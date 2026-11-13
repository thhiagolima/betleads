// Help article for "Jogadores" (/players), duas abas: Lista e Acompanhamento
// (hash #acompanhamento; sem hash cai em Lista). Fonte: src/routes/players.tsx
// (cabeçalho, KPIs, busca, chips de Situação/Nível, chips ativos, seleção em
// massa, tabela desktop + cartões no celular, paginação, a gaveta "Mais
// filtros" inteira e a aba Acompanhamento com as 3 filas), mais
// src/components/players/segmented-filter.tsx (Situação/Nível/fila/operador),
// src/components/whatsapp/send-dialog.tsx (diálogo "Enviar WhatsApp para X")
// e src/components/history/player-contact-history.tsx (diálogo "Histórico de
// contatos") — os dois só abrem a partir da aba Acompanhamento.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "jogadores",
  route: "/players",
  defaultTab: "lista",
  title: "Jogadores",
  purpose:
    "A base de jogadores da casa: busca, filtros por situação/nível/comportamento/período, seleção para campanha e a fila de acompanhamento de quem já recebeu contato.",
  roles: ["admin", "gestor", "member"],
  sections: [
    // ---------------------------------------------------------------
    // Cabeçalho e KPIs — aparecem nas duas abas
    // ---------------------------------------------------------------
    {
      id: "cabecalho",
      title: "Cabeçalho e números (aparecem nas 2 abas)",
      intro:
        "Ficam acima das abas Lista/Acompanhamento e não mudam quando você troca de aba.",
      items: [
        {
          anchor: "jogadores.cabecalho.campanha",
          label: "Usar na campanha",
          what: "Leva para /campanhas já com o público atual pronto: todos os jogadores que combinam com a busca e os filtros ligados agora (não só os da página visível).",
          notes:
            'Fica desabilitado quando o filtro atual não encontra nenhum jogador. Com filtros de "Oportunidades" (os sinais calculados no navegador), o público usa a lista completa já carregada. Erro "Não foi possível montar o público" se a busca dos IDs do filtro falhar; "Nenhum jogador selecionado." se a lista ficar vazia nessa hora; "Não foi possível preparar o público da campanha." se a gravação do público falhar no servidor.',
        },
        {
          anchor: "jogadores.cabecalho.mais-acoes",
          label: "Mais ações",
          what: 'Abre um menu com "Exportar CSV" e "Copiar IDs da plataforma".',
        },
        {
          anchor: "jogadores.cabecalho.exportar-csv",
          label: "Exportar CSV",
          what: "Baixa em CSV todos os jogadores do filtro atual (não só a página visível).",
          notes:
            'Erro "Nenhum jogador para exportar nesse filtro." quando o filtro não encontra ninguém, ou "Não foi possível exportar o CSV" se a busca falhar. Quando o filtro é grande, o texto de sucesso avisa um limite e pede para refinar o filtro para exportar o resto ("Limite de N de M jogadores atingido; refine o filtro para exportar o resto.").',
        },
        {
          anchor: "jogadores.cabecalho.copiar-ids",
          label: "Copiar IDs da plataforma",
          what: "Copia para a área de transferência o ID na plataforma (player_external_id) de todos os jogadores do filtro atual, um por linha, sem repetir.",
          notes:
            'Erro "Nenhum ID da plataforma neste filtro." quando nenhum jogador do filtro tem ID cadastrado, ou "Não foi possível copiar os IDs" se a busca falhar. Quando alguns têm e outros não, o texto de sucesso avisa quantos ficaram de fora ("N IDs copiados. M jogadores sem ID da plataforma ficaram de fora.").',
        },
        {
          anchor: "jogadores.kpis",
          label: 'KPIs: "Jogadores", "Já depositaram", "Depositado no total" e "VIPs esfriando"',
          what: '"Jogadores" é o total da base. "Já depositaram" mostra também a % da base. "Depositado no total" soma todos os depósitos aprovados de todos os tempos. "VIPs esfriando" conta jogadores no nível VIP (o nível mínimo configurado, normalmente Diamante) sem depositar há alguns dias seguidos (o número de dias também é configurável) — a legenda embaixo do número mostra os critérios exatos da casa.',
        },
        {
          anchor: "jogadores.abas",
          label: "Abas Lista / Acompanhamento",
          what: 'Alternam entre a lista completa de jogadores (com busca, filtros e seleção) e a fila de acompanhamento de contatos já feitos. A aba escolhida fica na URL ("#acompanhamento" para a segunda; a primeira não usa hash).',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Lista — busca, chips, seleção, tabela, paginação
    // ---------------------------------------------------------------
    {
      id: "lista",
      title: "Lista",
      tab: "lista",
      intro:
        "A tabela principal de jogadores, com busca, filtros rápidos na barra e a gaveta \"Mais filtros\" para o resto.",
      items: [
        {
          anchor: "jogadores.lista.busca",
          label: "Buscar por nome, telefone, e-mail ou ID",
          what: "Filtra a lista por qualquer um desses campos enquanto você digita (meio segundo de espera antes de buscar). O X que aparece dentro do campo limpa a busca.",
        },
        {
          anchor: "jogadores.lista.mais-filtros",
          label: "Mais filtros",
          what: 'Abre a gaveta "Mais filtros", com período, situação, nível, comportamento e oportunidades combinados. O número ao lado do botão mostra quantos desses filtros extras estão ligados agora.',
        },
        {
          anchor: "jogadores.lista.situacao",
          label: "Chips de Situação",
          what: 'Filtra por "Ativos", "Esfriando", "Dormindo" ou "Sem depósito" (mais "Todas as situações" para remover o filtro). Cada chip mostra quantos jogadores há nessa situação, considerando o nível já escolhido ao lado.',
          notes:
            '"Sem depósito" não combina com um nível pago: escolher um desconfigura o outro automaticamente, porque quem nunca depositou não tem nível pago.',
        },
        {
          anchor: "jogadores.lista.nivel",
          label: "Chips de Nível",
          what: 'Filtra por Bronze, Prata, Ouro, Diamante ou Black (mais "Todos os níveis"). O nível é calculado pelo total depositado pelo jogador, com os limites configurados em Gamificação. Cada chip mostra quantos jogadores há nesse nível, considerando a situação já escolhida ao lado.',
        },
        {
          anchor: "jogadores.lista.chip-ativo",
          label: "Chips dos filtros ativos",
          what: "Um chip por filtro ligado no momento (comportamento escolhido na gaveta, período escolhido na gaveta). Cada chip tem um X para remover só aquele filtro.",
          notes:
            'Situação, Nível e a busca não entram aqui — eles já aparecem destacados nos próprios controles da barra. Esta linha só aparece quando existe pelo menos um filtro desse tipo ligado.',
        },
        {
          anchor: "jogadores.lista.limpar-tudo",
          label: "Limpar tudo",
          what: "Remove de uma vez a busca, o filtro de comportamento, o período, a situação e o nível, voltando a mostrar a base inteira.",
        },
        {
          label: 'Contador "N jogadores" e seleção em massa',
          what: 'Mostra quantos jogadores combinam com o filtro atual (um giradouro aparece ao lado enquanto atualiza). Ao marcar pelo menos um jogador, o texto é substituído pelas ações de seleção.',
        },
        {
          anchor: "jogadores.lista.selecionar-todos",
          label: "Selecionar todos desta página (caixinha no cabeçalho)",
          what: "Marca ou desmarca de uma vez todos os jogadores da página visível.",
        },
        {
          anchor: "jogadores.lista.selecionar-linha",
          label: "Selecionar jogador (caixinha da linha / toque no celular)",
          what: "Marca um jogador para uma ação em massa. No desktop é uma caixinha na linha da tabela; no celular, é preciso tocar em \"Selecionar\" primeiro para o toque na linha marcar em vez de abrir a ficha. Repete-se em cada linha; a âncora marca só a primeira.",
          notes: "A seleção é mantida ao trocar de página, mas é limpa ao trocar filtro ou busca.",
        },
        {
          anchor: "jogadores.lista.usar-selecionados",
          label: "Usar selecionados na campanha",
          what: "Leva para /campanhas com o público formado só pelos jogadores marcados.",
          notes: 'Erro "Nenhum jogador selecionado." (não deveria ocorrer aqui, pois o botão só aparece com ao menos 1 marcado) ou "Não foi possível preparar o público da campanha." se a gravação falhar no servidor.',
        },
        {
          anchor: "jogadores.lista.copiar-selecionados",
          label: "Copiar IDs (seleção)",
          what: "Copia o ID na plataforma dos jogadores marcados, um por linha.",
          notes: 'Erro "Nenhum ID da plataforma entre os selecionados." quando nenhum marcado tem ID.',
        },
        {
          anchor: "jogadores.lista.limpar-selecao",
          label: "Limpar seleção",
          what: "Desmarca todos os jogadores selecionados.",
        },
        {
          anchor: "jogadores.lista.ordenar-mobile",
          label: "Ordenar por (celular)",
          what: 'No celular, escolhe a ordem da lista: "Ordem padrão", "Maior total depositado", "Último depósito mais recente" ou "Último acesso mais recente". No desktop a ordenação é feita clicando nas colunas (veja "Colunas").',
        },
        {
          anchor: "jogadores.lista.selecionar-mobile",
          label: '"Selecionar" / "Cancelar" (celular)',
          what: "Liga ou desliga o modo de seleção no celular. Com ele ligado, tocar num cartão marca o jogador em vez de abrir a ficha.",
        },
        {
          anchor: "jogadores.lista.colunas",
          label: 'Colunas: Jogador, Nível, Situação, Depósitos, Total depositado, Último depósito, Veio de',
          what: '"Jogador" mostra o nome, a bolinha de risco (verde/amarela/vermelha), a coroa quando é VIP, o selo "Aguardando" quando o jogador recebeu mensagem e ainda não teve desfecho registrado, e o ID da plataforma com um botão para copiar. "Nível" e "Situação" repetem os mesmos chips da barra. "Depósitos" conta quantos depósitos aprovados o jogador já fez. "Veio de" mostra o expert ou a origem declarada, com a tag/sub-origem embaixo quando existe. "Total depositado", "Último depósito" e "Veio de" são clicáveis: clicar ordena a lista por aquela coluna (um clique por ordem decrescente, outro por crescente, um terceiro volta à ordem padrão do filtro).',
        },
        {
          anchor: "jogadores.lista.copiar-id-linha",
          label: "Copiar ID (sob o nome do jogador)",
          what: "Copia o ID na plataforma daquele jogador. Troca para \"ID copiado\" por 1,5 segundo depois de copiar. Só aparece quando o jogador tem ID cadastrado. Repete-se em cada linha; a âncora marca só a primeira.",
          notes: 'Erro "Este jogador não tem ID da plataforma." se o jogador perder o ID entre a tela carregar e você clicar.',
        },
        {
          anchor: "jogadores.lista.abrir-ficha",
          label: "Abrir a ficha do jogador",
          what: "Leva para a ficha completa do jogador (/players/ID). No desktop, clique no nome ou na seta no fim da linha; no celular, toque em qualquer lugar do cartão (fora do modo de seleção). Repete-se em cada linha; a âncora marca só a primeira.",
        },
        {
          anchor: "jogadores.lista.paginacao",
          label: "Paginação",
          what: '50 jogadores por página. Mostra o intervalo atual ("1–50 de 320") e os botões "Anterior" / "Próxima". Só aparece quando o filtro tem mais de 50 jogadores.',
        },
        {
          label: "Estado vazio da lista",
          what: '"Nenhum jogador encontrado", com "Nenhum jogador combina com a busca e os filtros escolhidos." quando há algum filtro ligado, ou "Os jogadores aparecem aqui assim que a casa enviar o primeiro cadastro." quando a base está mesmo vazia. Com algum filtro ligado, aparece o botão "Limpar filtros".',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Gaveta "Mais filtros" (tab: lista) — inteira
    // ---------------------------------------------------------------
    {
      id: "gaveta-filtros",
      title: 'Gaveta "Mais filtros"',
      tab: "lista",
      intro:
        "Combina período, situação, nível, comportamento e oportunidades. As escolhas só valem de fato depois de clicar em \"Ver jogadores\" — fechar a gaveta sem clicar descarta o que você mudou nela.",
      items: [
        {
          anchor: "jogadores.filtros.periodo-campo",
          label: '"FTD (1º depósito)" / "Cadastro" (campo de data usada no período)',
          what: "Escolhe se o período abaixo filtra pela data do primeiro depósito (FTD) ou pela data de cadastro do jogador.",
        },
        {
          anchor: "jogadores.filtros.periodo-calendario",
          label: "Escolher período (calendário)",
          what: 'Abre um calendário com um intervalo de datas e os atalhos "Hoje", "7 dias", "30 dias" e "90 dias".',
        },
        {
          anchor: "jogadores.filtros.limpar-periodo",
          label: "Limpar período",
          what: "Remove o período escolhido. Só aparece quando um período está escolhido.",
        },
        {
          anchor: "jogadores.filtros.situacao",
          label: "Chips de Situação (na gaveta)",
          what: 'Mesma escolha da barra ("Ativos", "Esfriando", "Dormindo", "Sem depósito"), aqui dentro da gaveta, com a contagem de cada uma.',
          notes: '"Sem depósito" não combina com nível pago — escolher um desliga o outro.',
        },
        {
          anchor: "jogadores.filtros.nivel",
          label: "Chips de Nível (na gaveta)",
          what: "Mesma escolha da barra (Bronze a Black), aqui dentro da gaveta, com a contagem de cada um.",
        },
        {
          anchor: "jogadores.filtros.operador",
          label: '"Todas as condições" / "Qualquer condição"',
          what: 'Decide como os chips de Comportamento marcados se combinam: "Todas as condições" (E — o jogador precisa atender a todos os marcados) ou "Qualquer condição" (OU — basta atender a um deles).',
        },
        {
          anchor: "jogadores.filtros.comportamento-atividade",
          label: 'Chips de "Atividade e depósitos" (Ativos nos últimos 4 dias, Depositaram hoje, FTD hoje, Cashback pago hoje, Ativos e depositaram na semana, Saldo disponível)',
          what: "Seis atalhos de comportamento recente: jogadores ativos nos últimos 4 dias, que depositaram hoje, que tiveram o primeiro depósito hoje, que receberam cashback hoje, que estão ativos e depositaram na semana, e que têm saldo disponível (ativos nos últimos 60 dias). O número ao lado de cada chip mostra quantos jogadores ele encontra com os outros filtros da gaveta já aplicados.",
        },
        {
          anchor: "jogadores.filtros.comportamento-risco",
          label: '"Valor e risco" (VIP, Faltando pouco pro VIP, VIP sem atividade há 7+ dias, 5 a 7 / 7+ / 7 a 14 / 15 a 24 / 25 a 34 / 35 a 44 / 45 a 59 / 60+ dias sem atividade)',
          what: "Onze atalhos combinando valor do jogador e tempo parado, do mais recente (5 a 7 dias sem atividade) ao mais antigo (60+ dias sem atividade), mais os três de VIP (VIP, faltando pouco pro VIP e VIP sem atividade há 7+ dias). O número ao lado de cada chip mostra quantos jogadores ele encontra com os outros filtros da gaveta já aplicados.",
        },
        {
          anchor: "jogadores.filtros.oportunidades",
          label: 'Chips de Oportunidades (VIP recuperável, VIP esfriando, Queda de depósitos, Quente esfriando, Quase VIP, Alto potencial, Reativado, Em sequência, Saldo parado, Logando sem depositar, Frequência caindo)',
          what: 'Onze sinais calculados pelo CRM para agir agora — a mesma lógica da tela de Eventos/Alertas: quando a casa manda mensagem para um desses jogadores, ele some do filtro. Só é possível marcar um por vez (marcar outro desmarca o anterior); a contagem de cada um só aparece depois de aplicado (clicar em "Ver jogadores"), não dentro da gaveta.',
        },
        {
          anchor: "jogadores.filtros.limpar",
          label: "Limpar filtros (rodapé)",
          what: "Zera, dentro da gaveta, o comportamento, a situação, o nível e o período escolhidos (sem fechar a gaveta). Fica desabilitado quando não há nada para limpar.",
        },
        {
          anchor: "jogadores.filtros.aplicar",
          label: "Ver jogadores (rodapé)",
          what: 'Aplica as escolhas da gaveta à lista e fecha a gaveta. Quando o CRM já sabe o total, o botão mostra o número ("Ver 128 jogadores"); senão mostra só "Ver jogadores".',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Acompanhamento
    // ---------------------------------------------------------------
    {
      id: "acompanhamento",
      title: "Acompanhamento",
      tab: "acompanhamento",
      intro:
        "Jogadores que já receberam uma mensagem de oportunidade e o desfecho desse contato. Marcar o desfecho tira o jogador da fila de \"Aguardando conversão\".",
      items: [
        {
          anchor: "jogadores.acompanhamento.fila",
          label: 'Fila: "Aguardando conversão" / "Converteu" / "Não converteu"',
          what: '"Aguardando conversão" lista quem foi contatado nos últimos 5 dias e ainda não teve desfecho marcado. "Converteu" e "Não converteu" listam os desfechos marcados nos últimos 30 dias. O número ao lado de cada fila mostra quantos jogadores há nela.',
        },
        {
          label: 'Selo "depositou depois do contato"',
          what: 'Aparece nas filas de desfecho quando o CRM percebeu, sozinho, que o jogador depositou depois do contato (mesmo que o desfecho tenha sido marcado como "Não converteu" na hora).',
        },
        {
          anchor: "jogadores.acompanhamento.historico",
          label: "Histórico",
          what: 'Abre o diálogo "Histórico de contatos" deste jogador. Repete-se em cada linha; a âncora marca só a primeira.',
        },
        {
          anchor: "jogadores.acompanhamento.mensagem",
          label: "Mensagem",
          what: 'Abre o diálogo "Enviar WhatsApp para X" para este jogador, já com uma mensagem pronta (a copy de pré-ligação, ou a mensagem do alerta de oportunidade quando ele veio de um sinal específico). Fica sem efeito (mostra um erro) se o jogador não tiver telefone cadastrado. Repete-se em cada linha; a âncora marca só a primeira.',
        },
        {
          anchor: "jogadores.acompanhamento.converteu",
          label: "Converteu",
          what: 'Marca o contato como convertido e move o jogador da fila "Aguardando conversão" para "Converteu". Só aparece na fila "Aguardando conversão". Repete-se em cada linha; a âncora marca só a primeira.',
          notes: 'Erro "Não foi possível registrar o desfecho" se a gravação falhar.',
        },
        {
          anchor: "jogadores.acompanhamento.nao-converteu",
          label: "Não converteu",
          what: 'Marca o contato como não convertido e move o jogador para "Não converteu". Só aparece na fila "Aguardando conversão". Repete-se em cada linha; a âncora marca só a primeira.',
          notes: 'Erro "Não foi possível registrar o desfecho" se a gravação falhar.',
        },
        {
          label: "Estados vazios da fila",
          what: '"Ninguém aguardando conversão", "Nenhum jogador convertido ainda" ou "Nenhum jogador marcado como não convertido", com a mesma explicação: "Quando alguém receber mensagem por aqui, ele aparece nesta fila."',
        },
        {
          label: 'Diálogo "Enviar WhatsApp para X"',
          what: 'Mostra o telefone do jogador (ou "Sem telefone cadastrado"). Sem telefone, só aparece o texto "Cadastre um telefone para este lead." Com telefone, o CRM primeiro verifica se já existe uma sessão WhatsApp vinculada a esse número ("Verificando sessão…"): se existir, mostra um aviso ("Esta conversa já está vinculada à sessão X. Só dá pra responder por este número." ou, se essa sessão estiver indisponível, "A sessão vinculada X está indisponível. Realoque o lead antes de enviar.") e só o campo de mensagem; se não existir, mostra a lista de sessões WhatsApp da casa para escolher (cada uma com o selo "Conectado" ou "Offline" — só uma conectada pode ser escolhida) e, sem nenhuma sessão cadastrada, o texto "Nenhuma sessão WhatsApp cadastrada. Crie uma em WhatsApp → Sessões." O campo "Mensagem" é editável antes de enviar. O botão "Abrir no WhatsApp Web" é um atalho que abre web.whatsapp.com com o texto pronto, sem passar pela sessão do CRM. "Enviar" manda pela sessão escolhida (ou pela vinculada).',
          notes:
            'Erros possíveis ao enviar: "A sessão vinculada a este lead está offline. Realoque o lead ou escolha outra sessão em WhatsApp → Sessões.", "Não encontrei a conversa vinculada deste lead. Realoque o lead em WhatsApp → Sessões antes de enviar." e "Escolha uma sessão" (nenhuma selecionada). O mesmo diálogo abre pela ficha do jogador e por aqui — sempre documentado aqui, sem âncora própria, porque o tour nunca abre diálogos.',
        },
        {
          label: 'Diálogo "Histórico de contatos"',
          what: 'Lista, do mais recente ao mais antigo, tudo que já foi enviado para o jogador por WhatsApp, SMS, e-mail e ligação: o canal, a data/hora, o status do envio, a jornada/campanha e etapa de origem (quando existem) e um resumo do conteúdo. "Nenhum contato registrado para esse lead ainda." quando não há nada.',
          notes:
            "O mesmo diálogo abre pela ficha do jogador e por aqui — sem âncora própria, porque o tour nunca abre diálogos. Contatos de um canal (SMS, e-mail ou ligação) que o super admin desligou para a casa ficam de fora da lista — eles continuam gravados, só não aparecem enquanto o canal estiver desligado; o WhatsApp sempre aparece, por não ser um canal que se desliga.",
        },
      ],
    },
  ],

  states: [
    {
      id: "sem-resultado",
      title: "Nenhum jogador encontrado",
      what: "A lista não tem nenhum jogador que combine com o filtro atual (ou a base da casa ainda está vazia).",
      action: 'Clique em "Limpar filtros" ou em "Limpar tudo" para voltar a ver a base inteira.',
    },
    {
      id: "fila-vazia",
      title: 'Fila de acompanhamento vazia ("Ninguém aguardando conversão" e as outras duas)',
      what: "Nenhum jogador foi contatado (ou teve desfecho marcado) dentro da janela da fila escolhida.",
      action: "Mande uma mensagem a partir de um sinal de oportunidade (chip da gaveta) para começar a preencher esta fila.",
    },
    {
      id: "sem-telefone",
      title: "Jogador sem telefone cadastrado.",
      what: 'Mensagem de erro ao tentar abrir o diálogo de WhatsApp para um jogador sem telefone (botão "Mensagem" da fila de Acompanhamento).',
      action: "Cadastre o telefone do jogador antes de tentar enviar mensagem.",
    },
  ],

  tours: {
    lista: [
      {
        anchor: "jogadores.lista.busca",
        title: "Busca",
        body: "Encontre um jogador pelo nome, telefone, e-mail ou ID da plataforma.",
        articleSection: "lista",
      },
      {
        anchor: "jogadores.lista.mais-filtros",
        title: "Mais filtros",
        body: "Abre a gaveta com período, comportamento e oportunidades combinados — o resto dos filtros fica aqui dentro.",
        articleSection: "gaveta-filtros",
      },
      {
        anchor: "jogadores.lista.situacao",
        title: "Situação",
        body: "Filtre por ativos, esfriando, dormindo ou sem depósito.",
        articleSection: "lista",
      },
      {
        anchor: "jogadores.lista.nivel",
        title: "Nível",
        body: "Filtre por Bronze, Prata, Ouro, Diamante ou Black, pelo total depositado.",
        articleSection: "lista",
      },
      {
        anchor: "jogadores.lista.colunas",
        title: "Colunas que ordenam",
        body: "Clique em Total depositado, Último depósito ou Veio de para reordenar a lista por essa coluna.",
        articleSection: "lista",
      },
      {
        anchor: "jogadores.lista.abrir-ficha",
        title: "Abrir a ficha",
        body: "Clique no nome do jogador para ver a ficha completa dele.",
        articleSection: "lista",
      },
      {
        anchor: "jogadores.cabecalho.campanha",
        title: "Usar na campanha",
        body: "Leve o filtro atual (ou a seleção) direto para uma campanha de SMS/WhatsApp/e-mail.",
        articleSection: "cabecalho",
      },
    ],
    acompanhamento: [
      {
        anchor: "jogadores.acompanhamento.fila",
        title: "Filas de acompanhamento",
        body: 'Veja quem está "Aguardando conversão" e quem já "Converteu" ou "Não converteu" depois de um contato.',
        articleSection: "acompanhamento",
      },
      {
        anchor: "jogadores.acompanhamento.historico",
        title: "Histórico",
        body: "Veja tudo que já foi enviado para este jogador.",
        articleSection: "acompanhamento",
      },
      {
        anchor: "jogadores.acompanhamento.mensagem",
        title: "Mensagem",
        body: "Mande uma mensagem de WhatsApp pronta para este jogador.",
        articleSection: "acompanhamento",
      },
      {
        anchor: "jogadores.acompanhamento.converteu",
        title: "Marcar o desfecho",
        body: 'Marque "Converteu" ou "Não converteu" para o jogador sair da fila de aguardando.',
        articleSection: "acompanhamento",
      },
    ],
  },
};

export default screen;
