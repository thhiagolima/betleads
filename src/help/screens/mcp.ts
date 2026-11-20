// Help article for "Conectar ao Claude" (/mcp): o passo a passo para quem não
// é técnico (copiar, adicionar o conector, autorizar, primeira pergunta), os
// exemplos de perguntas, como funcionam as alterações, o que o Claude vê e os
// problemas comuns; depois a URL de conexão MCP (uma
// só para todo o Betleads; o que cada pessoa vê depende do acesso dela, não
// da URL), as áreas (financeiro e operação) e as instruções para ligar claude.ai, Claude Desktop e Claude Code a
// ela, mais as conexões ativas e o botão de desconectar cada uma. A tela só
// aparece no menu para quem tem algum nível de acesso ao MCP concedido pelo
// super admin (fora desta tela) — mas uma visita direta à URL sempre
// renderiza, inclusive os avisos de "sem acesso" e "desligado neste
// ambiente". Fonte: src/routes/mcp.tsx, src/lib/mcp/mcp.functions.ts
// (getMyMcpStatus, revokeMyConnection) e src/components/app-sidebar.tsx
// (useMcpSidebarEntry, a regra do item do menu).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "mcp",
  route: "/mcp",
  title: "Conectar ao Claude",
  purpose:
    "A URL de conexão do Betleads para ligar o Claude (claude.ai, Claude Desktop ou Claude Code) via MCP, mais as conexões já feitas e como desconectar cada uma. A URL é uma só para todos; o que o Claude vê depende do acesso de cada pessoa: a área de financeiro (resumo, mês e metas das casas, com escritas confirmadas) e, quando liberada, a área de operação (só leitura: cadastros, FTDs, depósitos, experts, afiliados, campanhas, jornadas e alertas das casas que a pessoa vê, de uma casa, de um grupo ou de todas de uma vez).",
  roles: ["admin", "gestor", "member"],
  terms: ["mcp"],
  sections: [
    {
      id: "passos",
      title: "Passo a passo",
      intro:
        'O caminho completo para quem nunca usou um conector no Claude. Cada passo ganha um ✓ sozinho: os três primeiros quando aparece uma conexão em "Conexões ativas", o quarto quando o Claude usa o Betleads pela primeira vez.',
      items: [
        {
          anchor: "mcp.passos.card",
          label: "Passo a passo",
          what: "1. Copie o endereço do Betleads. 2. No Claude (claude.ai ou Claude Desktop): seu nome, no canto de baixo à esquerda → Configurações → Conectores → Adicionar conector personalizado; nome Betleads, cole o endereço e clique em Adicionar. 3. Clique em Conectar ao lado do Betleads; abre a página de autorização do Betleads, que lista as áreas e as casas liberadas; clique em Permitir. 4. Numa conversa nova, confira no botão + do campo de mensagem que o Betleads está ligado e faça uma pergunta.",
          when: "Na primeira vez, ou ao conectar outro computador ou outra conta do Claude.",
          notes:
            "Na página de autorização, confira que o endereço é o do Betleads antes de clicar em Permitir, e só clique se você acabou de pedir a conexão. Na primeira pergunta, o Claude pede licença para usar o Betleads: clique em Permitir (ou Sempre permitir). No celular, a tela mostra um aviso de que estes passos são feitos no computador.",
        },
        {
          anchor: "mcp.passos.copiar",
          label: "Copiar endereço",
          what: 'Copia a URL de conexão para colar no Claude. Toast "URL copiada".',
        },
      ],
    },
    {
      id: "exemplos",
      title: "O que perguntar",
      intro:
        'Perguntas prontas, separadas pelas áreas liberadas para você: Financeiro, Alterações no financeiro (só com nível Leitura e escrita) e Operação. Clicar numa pergunta copia o texto (toast "Pergunta copiada").',
      items: [
        {
          anchor: "mcp.exemplos.card",
          label: "O que perguntar",
          what: 'Exemplos: "Como está o financeiro das minhas casas neste mês?", "Quais experts trouxeram mais depósito em outubro?", "O que o afiliado 4512 trouxe neste mês?", "Tem alguma coisa nas minhas casas que precisa de atenção hoje?".',
          when: 'Diga sempre a casa, o grupo ou "todas as minhas casas" e o período (ontem, últimos 7 dias, este mês, um mês pelo nome).',
          notes: "Nos exemplos de alteração, troque {nome da casa} pelo nome de uma casa sua.",
        },
      ],
    },
    {
      id: "alteracoes",
      title: "Como o Claude altera o financeiro",
      intro: "Só aparece para quem tem nível Leitura e escrita no financeiro.",
      items: [
        {
          anchor: "mcp.alteracoes.card",
          label: "Alterações em duas etapas",
          what: 'O Claude nunca grava direto: primeiro mostra uma prévia com o valor de antes e o de depois; só grava quando você responde algo como "pode confirmar". Dá para alterar lançamento de anúncios e GGR por dia, GGR do mês, outros custos (criar, editar, excluir) e metas diárias.',
          notes:
            "A prévia vale 10 minutos. A alteração fica registrada com o seu usuário, como no painel. Casas suspensas ou bloqueadas não aceitam alteração. A operação é só leitura.",
        },
      ],
    },
    {
      id: "seguranca",
      title: "O que o Claude vê",
      items: [
        {
          anchor: "mcp.seguranca.card",
          label: "O que o Claude vê",
          what: "Só as casas e as áreas liberadas para você. Nenhum dado de jogador (nome, telefone, e-mail, CPF): só números somados. Os números são os do painel, mas confira no Betleads antes de uma decisão importante.",
        },
      ],
    },
    {
      id: "problemas",
      title: "Problemas comuns",
      items: [
        {
          anchor: "mcp.problemas.card",
          label: "Problemas comuns",
          what: 'Perguntas que abrem a resposta ao clicar: não aparece "Adicionar conector personalizado" (em contas Team/Enterprise do Claude só o dono adiciona); "Seu usuário não tem acesso ao MCP" (peça ao super admin); o Claude responde sem usar o Betleads (ligue o conector no botão +); sem acesso a uma casa ou à operação (peça ao super admin); parou de funcionar (após 30 dias sem uso a conexão expira: desconecte e conecte de novo no Claude).',
        },
      ],
    },
    {
      id: "conexao",
      title: "URL de conexão",
      intro:
        'Subtítulo da tela: "Nível de acesso: {Leitura / Leitura e escrita}." — o nível e as áreas (Financeiro e Operação) são concedidos por pessoa pelo super admin, fora desta tela; aqui só se usa o que já foi concedido. A área de operação só pode ser liberada para super admin, admin de casa ou gestor de grupo: o admin vê a operação da casa dele, o gestor do grupo vê as casas do grupo e o super admin vê todas.',
      items: [
        {
          anchor: "mcp.url.card",
          label: "URL de conexão",
          what: "O endereço do MCP do Betleads — o mesmo para todas as casas e todas as pessoas; quem se conecta só vê as casas e as áreas a que tem acesso. Esse endereço entra em claude.ai, Claude Desktop e no comando do Claude Code, mais abaixo.",
        },
        {
          anchor: "mcp.url.copiar",
          label: "Copiar",
          what: 'Copia a URL para a área de transferência. Toast "URL copiada".',
        },
      ],
    },
    {
      id: "instrucoes",
      title: "Instruções de conexão",
      intro: "Um card por cliente do Claude, cada um com o caminho exato dentro daquele app.",
      items: [
        {
          anchor: "mcp.claudeai.card",
          label: "claude.ai",
          what: 'Texto fixo: "Configurações → Conectores → Adicionar conector personalizado → colar a URL acima."',
        },
        {
          anchor: "mcp.desktop.card",
          label: "Claude Desktop",
          what: 'Texto fixo: "Mesmo caminho: Configurações → Conectores → Adicionar conector personalizado → colar a URL acima."',
        },
        {
          anchor: "mcp.code.card",
          label: "Claude Code",
          what: 'Para quem usa o terminal: o comando pronto "claude mcp add --transport http betleads {URL de conexão}".',
        },
        {
          anchor: "mcp.code.copiar",
          label: "Copiar (comando)",
          what: 'Copia o comando do Claude Code para a área de transferência. Toast "Comando copiado".',
        },
      ],
    },
    {
      id: "conexoes",
      title: "Conexões ativas",
      intro:
        "Cada cliente do Claude que já se conectou com a URL acima aparece aqui como uma linha.",
      items: [
        {
          anchor: "mcp.conexoes.card",
          label: "Lista de conexões",
          what: 'Cada linha mostra o nome do cliente (ex.: "Claude", "claude-code"), quando a conexão foi criada e o último uso ("criada em {data} · último uso: {data}"). Sem data de uso ainda, mostra "nunca".',
          notes: 'Sem nenhuma conexão, mostra "Nenhuma conexão ativa."',
        },
        {
          anchor: "mcp.conexoes.desconectar",
          label: "Desconectar",
          what: 'Pede confirmação ("Desconectar do Claude?") e revoga aquela conexão: o cliente deixa de poder usar o MCP com o token que tinha. Toast "Conexão desconectada"; se falhar, mostra o erro. Repete-se em cada conexão; a âncora marca só a primeira.',
          notes:
            "Para voltar a conectar aquele cliente, é preciso configurá-lo de novo (ele gera um novo token ao se autenticar outra vez com a URL de conexão).",
        },
      ],
    },
    {
      id: "api",
      title: "API (sistemas internos)",
      intro:
        "Só aparece quando a API está ligada neste ambiente. É para planilhas, BI e scripts internos: as mesmas consultas de leitura do Claude, com as mesmas casas e áreas liberadas para você, mais a série diária (uma linha por casa e por dia, até 366 dias).",
      items: [
        {
          anchor: "mcp.api.card",
          label: "API (sistemas internos)",
          what: 'Mostra o endereço da API, a lista de consultas (GET no endereço) e a documentação (openapi.json), as suas chaves ativas (nome, começo da chave, criada em, último uso) e um "Exemplo de chamada" com curl. Cada chave tem o botão Revogar, que pede confirmação: os sistemas que usam a chave param na hora (toast "Chave revogada").',
          notes:
            "A API só lê: nada é alterado por ela, mesmo para quem tem nível Leitura e escrita. Limite de 60 chamadas por minuto por chave. Se o super admin tirar o seu acesso ao MCP, as suas chaves param de funcionar na hora.",
        },
        {
          anchor: "mcp.api.criar",
          label: "Criar chave",
          what: 'Dê um nome (ex.: "Planilha do financeiro") e clique em Criar chave. A chave aparece uma única vez, com o botão Copiar: guarde-a num lugar seguro e clique em "Já copiei".',
          notes: "Até 5 chaves ativas por pessoa. Perdeu a chave? Revogue e crie outra.",
        },
      ],
    },
  ],

  states: [
    {
      id: "desligado",
      title: "MCP desligado neste ambiente.",
      what: "Mostrado no lugar da tela inteira quando o MCP está desligado neste ambiente (variável de ambiente), para todo mundo, independente do nível de acesso de cada um.",
    },
    {
      id: "sem-acesso",
      title: "Seu usuário não tem acesso ao MCP. Peça ao super admin.",
      what: 'Mostrado no lugar da tela inteira para quem acessa a URL diretamente sem ter nenhum nível de acesso concedido (o item "Conectar ao Claude" também não aparece no menu para essa pessoa).',
      action: "Peça ao super admin para conceder o acesso (Leitura ou Leitura e escrita).",
    },
    {
      id: "carregando",
      title: "Carregando…",
      what: "Mostrado no lugar da tela enquanto o status do MCP desta pessoa ainda não voltou do servidor.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "mcp.passos.card",
        title: "Passo a passo",
        body: "Quatro passos para ligar o Claude ao Betleads. Cada um ganha um ✓ quando estiver feito.",
        articleSection: "passos",
      },
      {
        anchor: "mcp.exemplos.card",
        title: "O que perguntar",
        body: "Perguntas prontas para as áreas liberadas para você. Clique numa para copiar e colar no Claude.",
        articleSection: "exemplos",
      },
      {
        anchor: "mcp.seguranca.card",
        title: "O que o Claude vê",
        body: "Só as suas casas e nenhum dado de jogador. Antes de uma decisão importante, confira no painel.",
        articleSection: "seguranca",
      },
      {
        anchor: "mcp.problemas.card",
        title: "Problemas comuns",
        body: "Se algo travar, a resposta provavelmente está aqui.",
        articleSection: "problemas",
      },
      {
        anchor: "mcp.url.card",
        title: "URL de conexão",
        body: "O endereço que liga o Claude ao Betleads — uma URL só, que entra nos três clientes abaixo. O Claude vê só as casas e as áreas (financeiro, operação) liberadas para você.",
        articleSection: "conexao",
      },
      {
        anchor: "mcp.code.card",
        title: "Claude Code",
        body: "Um comando pronto para colar no terminal, já com a URL de conexão.",
        articleSection: "instrucoes",
      },
      {
        anchor: "mcp.conexoes.card",
        title: "Conexões ativas",
        body: "Cada cliente que já se conectou com esta URL, com a data da conexão e do último uso.",
        articleSection: "conexoes",
      },
      {
        anchor: "mcp.conexoes.desconectar",
        title: "Desconectar",
        body: "Revoga uma conexão: o cliente precisa se autenticar de novo para voltar a usar o MCP.",
        articleSection: "conexoes",
      },
    ],
  },
};

export default screen;
