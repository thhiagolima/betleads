// Help article for "Conectar ao Claude" (/mcp): a URL própria de conexão
// MCP e as instruções para ligar claude.ai, Claude Desktop e Claude Code a
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
    "A URL própria desta casa para ligar o Claude (claude.ai, Claude Desktop ou Claude Code) aos dados financeiros dela via MCP, mais as conexões já feitas e como desconectar cada uma.",
  roles: ["admin", "gestor", "member"],
  terms: ["mcp"],
  sections: [
    {
      id: "conexao",
      title: "URL de conexão",
      intro:
        'Subtítulo da tela: "Nível de acesso: {Leitura / Leitura e escrita}." — o nível é concedido por pessoa pelo super admin, fora desta tela; aqui só se usa o que já foi concedido.',
      items: [
        {
          anchor: "mcp.url.card",
          label: "URL de conexão",
          what: "O endereço que identifica esta casa para o MCP — o mesmo endereço entra em claude.ai, Claude Desktop e no comando do Claude Code, mais abaixo.",
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
          what: 'O comando pronto para colar no terminal: "claude mcp add --transport http financeiro {URL de conexão}".',
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
      intro: "Cada cliente do Claude que já se conectou com a URL acima aparece aqui como uma linha.",
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
          what: 'Revoga aquela conexão: o cliente deixa de poder usar o MCP com o token que tinha. Toast "Conexão desconectada". Repete-se em cada conexão; a âncora marca só a primeira.',
          notes:
            "Para voltar a conectar aquele cliente, é preciso configurá-lo de novo (ele gera um novo token ao se autenticar outra vez com a URL de conexão).",
        },
      ],
    },
  ],

  states: [
    {
      id: "desligado",
      title: "MCP desligado neste ambiente.",
      what: 'Mostrado no lugar da tela inteira quando o MCP está desligado neste ambiente (variável de ambiente), para todo mundo, independente do nível de acesso de cada um.',
    },
    {
      id: "sem-acesso",
      title: "Seu usuário não tem acesso ao MCP. Peça ao super admin.",
      what: "Mostrado no lugar da tela inteira para quem acessa a URL diretamente sem ter nenhum nível de acesso concedido (o item \"Conectar ao Claude\" também não aparece no menu para essa pessoa).",
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
        anchor: "mcp.url.card",
        title: "URL de conexão",
        body: "O endereço que liga o Claude aos dados financeiros desta casa — a mesma URL entra nos três clientes abaixo.",
        articleSection: "conexao",
      },
      {
        anchor: "mcp.claudeai.card",
        title: "claude.ai",
        body: "Configurações → Conectores → Adicionar conector personalizado → colar a URL.",
        articleSection: "instrucoes",
      },
      {
        anchor: "mcp.desktop.card",
        title: "Claude Desktop",
        body: "O mesmo caminho de claude.ai: Configurações → Conectores → Adicionar conector personalizado.",
        articleSection: "instrucoes",
      },
      {
        anchor: "mcp.code.card",
        title: "Claude Code",
        body: "Um comando pronto para colar no terminal, já com a URL desta casa.",
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
