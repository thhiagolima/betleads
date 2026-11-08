// Help article for "Configurações" (/configuracoes), sem abas. Fonte:
// src/routes/configuracoes.tsx e src/components/send-window-card.tsx (o
// mesmo componente aparece reduzido ("compact") no topo das telas de canal —
// /email, /sms e /ligações —, documentado lá com o prefixo "canal.janela.*";
// esta tela usa a versão completa, com o prefixo "configuracoes.janela.*",
// mais src/lib/send-window.functions.ts (getSendWindowStatus, updateSendWindow).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "configuracoes",
  route: "/configuracoes",
  title: "Configurações",
  purpose:
    "O horário em que a casa pode enviar SMS, e-mail e ligações (a janela de envio) e um atalho para a tela de equipe e permissões.",
  roles: ["admin", "gestor", "member", "expert"],
  terms: ["fuso-horario"],
  sections: [
    {
      id: "janela",
      title: "Janela de envio",
      intro:
        "O horário permitido para todos os disparos automáticos de SMS, e-mail e ligações. Vale para a casa inteira, em qualquer canal — não existe uma janela diferente por canal.",
      items: [
        {
          anchor: "configuracoes.janela.configurar",
          label: "Configurar",
          what: "Abre o formulário de edição com os valores atuais já preenchidos.",
          notes: "Fica desabilitado enquanto a tela ainda está carregando a configuração atual.",
        },
        {
          anchor: "configuracoes.janela.inicio",
          label: "Início",
          what: "A hora do dia (no fuso configurado) em que os envios automáticos passam a ser permitidos.",
        },
        {
          anchor: "configuracoes.janela.fim",
          label: "Fim",
          what: "A hora do dia em que os envios automáticos voltam a ficar bloqueados.",
          notes:
            'O início precisa ser menor que o fim. Tentando salvar com o início igual ou depois do fim, aparece o aviso "O horário inicial deve ser menor que o final."',
        },
        {
          anchor: "configuracoes.janela.fuso",
          label: "Fuso horário",
          what: 'Em qual fuso o Início e o Fim são interpretados, no formato "Continente/Cidade" (ex.: America/Sao_Paulo, que é o horário de Brasília). Mude só se a casa opera em outro fuso brasileiro.',
          notes:
            'Outros fusos comuns no Brasil: America/Manaus (Amazonas e Rondônia), America/Rio_Branco (Acre) e America/Noronha (Fernando de Noronha). O campo aceita qualquer texto digitado — um nome errado ou inventado não dá erro ao salvar, mas os cálculos de horário ficam errados a partir daí; digite exatamente como nos exemplos, sem espaços e sem acento.',
        },
        {
          anchor: "configuracoes.janela.dias",
          label: "Dias permitidos (Seg a Dom)",
          what: "Marca em quais dias da semana a janela vale. Clicar num dia já marcado desmarca ele (passa a bloquear os envios automáticos naquele dia da semana, mesmo dentro do horário).",
        },
        {
          anchor: "configuracoes.janela.ativa",
          label: "Janela ativa",
          what: 'Liga ou desliga a janela inteira. A descrição ao lado resume: "Desligado = envia 24h, todos os dias." — ou seja, os campos de horário e dias continuam salvos, só não são aplicados.',
        },
        {
          anchor: "configuracoes.janela.cancelar",
          label: "Cancelar",
          what: "Fecha o formulário de edição sem salvar nada, voltando aos valores que já estavam em vigor.",
        },
        {
          anchor: "configuracoes.janela.salvar",
          label: "Salvar",
          what: 'Grava o início, o fim, o fuso, os dias e se a janela está ativa. Ao salvar, mostra "Janela de envio atualizada" e a tela volta para o modo de consulta.',
        },
        {
          anchor: "configuracoes.janela.status",
          label: "Resumo (fora da edição)",
          what: 'Um grupo de números e textos só de leitura, que aparece quando você não está editando: o selo "Dentro da janela" ou "Fora da janela" (com "(janela desativada — enviando 24h)" ao lado quando a janela está desligada), o horário permitido e o fuso, quando a janela volta a abrir ("Próxima retomada"), "Pendentes fora da janela" e "Para próxima janela" (quantos envios/ligações estão esperando o horário certo), a "Última execução" (o envio mais recente de e-mail ou SMS) e, por baixo, a linha "Email:" com dois números separados por "·" — quantos e-mails de jornada (automação) estão agendados para a próxima janela e, depois, quantas campanhas de e-mail agendadas caem na próxima janela — e a linha "Ligações:" com quantas ligações estão agendadas para a próxima janela.',
        },
      ],
    },
    {
      id: "equipe",
      title: "Equipe e permissões",
      intro: "Um atalho para a tela de equipe — não é editado aqui.",
      items: [
        {
          anchor: "configuracoes.equipe.abrir",
          label: "Abrir Conta e equipe",
          what: "Leva para /tenants, onde fica quem acessa a casa e o que cada pessoa pode fazer.",
        },
      ],
    },
  ],

  states: [
    {
      id: "carregando",
      title: "Carregando…",
      what: "Mostrado no lugar do resumo da janela de envio enquanto a configuração atual ainda não chegou.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "configuracoes.janela.configurar",
        title: "Janela de envio",
        body: "O horário em que a casa pode enviar SMS, e-mail e ligações. Clique aqui para mudar.",
        articleSection: "janela",
      },
      {
        anchor: "configuracoes.janela.status",
        title: "Situação atual",
        body: "Se os envios estão dentro ou fora da janela agora, e quanto está esperando o próximo horário permitido.",
        articleSection: "janela",
      },
      {
        anchor: "configuracoes.equipe.abrir",
        title: "Equipe e permissões",
        body: "Quem acessa a casa e o que cada pessoa pode fazer fica numa tela separada, Conta e equipe.",
        articleSection: "equipe",
      },
    ],
  },
};

export default screen;
