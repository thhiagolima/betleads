// Help article for "Integrações" (/webhooks). Nesta fase 1, só a aba
// "Links curtos" (`links`) tem conteúdo — as abas "Plataforma de apostas"
// (`plataforma`) e "Meta Ads" (`meta`) ficam em PENDING_ROUTES
// ("/webhooks#plataforma", "/webhooks#meta") até uma tarefa futura cobri-las.
// Fonte: src/routes/webhooks.tsx (as 3 abas, TABS, hash default "plataforma")
// e, para a aba Links curtos: src/components/integrations/links-overview.tsx
// (KPIs + "Por canal e origem") e src/components/integrations/links-settings.tsx
// (formulário de configuração + o card de erro do não-admin).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "webhooks",
  route: "/webhooks",
  title: "Integrações",
  purpose:
    "Conectar a plataforma de apostas, configurar os links curtos (encurtador) e a conta de anúncios da Meta. Esta versão do artigo cobre só a aba Links curtos.",
  roles: ["admin", "gestor", "member", "expert"],
  terms: ["encurtador"],
  sections: [
    // ---------------------------------------------------------------
    // Aba Links curtos
    // ---------------------------------------------------------------
    {
      id: "links",
      title: "Links curtos",
      tab: "links",
      intro:
        "Os links enviados por SMS e e-mail viram links curtos (com o domínio da casa, configurado em Configuração da casa) para o CRM contar quem clicou. Esta aba mostra o desempenho desses links e a configuração do encurtador.",
      items: [
        {
          label: "Links enviados / Cliques / Taxa de clique",
          what: 'Três números dos últimos 30 dias: "Links enviados" (quantos links curtos foram criados), "Cliques" (quantos desses links foram clicados pelo menos uma vez) e "Taxa de clique" (cliques ÷ links enviados, em %).',
          notes:
            "São só leitura, atualizados a partir dos cliques no redirecionador do próprio CRM — não precisa atualizar a página manualmente para os números mudarem na próxima visita.",
        },
        {
          label: 'Cartão "Por canal e origem"',
          what: 'Uma linha por combinação de canal e origem (por exemplo "SMS — Campanha" ou "E-mail — Jornada"), cada uma com cliques, envios e a taxa de clique daquela combinação, nos últimos 30 dias.',
          notes:
            'Enquanto carrega mostra um esqueleto; se a busca falhar, mostra "Não foi possível carregar os números de links. Tente de novo em instantes." — veja em "Situações que podem aparecer".',
        },
        {
          anchor: "webhooks.links.enabled",
          label: "Ativar links curtos",
          what: "Liga ou desliga o encurtamento de links nas mensagens da casa.",
          roles: ["admin"],
          notes:
            'Desligado, os links das mensagens saem no tamanho original — o CRM para de registrar cliques por link individual. O que fazer quando o encurtador falhar (uma vez ligado) é configurado em "Se o encurtador falhar", mais abaixo.',
        },
        {
          anchor: "webhooks.links.dominio-link",
          label: "Configuração da casa (link)",
          what: 'Leva até a aba Encurtador de "Configuração da casa", onde fica o domínio próprio usado nos links curtos (por exemplo go.suacasa.bet.br).',
          roles: ["admin"],
          notes:
            "Sem domínio próprio verificado lá, os links continuam saindo pelo domínio padrão do CRM — nada para de funcionar.",
        },
        {
          anchor: "webhooks.links.hosts",
          label: "Sites permitidos",
          what: "Lista de sites (domínios), separados por vírgula, para os quais o encurtador aceita gerar links. Um link para qualquer outro site não é encurtado.",
          roles: ["admin"],
          notes:
            "Em branco, vale para qualquer site de destino. Preencher é uma forma de garantir que só os links da própria casa (ou de parceiros combinados) sejam encurtados.",
        },
        {
          anchor: "webhooks.links.ttl",
          label: "Validade do link (dias)",
          what: "Por quantos dias um link curto continua funcionando depois de criado.",
          roles: ["admin"],
          notes: "Em branco, o link não expira — continua redirecionando para sempre.",
        },
        {
          anchor: "webhooks.links.fallback",
          label: "Se o encurtador falhar",
          what: 'Escolhe o que fazer quando o provedor do encurtador (Short.io) não responde no momento de um envio: "Não enviar a mensagem" (bloqueia o envio até o encurtador voltar) ou "Enviar com o link original" (manda a mensagem com o link completo, sem contar cliques dessa vez).',
          roles: ["admin"],
        },
        {
          anchor: "webhooks.links.save",
          label: "Salvar",
          what: "Grava as configurações de links curtos desta casa.",
          roles: ["admin"],
          notes:
            'Mostra "Salvando…" enquanto grava e o aviso "Configuração de links salva" ao terminar. Se a gravação falhar, mostra "Não foi possível salvar: <motivo>" (quando o servidor manda um motivo específico) ou "Não foi possível salvar a configuração de links".',
        },
      ],
    },
  ],

  states: [
    {
      id: "links-erro-numeros",
      title: "Não foi possível carregar os números de links. Tente de novo em instantes.",
      what: 'Mensagem mostrada no cartão "Por canal e origem" quando a busca dos números falha.',
      action: "Recarregue a página ou tente de novo em alguns instantes.",
    },
    {
      id: "links-sem-envios",
      title: "Nenhum link enviado nos últimos 30 dias.",
      what: 'Mensagem mostrada no cartão "Por canal e origem" quando a casa ainda não enviou nenhum link curto no período.',
    },
    {
      id: "links-nao-admin",
      title: "Não foi possível abrir as configurações de links",
      what: 'Cartão mostrado no lugar do formulário de configuração para quem não é administrador da casa — o servidor só responde a pedidos de admin. Abaixo do título aparece "Esta área é do administrador da casa. Se você é admin, tente de novo em instantes."',
      action: "Peça a um administrador da casa para ajustar a configuração de links curtos.",
    },
  ],

  tours: {
    links: [
      {
        anchor: "webhooks.links.enabled",
        title: "Ativar links curtos",
        body: "Liga o encurtamento dos links das mensagens, para o CRM contar quem clica em cada envio.",
        articleSection: "links",
      },
      {
        anchor: "webhooks.links.dominio-link",
        title: "Domínio do encurtador",
        body: "O domínio próprio usado nos links fica em Configuração da casa, na aba Encurtador.",
        articleSection: "links",
      },
      {
        anchor: "webhooks.links.hosts",
        title: "Sites permitidos",
        body: "Limite o encurtador a estes sites, separados por vírgula. Em branco, vale para qualquer site.",
        articleSection: "links",
      },
      {
        anchor: "webhooks.links.ttl",
        title: "Validade do link",
        body: "Quantos dias um link curto continua funcionando. Em branco, nunca expira.",
        articleSection: "links",
      },
      {
        anchor: "webhooks.links.fallback",
        title: "Se o encurtador falhar",
        body: "Escolha bloquear o envio ou mandar a mensagem com o link original quando o encurtador não responder.",
        articleSection: "links",
      },
      {
        anchor: "webhooks.links.save",
        title: "Salvar",
        body: "Grava a configuração de links curtos desta casa.",
        articleSection: "links",
      },
    ],
  },
};

export default screen;
