// Help article for the first-access setup wizard ("onboarding"), a virtual
// screen (no route of its own — VIRTUAL_SCREENS, coverage-config.ts). Shown
// full-screen, over the app shell, the first time a house's admin opens the
// CRM: four steps, Casa → Encurtador → E-mail → Pronto
// (src/components/onboarding/house-setup-wizard.tsx WIZARD_STEPS). Each step
// embeds the Task 9 house-config sections with `variant="wizard"` (same
// components, same anchors, as /configuracoes/casa — see
// src/help/screens/configuracoes-casa.ts for what those fields do); this
// article documents only the wizard's own chrome (the step markers, "Pular
// configuração", "Fazer depois", "Avançar"/"Concluir" and the "Pronto"
// step's summary) and reuses the Task 9 anchors in its per-step tours.
//
// `OnboardingGate` (src/components/onboarding/onboarding-gate.tsx) overrides
// the help context to this screen while the wizard shows
// (`setScreenOverride("onboarding", <passo>)`), with `<passo>` one of
// "casa" | "encurtador" | "email" | "pronto" (HouseSetupWizard's
// `WizardStepId`) — the same ids used as the `tours` keys below, so each
// step gets its own tour, keyed `tour:onboarding#<passo>`.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "onboarding",
  route: "onboarding",
  title: "Assistente de primeiro acesso",
  purpose:
    "Guia de configuração mostrado em tela cheia na primeira vez que o administrador da casa abre o CRM: endereço do site, domínio do encurtador e domínio/remetente de e-mail, em quatro passos.",
  roles: ["admin", "gestor", "member", "expert"],
  sections: [
    {
      id: "navegacao",
      title: "Navegação do assistente",
      intro:
        'Aparece sobre o restante do CRM (o menu e o cabeçalho continuam por baixo, só não ficam visíveis) até a casa pular ou concluir a configuração. Os campos de cada passo são os mesmos de Configurações → Casa — veja o artigo dessa tela para o que cada campo faz.',
      items: [
        {
          label: "Marcadores de passo (1. Casa, 2. Encurtador, 3. E-mail, 4. Pronto)",
          what: 'Mostram em qual dos quatro passos você está — o marcador do passo atual aparece destacado. Não são clicáveis: não dá para saltar direto para um passo clicando neles, só avançando pelo assistente.',
          notes:
            'O passo "E-mail" some dos marcadores (e do assistente) quando o canal E-mail está desligado para a casa; nesse caso, "Avançar" no passo Encurtador segue direto para "Pronto".',
        },
        {
          anchor: "onboarding.header.skip",
          label: "Pular configuração",
          what: "Fecha o assistente imediatamente, de qualquer passo, sem salvar nada que ainda não tenha sido salvo antes. A casa pode voltar a configurar tudo depois em Configurações → Casa; o assistente não aparece mais sozinho depois de pulado.",
        },
        {
          anchor: "onboarding.footer.later",
          label: "Fazer depois",
          what: "Avança para o próximo passo sem salvar o que ainda estiver em aberto no passo atual — o que já tinha sido salvo antes continua salvo. Não aparece no último passo (Pronto), porque não há mais nada para deixar para depois.",
        },
        {
          anchor: "onboarding.footer.primary",
          label: "Avançar / Concluir",
          what: 'O botão principal do rodapé: chama-se "Avançar" em Casa, Encurtador e E-mail, e "Concluir" no último passo (Pronto). No passo Casa, "Avançar" primeiro salva a URL da casa e as URLs rápidas que você tiver digitado (mesmo sem clicar em "Salvar" dentro do passo) antes de seguir adiante; nos outros passos ele só avança. "Concluir" fecha o assistente de vez, com a configuração marcada como feita.',
          notes:
            'Enquanto salva, o texto do botão muda para "Salvando…" (passo Casa) ou "Concluindo…" (passo Pronto) e ele fica desabilitado até terminar. Se o salvamento automático do passo Casa falhar (por exemplo, "URL inválida"), o assistente continua no mesmo passo e mostra o erro — nada avança até corrigir.',
        },
      ],
    },
    {
      id: "pronto",
      title: "Passo Pronto",
      intro: "Último passo do assistente: um resumo do que falta configurar antes de concluir.",
      items: [
        {
          anchor: "onboarding.pronto.intro",
          label: 'Texto "Tudo pronto..."',
          what: 'Avisa que, a partir daqui, qualquer coisa configurada no assistente pode ser revista ou alterada depois em Configurações → Casa.',
        },
        {
          anchor: "onboarding.pronto.resumo",
          label: 'Cartão "Resumo da configuração"',
          what: 'Repete a mesma lista e a mesma contagem ("N de M") do cartão "Configure sua casa" do Início: URL da casa e URLs rápidas, domínio do encurtador e domínio/remetente de e-mail, cada um com seu estado (feito, aguardando DNS ou ainda não feito).',
          notes:
            "Só aparece depois que o assistente carrega o estado de configuração da casa; pode levar um instante para surgir ao abrir o passo Pronto.",
        },
      ],
    },
  ],

  states: [
    {
      id: "pular-falhou",
      title: "Erro ao salvar que o assistente foi pulado",
      what: 'Se "Pular configuração" não conseguir gravar (uma falha de comunicação com o banco de dados), aparece um aviso com a mensagem do erro e o assistente continua na tela, no mesmo passo.',
      action: "Tente novamente; se continuar falhando, recarregue a página e tente de novo.",
    },
    {
      id: "concluir-falhou",
      title: "Erro ao concluir a configuração",
      what: 'Se "Concluir" (passo Pronto) não conseguir gravar (uma falha de comunicação com o banco de dados), aparece um aviso com a mensagem do erro e o assistente continua na tela, no passo Pronto.',
      action: "Tente novamente; se continuar falhando, recarregue a página e tente de novo.",
    },
  ],

  tours: {
    casa: [
      {
        anchor: "onboarding.header.markers",
        title: "Quatro passos",
        body: "O assistente tem quatro passos: Casa, Encurtador, E-mail e Pronto. O marcador destacado mostra onde você está.",
        articleSection: "navegacao",
      },
      {
        anchor: "casa.site.url",
        title: "URL da casa",
        body: "Comece pelo endereço do site da sua casa — ele é usado para sugerir o domínio do encurtador e montar as URLs rápidas.",
      },
      {
        anchor: "casa.quick-links.add",
        title: "URLs rápidas",
        body: "Atalhos como Login e Depósito, usados ao montar campanhas e jornadas depois.",
      },
      {
        anchor: "onboarding.header.skip",
        title: "Pular configuração",
        body: "Quer configurar tudo depois? Pule o assistente agora e volte em Configurações → Casa quando quiser.",
        articleSection: "navegacao",
      },
      {
        anchor: "onboarding.footer.later",
        title: "Fazer depois",
        body: "Avança sem salvar o que ainda estiver em aberto neste passo.",
        articleSection: "navegacao",
      },
      {
        anchor: "onboarding.footer.primary",
        title: "Avançar",
        body: 'Aqui, "Avançar" já salva a URL da casa e as URLs rápidas antes de seguir para o próximo passo.',
        articleSection: "navegacao",
      },
    ],
    encurtador: [
      {
        anchor: "onboarding.header.markers",
        title: "Passo 2 de 4",
        body: "Agora o domínio do encurtador de links — o que aparece nos SMS e e-mails em vez do domínio padrão do CRM.",
        articleSection: "navegacao",
      },
      {
        anchor: "casa.encurtador.hostname",
        title: "Domínio do encurtador",
        body: "Digite o domínio ou subdomínio (ex.: go.suacasa.bet.br) que vai hospedar os links curtos da casa.",
      },
      {
        anchor: "casa.encurtador.add-domain",
        title: "Adicionar domínio",
        body: "Cadastra o domínio e gera os registros DNS para colar no provedor onde ele foi comprado.",
      },
      {
        anchor: "casa.dominio.dns-table",
        title: "Registros DNS",
        body: "Copie cada registro e cole no painel do seu domínio. A verificação é automática — pode levar algumas horas.",
      },
      {
        anchor: "onboarding.footer.later",
        title: "Fazer depois",
        body: "Sem domínio verificado ainda? Sem problema: os links continuam saindo pelo encurtador padrão do CRM enquanto isso.",
        articleSection: "navegacao",
      },
      {
        anchor: "onboarding.footer.primary",
        title: "Avançar",
        body: "Segue para o passo de e-mail (ou direto para o resumo, se o canal E-mail estiver desligado) — nada precisa estar verificado ainda para avançar.",
        articleSection: "navegacao",
      },
    ],
    email: [
      {
        anchor: "onboarding.header.markers",
        title: "Passo 3 de 4",
        body: "Por último antes do resumo: o domínio de e-mail e quem envia as campanhas e jornadas.",
        articleSection: "navegacao",
      },
      {
        anchor: "casa.email.hostname",
        title: "Domínio de e-mail",
        body: "Digite o domínio ou subdomínio (ex.: mail.suacasa.bet.br) que vai enviar os e-mails da casa.",
      },
      {
        anchor: "casa.email.add-domain",
        title: "Adicionar domínio",
        body: "Cadastra o domínio e gera os registros DNS para colar no provedor onde ele foi comprado.",
      },
      {
        anchor: "casa.remetente.domain",
        title: "Escolha o domínio do remetente",
        body: "Depois do domínio verificado, escolha-o aqui para criar o primeiro remetente.",
      },
      {
        anchor: "casa.remetente.save",
        title: "Salvar remetente",
        body: "Grava o remetente. Ele já pode ser usado em campanhas e jornadas de e-mail.",
      },
      {
        anchor: "onboarding.footer.primary",
        title: "Avançar",
        body: "Segue para o resumo final (Pronto) — nada aqui precisa estar pronto para avançar.",
        articleSection: "navegacao",
      },
    ],
    pronto: [
      {
        anchor: "onboarding.header.markers",
        title: "Último passo",
        body: "Chegou ao resumo: um retrato de tudo que o assistente cobriu.",
        articleSection: "navegacao",
      },
      {
        anchor: "onboarding.pronto.intro",
        title: "Tudo pronto",
        body: "Qualquer coisa configurada aqui pode ser revista depois em Configurações → Casa.",
        articleSection: "pronto",
      },
      {
        anchor: "onboarding.pronto.resumo",
        title: "Resumo da configuração",
        body: "A mesma lista do Início: o que já está feito, o que está aguardando DNS e o que ainda falta.",
        articleSection: "pronto",
      },
      {
        anchor: "onboarding.header.skip",
        title: "Pular configuração",
        body: "Ainda dá para pular daqui, se preferir terminar depois.",
        articleSection: "navegacao",
      },
      {
        anchor: "onboarding.footer.primary",
        title: "Concluir",
        body: 'Aqui o botão principal é "Concluir": fecha o assistente de vez e marca a configuração inicial como feita.',
        articleSection: "navegacao",
      },
    ],
  },
};

export default screen;
