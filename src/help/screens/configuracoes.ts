// Help article for "Configurações" (/configuracoes), sem abas. Fonte:
// src/routes/configuracoes.tsx. A antiga janela de envio global foi retirada:
// SMS, e-mail e ligações saem 24h, então a tela ficou só com o atalho de equipe.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "configuracoes",
  route: "/configuracoes",
  title: "Configurações",
  purpose: "Um atalho para a tela de equipe e permissões da casa.",
  roles: ["admin", "gestor", "member"],
  sections: [
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

  states: [],

  tours: {
    default: [
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
