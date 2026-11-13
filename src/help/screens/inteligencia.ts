// Help article for "Assistente IA" (/inteligencia), tela só de admin: um chat
// onde a casa pergunta sobre os jogadores em português e recebe cartões de
// jogador, métricas e sugestões, com o feedback 👍/👎 que alimenta o Treino IA
// (screens/treino-ia.ts). Fonte: src/routes/inteligencia.tsx,
// src/components/ai-response.tsx (cartões, métricas, insights) e
// src/components/ai-feedback.tsx (formulário de feedback), mais a função de
// borda supabase/functions/ai-player-insights (erros "Unauthorized",
// "Forbidden", "JSON inválido", "Pergunta vazia" e o bloqueio de demonstração
// — nenhum chega ao jogador: a tela sempre mostra a mesma mensagem genérica,
// ver o item "ia.conversa" e as notas do estado "erro-consulta").
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "inteligencia",
  route: "/inteligencia",
  title: "Assistente IA",
  purpose:
    "Um chat para perguntar sobre os jogadores da casa em português comum (\"quem está virando VIP?\", \"os 10 que mais depositam\") e receber a resposta com cartões de jogador, métricas e um resumo — sem precisar abrir relatórios.",
  roles: ["admin"],
  sections: [
    {
      id: "assistente",
      title: "Assistente IA",
      intro:
        'Tela de admin só da casa. A pergunta sempre usa os dados de agora da própria casa (a função de borda confere o usuário e lê só os dados da casa ativa). No ambiente de demonstração, a pergunta e o envio ficam desabilitados com o aviso "Indisponível no ambiente de demonstração" — não é possível perguntar nada nessa casa de exemplo.',
      items: [
        {
          anchor: "ia.pergunta",
          label: "Campo da pergunta",
          what: 'Onde se escreve a pergunta em português comum, por exemplo "quem depositou mais esta semana?". Apertar Enter envia; Shift+Enter quebra a linha sem enviar.',
          notes:
            'No ambiente de demonstração o campo fica desabilitado com o texto "Indisponível no ambiente de demonstração" no lugar do texto de exemplo.',
        },
        {
          anchor: "ia.enviar",
          label: "Enviar pergunta (ícone de avião de papel)",
          what: "Manda a pergunta escrita no campo para o assistente.",
          notes:
            'Fica desabilitado com o campo vazio, enquanto uma resposta está sendo buscada, ou no ambiente de demonstração — nesse último caso aparece a dica "Indisponível no ambiente de demonstração" ao passar o mouse (ou pelo foco, no teclado/leitor de tela).',
        },
        {
          anchor: "ia.sugestoes",
          label: "Sugestões",
          what: 'Uma lista de perguntas prontas para clicar, por exemplo "Os 10 que mais depositam", "Quem está virando VIP?" ou "Cadastros parados". No celular aparecem como uma fileira de botões que rola para o lado; no computador, como uma lista vertical.',
          notes:
            "Clicar em uma sugestão já envia a pergunta na hora, sem precisar digitar nem apertar Enviar.",
        },
        {
          anchor: "ia.sugestao",
          label: "Botão de uma sugestão",
          what: "Envia aquela pergunta pronta. Repete-se em cada sugestão da lista; a âncora marca só a primeira.",
        },
        {
          anchor: "ia.conversa",
          label: "Área da conversa",
          what: 'Mostra o histórico de perguntas e respostas desta sessão (ele não é salvo ao atualizar a página). Antes da primeira pergunta aparece o título "O que você quer saber?" com o texto "Escreva uma pergunta ou escolha uma sugestão. Ex.: quem depositou mais esta semana?" (ou, no ambiente de demonstração, "Indisponível no ambiente de demonstração").',
          notes:
            'Enquanto a resposta está sendo buscada aparece "Consultando os jogadores…" com um ícone girando; depois de 15 segundos sem resposta, some ao lado o aviso "Esta consulta está demorando. Tente uma pergunta com período menor." (a consulta continua rodando, é só um aviso).',
        },
        {
          anchor: "ia.resposta.resumo",
          label: "Resumo da resposta",
          what: "Um texto curto (ícone de lâmpada) que resume o que a IA encontrou, em português corrido.",
        },
        {
          anchor: "ia.resposta.metricas",
          label: "Cartões de métrica",
          what: "Números de apoio à resposta (um rótulo e um valor cada), quando a pergunta pede uma contagem ou soma em vez de uma lista de jogadores.",
        },
        {
          anchor: "ia.resposta.insights",
          label: "Cartões de observação",
          what: "Observações da IA sobre o que foi encontrado, cada uma com um título e um texto, coloridas conforme o tom: alerta (vermelho), atenção (amarelo), sucesso (verde) ou informação (azul).",
        },
        {
          anchor: "ia.resposta.cartao-jogador",
          label: "Cartão de jogador",
          what: 'Um cartão por jogador da resposta, com nome, telefone (e um atalho "WhatsApp" quando o telefone existir), as etiquetas VIP/classificação/status, o "Score do player" (0 a 100, calculado pelo CRM a partir do comportamento recente), o lucro (depositado menos sacado) e, conforme a pergunta, o saldo na banca, os valores de hoje ou os totais de depositado/sacado, mais o último login e o último depósito. Repete-se em cada jogador da resposta; a âncora marca só o primeiro.',
          notes:
            'As etiquetas de classificação usam os mesmos nomes do resto do CRM: "VIP", "Lead Quente", "Lead Frio", "Alto Potencial" e "Em Risco" (jogadores "Neutro" não mostram etiqueta de classificação). Quando a IA explica por que aquele jogador entrou na lista, esse motivo aparece em itálico abaixo dos números do cartão.',
        },
        {
          anchor: "ia.resposta.ver-mais",
          label: "Ver mais (N restantes)",
          what: "A lista de jogadores mostra 6 por vez; este botão carrega mais 6. O número entre parênteses mostra quantos ainda faltam.",
        },
        {
          anchor: "ia.feedback.bom",
          label: 'Essa resposta ajudou? — polegar para cima',
          what: 'Registra a resposta como boa. Depois de clicar, aparece o aviso "Obrigado pelo feedback!" e, no lugar dos dois botões, "feedback registrado".',
          notes:
            'Se a resposta não tiver um identificador válido (caso raro, de uma resposta antiga da sessão), aparece o erro "Resposta sem id (recarregue a página)." e nada é registrado.',
        },
        {
          anchor: "ia.feedback.ruim",
          label: "Essa resposta ajudou? — polegar para baixo",
          what: 'Abre o formulário "O que estava errado?" para explicar o problema e, se quiser, ensinar a resposta certa.',
        },
        {
          anchor: "ia.feedback.motivo",
          label: "O que estava errado?",
          what: "Texto livre explicando o que a resposta errou.",
        },
        {
          anchor: "ia.feedback.resposta-ideal",
          label: "Como deveria ter respondido? (vai virar exemplo de treino)",
          what: "Texto livre com a resposta que a IA deveria ter dado. Opcional — mas se for preenchido, vira automaticamente um rascunho de exemplo em Configurar IA → Exemplos (inativo até alguém ligar a chave lá).",
        },
        {
          anchor: "ia.feedback.enviar",
          label: "Enviar (feedback ruim)",
          what: 'Grava a avaliação ruim (e o rascunho de exemplo, se o campo "resposta ideal" foi preenchido).',
          notes:
            'Depois de enviar, os botões somem e aparece "feedback registrado"; a confirmação muda conforme o que foi preenchido: "Exemplo salvo como rascunho em Treino IA" quando a resposta ideal foi escrita, ou "Feedback enviado" quando só o motivo foi preenchido.',
        },
      ],
    },
  ],

  states: [
    {
      id: "vazio",
      title: "O que você quer saber?",
      what: 'Tela inicial da conversa, antes da primeira pergunta. O texto abaixo muda conforme o ambiente: "Escreva uma pergunta ou escolha uma sugestão. Ex.: quem depositou mais esta semana?" normalmente, ou "Indisponível no ambiente de demonstração" na casa de demonstração.',
      action: "Digite uma pergunta ou clique numa sugestão à direita.",
    },
    {
      id: "consultando",
      title: "Consultando os jogadores…",
      what: "A pergunta foi enviada e a resposta ainda está sendo calculada.",
    },
    {
      id: "consulta-lenta",
      title: "Esta consulta está demorando. Tente uma pergunta com período menor.",
      what: "Aviso que aparece ao lado de \"Consultando os jogadores…\" quando a resposta passa de 15 segundos sem voltar. A consulta continua rodando sozinha — não é um erro, só um aviso de demora.",
      action: "Espere a resposta ou, da próxima vez, peça um período mais curto (ex.: \"hoje\" em vez de \"este ano\").",
    },
    {
      id: "erro-consulta",
      title: "Não consegui consultar a IA agora. Tente novamente.",
      what: 'Mensagem fixa mostrada no lugar da resposta sempre que a consulta falha, qualquer que seja o motivo (sem conexão, a casa sem acesso, um erro interno da função de borda). O texto nunca muda para mostrar o motivo real.',
      action: "Tente perguntar de novo. Se continuar falhando, avise o suporte.",
    },
    {
      id: "demo-indisponivel",
      title: "Indisponível no ambiente de demonstração",
      what: 'No ambiente de demonstração, o campo de pergunta e o botão de enviar ficam desabilitados com este aviso no lugar do texto de exemplo (e como dica ao passar o mouse no botão de enviar) — a casa de demonstração não tem acesso ao assistente.',
    },
    {
      id: "sem-id-feedback",
      title: "Resposta sem id (recarregue a página).",
      what: 'Erro ao clicar no polegar para cima de uma resposta sem identificador válido para o feedback (situação rara).',
      action: "Atualize a página e tente avaliar a resposta de novo.",
    },
    {
      id: "resposta-sem-dados",
      title: "Sem dados para mostrar.",
      what: 'Texto mostrado no lugar da resposta quando a IA responde sem resumo, sem jogadores, sem observações e sem métricas — a pergunta foi entendida e respondida, mas não há nada para exibir.',
      action: "Tente reformular a pergunta ou pedir um período diferente.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "ia.pergunta",
        title: "Pergunte em português comum",
        body: 'Escreva algo como "quem depositou mais esta semana?" e aperte Enter (ou use o botão de enviar).',
        articleSection: "assistente",
      },
      {
        anchor: "ia.sugestoes",
        title: "Ou escolha uma sugestão",
        body: "Perguntas prontas, como os maiores depositantes ou quem está sem jogar — clique para enviar na hora.",
        articleSection: "assistente",
      },
      {
        anchor: "ia.sugestao",
        title: "Um clique já envia",
        body: "Não precisa digitar nem confirmar: clicar na sugestão já manda a pergunta.",
        articleSection: "assistente",
      },
      {
        anchor: "ia.enviar",
        title: "Enviar pergunta",
        body: "Manda o que foi digitado no campo. Fica desabilitado enquanto uma resposta está sendo buscada.",
        articleSection: "assistente",
      },
      {
        anchor: "ia.conversa",
        title: "A resposta aparece aqui",
        body: "O resumo, os cartões de jogador e as métricas aparecem nesta área, na ordem das perguntas feitas.",
        articleSection: "assistente",
      },
    ],
  },
};

export default screen;
