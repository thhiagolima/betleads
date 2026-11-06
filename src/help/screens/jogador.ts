// Help article for "Ficha do jogador" (/players/$playerId), sem abas. Fonte:
// src/routes/players.$playerId.tsx (cabeçalho, KPIs e todos os cartões),
// src/components/players/team-tracked-link-card.tsx (cartão "Link rastreado",
// só para quem tem perfil de rendimento de equipe), e
// src/components/players/player-journeys-card.tsx (cartão "Jornadas"), mais
// os mesmos diálogos "Enviar WhatsApp para X" e "Histórico de contatos" já
// documentados em screens/jogadores.ts (abrem da mesma forma aqui).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "jogador",
  route: "/players/$playerId",
  title: "Ficha do jogador",
  purpose:
    "Tudo sobre um jogador: contato, movimento financeiro, pontuação de risco/retenção, como ele chegou, o que o CRM já fez com ele e a linha do tempo completa.",
  roles: ["admin", "gestor", "member", "expert"],
  terms: ["grupo-de-controle", "utm"],
  sections: [
    {
      id: "cabecalho",
      title: "Cabeçalho e números",
      intro:
        "O nome do jogador, o nível, se é VIP, a situação atual, há quantos dias está sem depositar (quando aplicável) e a data de cadastro.",
      items: [
        {
          anchor: "jogador.cabecalho.mensagem",
          label: "Mensagem",
          what: 'Abre o diálogo "Enviar WhatsApp para X" para este jogador, com a mensagem de pré-ligação padrão da casa.',
          notes: "Fica desabilitado (com a dica \"Jogador sem telefone cadastrado\") quando ele não tem telefone.",
        },
        {
          anchor: "jogador.cabecalho.campanha",
          label: "Usar na campanha",
          what: "Leva para /campanhas com o público já pronto, contendo só este jogador.",
          notes: 'Erro "Não foi possível preparar o público da campanha." se a gravação falhar no servidor.',
        },
        {
          anchor: "jogador.cabecalho.historico",
          label: "Histórico de contatos",
          what: 'Abre o diálogo "Histórico de contatos" deste jogador: tudo que já foi enviado a ele por WhatsApp, SMS, e-mail e ligação, do mais recente ao mais antigo, com canal, data/hora, status, jornada/campanha de origem e um resumo do conteúdo. "Nenhum contato registrado para esse lead ainda." quando não há nada.',
          notes:
            "O mesmo diálogo abre pela lista de Jogadores (aba Acompanhamento) — sem âncora própria, porque o tour nunca abre diálogos.",
        },
        {
          anchor: "jogador.kpis",
          label: '"Total depositado", "Total sacado", "Saldo informado" e "Resultado da casa"',
          what: '"Resultado da casa" é o total depositado menos o total sacado por esse jogador (o detalhe abaixo do número lembra a conta).',
        },
      ],
    },
    {
      id: "contato",
      title: "Contato",
      items: [
        {
          anchor: "jogador.contato.card",
          label: "Cartão Contato",
          what: "Telefone, e-mail, cadastro (data), se o cadastro foi verificado (Sim/Não) e o nível de risco declarado pela casa (Alto/Médio/Baixo, ou \"Sem dado\" quando não informado).",
        },
        {
          anchor: "jogador.contato.copiar-id",
          label: "Copiar ID (ID na plataforma)",
          what: 'Copia o ID do jogador na plataforma da casa (player_external_id) para a área de transferência. Troca para "ID copiado" por 1,5 segundo. Mostra "Sem ID" quando o jogador não tem esse ID cadastrado.',
        },
      ],
    },
    {
      id: "movimento",
      title: "Movimento do jogador",
      items: [
        {
          anchor: "jogador.movimento.card",
          label: "Cartão Movimento do jogador",
          what: 'Quantidade de depósitos e de saques, e as datas do último depósito, do primeiro depósito, da última atividade e do último saque — cada uma mostrada como "há quanto tempo" e, ao lado, a data exata. "Sem dado" quando a informação não existe.',
        },
      ],
    },
    {
      id: "pontuacao",
      title: "Pontuação",
      items: [
        {
          anchor: "jogador.pontuacao.card",
          label: '"Score geral", "Retenção", "Risco" e "Conversão"',
          what: "Quatro notas de 0 a 100 calculadas pelo CRM a partir do comportamento do jogador. Em todas, quanto maior, mais chance do que o nome diz: Score geral resume a importância do jogador, Retenção estima a chance de continuar ativo, Risco estima a chance de parar de jogar, e Conversão estima a chance de responder a um novo contato.",
        },
      ],
    },
    {
      id: "alertas",
      title: "Sinais e alertas",
      items: [
        {
          anchor: "jogador.alertas.card",
          label: "Cartão Sinais e alertas",
          what: 'Lista os sinais de oportunidade ativos agora para este jogador (os mesmos tipos da gaveta "Mais filtros" → Oportunidades, de Jogadores), cada um com o título e o motivo específico por que apareceu. "Nenhum alerta ativo para este jogador agora." quando não há nenhum.',
        },
      ],
    },
    {
      id: "link-equipe",
      title: "Link rastreado (seu rendimento)",
      intro:
        'Só aparece para quem é da equipe da casa e tem um perfil de rendimento ativo (Área do Expert). Gera um link rastreado para este jogador: os depósitos que vierem por ele contam para o seu rendimento pessoal.',
      items: [
        {
          anchor: "jogador.link-equipe.card",
          label: "Cartão Link rastreado",
          what: "Gera um link curto rastreado para este jogador, a partir de uma URL de oferta sua.",
          roles: ["member", "expert"],
        },
        {
          anchor: "jogador.link-equipe.url",
          label: "URL da oferta",
          what: "O endereço (https://...) para onde o link gerado deve levar o jogador.",
          roles: ["member", "expert"],
        },
        {
          label: "Nome da oferta",
          what: 'Um nome para identificar a oferta, por exemplo "Cashback de sexta" (até 60 caracteres).',
          roles: ["member", "expert"],
        },
        {
          anchor: "jogador.link-equipe.gerar",
          label: "Gerar link",
          what: "Cria o link rastreado. Fica desabilitado até os dois campos acima estarem preenchidos.",
          roles: ["member", "expert"],
          notes: 'Depois de gerado, aparece o aviso "Encurtador não configurado; o link é rastreado mesmo assim." quando a casa não tem domínio de encurtador próprio. Erro "Não foi possível gerar o link." se a geração falhar.',
        },
        {
          anchor: "jogador.link-equipe.copiar",
          label: "Copiar (link gerado)",
          what: "Copia o link gerado para a área de transferência.",
          roles: ["member", "expert"],
          notes: 'Erro "Não foi possível copiar." se a área de transferência não puder ser usada.',
        },
        {
          anchor: "jogador.link-equipe.whatsapp",
          label: "Abrir no WhatsApp",
          what: "Abre o WhatsApp Web/app com o link gerado já no texto da conversa com este jogador.",
          roles: ["member", "expert"],
          notes: 'Fica desabilitado com o aviso "Jogador sem telefone válido." quando o telefone do jogador não é um número de WhatsApp reconhecível.',
        },
      ],
    },
    {
      id: "jornadas",
      title: "Jornadas",
      items: [
        {
          anchor: "jogador.jornadas.card",
          label: "Cartão Jornadas",
          what: 'Em que jornadas automáticas o jogador está agora, o próximo envio previsto e por que ele saiu das jornadas anteriores. No topo, mostra quantos SMS ele recebeu nas últimas 24 horas e nos últimos 7 dias (com o limite da casa, quando existe) e, por origem (campanha/jornada), quantos SMS cada uma mandou. Cada jornada mostra o status, a etapa atual (ou "Sem etapas de envio"), se está em repetição, se está esperando outra jornada de maior prioridade terminar, e o selo "grupo de controle" quando o jogador foi sorteado para não receber mensagens dessa jornada (serve para comparar e medir o efeito real do envio). Jornadas encerradas mostram quando entrou, quando saiu e, quando há, o motivo da saída. "Este jogador nunca entrou em uma jornada." quando a lista está vazia.',
        },
      ],
    },
    {
      id: "chegou",
      title: "Como chegou",
      items: [
        {
          anchor: "jogador.chegou.card",
          label: "Cartão Como chegou",
          what: 'A origem declarada no cadastro ou na importação: Fonte, Meio, Campanha, Criativo e ID do anúncio (os campos de UTM — um padrão de marcar de onde veio um clique de anúncio), mais o Expert responsável e, quando o CRM tem o dado, o alcance do anúncio (impressões e cliques).',
        },
      ],
    },
    {
      id: "crm-midia",
      title: "CRM e mídia",
      items: [
        {
          anchor: "jogador.crm-midia.card",
          label: "Cartão CRM e mídia",
          what: 'Quantos SMS foram enviados a este jogador (e quantos falharam), quantos cliques os links enviados a ele receberam, quanto a casa gastou com mídia para trazê-lo (com a base do cálculo — "pelo anúncio", "pela campanha" ou "sem correspondência") e o resultado da mídia (depositado menos o gasto estimado, verde se positivo, vermelho se negativo). "Sem dado" quando o CRM não tem a informação.',
        },
      ],
    },
    {
      id: "cashback",
      title: "Cashback",
      items: [
        {
          anchor: "jogador.cashback.card",
          label: "Cartão Cashback",
          what: "O total recebido em cashback e quantos pagamentos, o último pagamento (valor e data), e a lista dos últimos pagamentos (até 6, com data, status e valor). \"Nenhum\" quando não houve nenhum pagamento ainda.",
        },
      ],
    },
    {
      id: "links",
      title: "Links enviados",
      items: [
        {
          anchor: "jogador.links.card",
          label: "Cartão Links enviados",
          what: "Cada link rastreado já enviado a este jogador: o canal (SMS, Email, WhatsApp ou Voz), a origem (Campanha, Jornada, envio manual, Expert, fluxo de SMS/e-mail...), há quanto tempo foi enviado, o endereço completo do link (clicável, abre em outra aba) e quantos cliques recebeu. \"Nenhum link rastreado enviado.\" quando a lista está vazia.",
        },
      ],
    },
    {
      id: "timeline",
      title: "Linha do tempo",
      items: [
        {
          anchor: "jogador.timeline.card",
          label: "Cartão Linha do tempo",
          what: "Todos os eventos do jogador, do mais recente ao mais antigo: depósitos, saques, cashback, sessões/logins, SMS e contatos manuais. Cada item mostra o tipo (com uma bolinha colorida igual à de Eventos), uma descrição quando existe, o status do envio (quando aplicável), há quanto tempo aconteceu e o valor em dinheiro quando houver. \"Sem eventos registrados para este jogador.\" quando a lista está vazia.",
        },
      ],
    },
  ],

  states: [
    {
      id: "erro-carregar",
      title: "Não foi possível abrir a ficha",
      what: "A ficha não carregou — pode ser uma falha de rede ou o jogador não existir mais.",
      action: 'Clique em "Tentar de novo".',
    },
  ],

  tours: {
    default: [
      {
        anchor: "jogador.kpis",
        title: "Números do jogador",
        body: "Total depositado, total sacado, saldo informado e o resultado da casa com ele.",
        articleSection: "cabecalho",
      },
      {
        anchor: "jogador.contato.card",
        title: "Contato",
        body: "Telefone, e-mail, cadastro, verificação e risco declarado.",
        articleSection: "contato",
      },
      {
        anchor: "jogador.movimento.card",
        title: "Movimento do jogador",
        body: "Depósitos, saques e as datas mais importantes.",
        articleSection: "movimento",
      },
      {
        anchor: "jogador.pontuacao.card",
        title: "Pontuação",
        body: "Quatro notas de 0 a 100: score geral, retenção, risco e conversão.",
        articleSection: "pontuacao",
      },
      {
        anchor: "jogador.jornadas.card",
        title: "Jornadas",
        body: "Em que jornadas automáticas o jogador está e o que já aconteceu nas anteriores.",
        articleSection: "jornadas",
      },
      {
        anchor: "jogador.chegou.card",
        title: "Como chegou",
        body: "A origem declarada do jogador: fonte, UTM e o expert responsável.",
        articleSection: "chegou",
      },
      {
        anchor: "jogador.timeline.card",
        title: "Linha do tempo",
        body: "Todo o histórico do jogador, do mais recente ao mais antigo.",
        articleSection: "timeline",
      },
      {
        anchor: "jogador.cabecalho.mensagem",
        title: "Mensagem",
        body: "Mande uma mensagem de WhatsApp pronta direto para este jogador.",
        articleSection: "cabecalho",
      },
    ],
  },
};

export default screen;
