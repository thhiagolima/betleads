// Help article for "API de dados" (/api-dados): the read-only API for
// internal spreadsheets, BI and scripts — the step-by-step (create a key,
// keep it, first query), the keys (create, shown once, revoke), the ready
// examples (Primeira consulta, Planilha Google, Power BI, Python), the queries
// this user may call, the address and OpenAPI documentation, care points and
// common problems. The screen is in the menu ("Claude e API") only while the
// API is on and the user has MCP access. Source: src/routes/api-dados.tsx,
// src/lib/api/keys.functions.ts, src/lib/api/handler.server.ts.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "api-dados",
  route: "/api-dados",
  title: "API de dados",
  purpose:
    "Levar os números do Betleads para planilhas, painéis de BI e scripts internos, sem copiar e colar. A API só lê e vê as mesmas casas e áreas que a pessoa vê em \"Conectar ao Claude\". Cada sistema usa uma chave criada aqui.",
  roles: ["admin", "gestor", "member"],
  terms: ["api", "chave-de-api"],
  sections: [
    {
      id: "passos",
      title: "Passo a passo",
      intro:
        "Três passos, cada um com um ✓ que aparece sozinho: os dois primeiros quando existe uma chave ativa, o terceiro quando uma chave sua faz a primeira consulta.",
      items: [
        {
          anchor: "api.passos.card",
          label: "Passo a passo",
          what: "1. Crie uma chave (com um nome que diga onde ela vai ser usada). 2. Copie e guarde a chave: ela aparece uma vez só. 3. Faça a primeira consulta com um dos Exemplos prontos, trocando SUA_CHAVE e o id da casa ou do grupo.",
          when: "Na primeira vez, e a cada planilha ou sistema novo (uma chave para cada um).",
          notes:
            "Para planilhas e BI, a consulta indicada é a serie_diaria: uma linha por casa e por dia, até 366 dias numa chamada.",
        },
      ],
    },
    {
      id: "chaves",
      title: "Chaves",
      items: [
        {
          anchor: "api.chaves.criar",
          label: "Criar chave",
          what: 'Dê um nome (ex.: "Planilha do financeiro") e clique em Criar chave. A chave aparece numa caixa com o botão Copiar (toast "Chave copiada") e o aviso de que não aparece de novo; "Já copiei" fecha a caixa.',
          notes: "Até 5 chaves ativas por pessoa. Perdeu a chave? Revogue e crie outra.",
        },
        {
          anchor: "api.chaves.card",
          label: "Lista de chaves",
          what: 'Cada linha mostra o nome, o começo da chave (ex.: "blk_a1b2c3…"), quando foi criada e o último uso ("nunca" se ainda não foi usada).',
          notes: 'Sem chaves, mostra "Nenhuma chave ativa."',
        },
        {
          anchor: "api.chaves.revogar",
          label: "Revogar",
          what: 'Pede confirmação e desliga a chave na hora: as planilhas, painéis e scripts que a usam passam a receber erro 401. Toast "Chave revogada". Repete-se em cada chave; a âncora marca só a primeira.',
          when: "Quando a chave vazou, ou o sistema que a usava não existe mais.",
        },
      ],
    },
    {
      id: "exemplos",
      title: "Exemplos prontos",
      items: [
        {
          anchor: "api.exemplos.card",
          label: "Exemplos prontos",
          what: 'Um botão por ferramenta, cada um com o "como usar" e o código já com o endereço da API: Primeira consulta (curl de listar_escopos, que mostra os ids das casas e dos grupos), Planilha Google (Apps Script que grava a serie_diaria na aba "Betleads"), Power BI (consulta em M) e Python.',
          notes:
            "Nos exemplos de Planilha Google e Python a chave fica fora do código (Propriedades do script, variável de ambiente). No Power BI, escolha a conexão Anônima: a chave vai no código.",
        },
        {
          anchor: "api.exemplos.copiar",
          label: "Copiar código",
          what: 'Copia o código do exemplo escolhido. Toast "Código copiado".',
        },
      ],
    },
    {
      id: "consultas",
      title: "Consultas disponíveis",
      items: [
        {
          anchor: "api.consultas.card",
          label: "Consultas disponíveis",
          what: "As consultas que as suas chaves podem chamar, por área: Geral (listar_escopos), Financeiro (resumo, resumo dia a dia, série diária, mês da casa, metas) e Operação (visão geral, dia a dia, comparar casas, experts, afiliados, campanhas, jornadas, alertas). Cada uma é um POST no endereço da API seguido do nome, com os argumentos em JSON — os mesmos que o Claude usa.",
          notes: "Só aparecem as áreas liberadas para você.",
        },
      ],
    },
    {
      id: "endereco",
      title: "Endereço e documentação",
      items: [
        {
          anchor: "api.endereco.card",
          label: "Endereço e documentação",
          what: "O endereço da API e o da documentação (OpenAPI), cada um com o botão Copiar. A documentação lista os campos de cada consulta e pode ser importada no Postman, Insomnia ou em ferramentas de BI.",
        },
        {
          anchor: "api.endereco.copiar",
          label: "Copiar (endereço)",
          what: 'Copia o endereço da API. Toast "Endereço copiado".',
        },
      ],
    },
    {
      id: "cuidados",
      title: "Cuidados",
      items: [
        {
          anchor: "api.cuidados.card",
          label: "Cuidados",
          what: "A chave é como uma senha: não a coloque em planilha compartilhada com quem não deve ver os números, nem em mensagem ou e-mail. A API só lê e nenhum dado de jogador sai por ela. Se o super admin tirar o seu acesso, todas as suas chaves param. Limite de 60 chamadas por minuto por chave.",
        },
      ],
    },
    {
      id: "problemas",
      title: "Problemas comuns",
      items: [
        {
          anchor: "api.problemas.card",
          label: "Problemas comuns",
          what: "Perguntas que abrem a resposta ao clicar: 401 (chave inválida ou revogada, ou acesso retirado), 403 (casa, grupo ou área não liberada), 400 (campo errado; o campo detalhes diz qual), 429 (mais de 60 chamadas por minuto: use serie_diaria) e números diferentes do painel (cada resposta traz calculado_em).",
        },
      ],
    },
  ],

  states: [
    {
      id: "desligado",
      title: "A API está desligada neste ambiente ou o seu usuário não tem acesso. Peça ao super admin.",
      what: "Mostrado no lugar da tela inteira quando a API está desligada neste ambiente (variável de ambiente) ou quando a pessoa não tem acesso ao MCP concedido pelo super admin. Nesses casos o item \"API de dados\" também não aparece no menu.",
      action: "Peça ao super admin para liberar o seu acesso em Conectar ao Claude (o mesmo vale para a API).",
    },
    {
      id: "carregando",
      title: "Carregando…",
      what: "Mostrado no lugar da tela enquanto as chaves desta pessoa ainda não voltaram do servidor.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "api.passos.card",
        title: "Passo a passo",
        body: "Três passos para levar os números do Betleads a uma planilha, BI ou script. Cada um ganha um ✓ quando estiver feito.",
        articleSection: "passos",
      },
      {
        anchor: "api.chaves.criar",
        title: "Criar chave",
        body: "Uma chave por planilha ou sistema. Ela aparece uma vez só: copie e guarde.",
        articleSection: "chaves",
      },
      {
        anchor: "api.chaves.card",
        title: "Suas chaves",
        body: "Nome, começo da chave e último uso. Revogue a que vazou ou não é mais usada.",
        articleSection: "chaves",
      },
      {
        anchor: "api.exemplos.card",
        title: "Exemplos prontos",
        body: "Código pronto para Planilha Google, Power BI e Python. Comece pela Primeira consulta para ver os ids das suas casas.",
        articleSection: "exemplos",
      },
      {
        anchor: "api.consultas.card",
        title: "Consultas disponíveis",
        body: "O que as suas chaves podem consultar, por área. Para planilhas e BI, use a serie_diaria.",
        articleSection: "consultas",
      },
      {
        anchor: "api.endereco.card",
        title: "Endereço e documentação",
        body: "O endereço da API e a documentação com os campos de cada consulta.",
        articleSection: "endereco",
      },
      {
        anchor: "api.cuidados.card",
        title: "Cuidados",
        body: "A chave é como uma senha. Só leitura, nenhum dado de jogador.",
        articleSection: "cuidados",
      },
      {
        anchor: "api.problemas.card",
        title: "Problemas comuns",
        body: "O que significa cada erro e como resolver.",
        articleSection: "problemas",
      },
    ],
  },
};

export default screen;
