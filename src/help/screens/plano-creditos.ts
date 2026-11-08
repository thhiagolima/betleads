// Help article for "Plano e créditos" (/plano-e-creditos), sem abas.
// Fonte: src/routes/plano-e-creditos.tsx, src/components/billing/{
// pix-payment-dialog,buy-credits-dialog,wallet-balance-notice,
// low-balance-threshold-card,wallet-usage-panels}.tsx, src/lib/billing/{
// billing-view,billing.functions,topup.functions,wallet-notice}.ts,
// src/lib/sms-credits.functions.ts. Compartilha com /tenants#saldo (prefixo
// "carteira.", veja conta-equipe.ts) o resumo de consumo/preços da carteira,
// e com toda tela da casa (shell.ts) a faixa/bloqueio da mensalidade — este
// artigo é quem documenta os textos exatos de cada situação de cobrança.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "plano-creditos",
  route: "/plano-e-creditos",
  title: "Plano e créditos",
  purpose:
    "A mensalidade do plano (com o Pix para pagar), o saldo de créditos e a compra por Pix, o alerta de saldo baixo, as faturas com o comprovante, e o consumo do mês, os preços vigentes e o extrato da carteira.",
  roles: ["admin", "gestor", "member"],
  terms: ["pix-copia-cola", "franquia-mensal"],
  sections: [
    // ---------------------------------------------------------------
    // Mensalidade
    // ---------------------------------------------------------------
    {
      id: "mensalidade",
      title: "Mensalidade",
      intro:
        'O plano da casa e a situação do pagamento. Uma casa isenta (plano "Interno") não mostra nada aqui além do selo "Plano interno — isento" — ela não paga mensalidade.',
      items: [
        {
          anchor: "creditos.mensalidade.card",
          label: "Cartão da mensalidade",
          what: 'Mostra um selo de situação e, quando a casa não é isenta, o nome do plano e o valor por mês (com o valor cheio riscado ao lado do valor com desconto, quando há um desconto ativo) e o período atual coberto ("Período atual: DD/MM a DD/MM").',
          notes:
            'O selo é um destes: "Em dia até DD/MM" (tudo certo; DD/MM é o último dia coberto antes da próxima fatura), "Vence em DD/MM · daqui a N dia(s)" (fatura aberta, ainda dentro do prazo), "Vencida em DD/MM" (fatura vencida, acesso ainda liberado), "Bloqueada" (fatura vencida e o acesso já foi suspenso), "Plano pausado", "Aguardando primeiro pagamento" ou "Plano interno — isento".',
        },
        {
          anchor: "creditos.mensalidade.pagar",
          label: "Pagar mensalidade (Pix)",
          what: "Gera o Pix da fatura em aberto e abre o diálogo de pagamento (veja \"Diálogo de pagamento Pix\" abaixo).",
          notes:
            'Só aparece com uma fatura em aberto e para quem pode pagar (administrador, gestor ou super admin). Quem não pode pagar (membro) vê, no lugar do botão, "Peça ao administrador da casa para pagar a mensalidade."',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Diálogo de pagamento Pix (mensalidade e compra de créditos)
    // ---------------------------------------------------------------
    {
      id: "pix",
      title: "Diálogo de pagamento Pix",
      intro:
        "O mesmo diálogo abre tanto para pagar a mensalidade (\"Pagar mensalidade (Pix)\", na fatura em aberto ou na lista de Faturas) quanto para comprar créditos (\"Gerar Pix\", dentro de \"Comprar créditos\"). Ele passa por até 5 situações, uma por vez:",
      items: [
        {
          label: "1. Aguardando pagamento (QR Code, Pix Copia e Cola, contagem regressiva)",
          what: 'Título "Pague com Pix" com o valor e, quando o Pix tem prazo, "— expira em M:SS" (contagem regressiva, atualizada a cada segundo). Mostra o QR Code para escanear, o campo "Pix Copia e Cola" com o código (somente leitura) e o botão de copiar (ícone), e, quando o provedor devolve um link, "Abrir página de pagamento" (abre em nova aba).',
          notes:
            'Copiar o código mostra "Código Pix copiado"; se o navegador recusar copiar, mostra "Não foi possível copiar o código Pix". O pagamento é detectado automaticamente (o diálogo verifica a cada poucos segundos) — não precisa fechar e reabrir.',
        },
        {
          label: '2. Expirado ("Este Pix expirou")',
          what: 'Quando a contagem regressiva chega a zero (ou o provedor confirma a expiração), o diálogo troca para "Este Pix expirou", com o botão "Gerar outro" (cria um novo Pix do zero, com um novo prazo).',
        },
        {
          label: "3. Pagamento recebido, confirmando",
          what: 'Texto "Pagamento recebido, confirmando…" com um indicador de carregamento — aparece no instante entre o Pix ser pago e a confirmação final processar.',
        },
        {
          label: "4. Pagamento em análise",
          what: '"Pagamento em análise. Fale com o suporte." — um pagamento que precisa ser conferido manualmente antes de valer; o botão "Fechar" encerra o diálogo (o crédito/a mensalidade só valem depois da análise).',
        },
        {
          label: "5. Pago/confirmado",
          what: 'Título igual ao que está sendo pago ("Mensalidade paga" ou "Pagamento confirmado") com o texto de sucesso e o botão "Fechar". Para a mensalidade, o texto é "Mensalidade paga — acesso liberado até DD/MM" (o dia antes do próximo vencimento) assim que o novo vencimento é conhecido — antes disso, mostra só "Mensalidade paga."; para a compra de créditos, "Pagamento confirmado — R$ X adicionados ao saldo."',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Saldo e compra de créditos
    // ---------------------------------------------------------------
    {
      id: "saldo",
      title: "Saldo e compra de créditos",
      intro: "O saldo de créditos da casa (usado em SMS e Voz) e como comprá-lo por Pix.",
      items: [
        {
          anchor: "canal.carteira.aviso",
          label: "Aviso de saldo",
          what: 'Quando o saldo está baixo ou zerado, uma faixa amarela ou vermelha aparece aqui (e em SMS/Voz/E-mail também): "Saldo baixo" (amarela) ou "Seu saldo acabou" (vermelha), com o texto "SMS e voz ficam bloqueados até entrar saldo; e-mail segue só dentro da franquia mensal." seguido de "Compre créditos por Pix em Saldo e consumo." (link para esta mesma tela, quando você pode comprar) ou "A compra por Pix chega em breve; enquanto isso, fale com o suporte para adicionar saldo." (quando não pode).',
          notes:
            'Casa isenta nunca mostra este aviso. "Saldo baixo" aparece abaixo do limite configurado em "Alerta de saldo baixo" (R$ 200 por padrão); "Seu saldo acabou" aparece com saldo zero ou negativo, ou menor que o preço de um SMS.',
        },
        {
          anchor: "creditos.saldo.cartoes",
          label: "Os 3 cartões (Saldo atual, Comprado, Consumido)",
          what: '"Saldo atual" é o que está disponível agora para consumo — créditos não expiram. "Comprado" é o total histórico comprado. "Consumido" é o total já usado desde o início.',
        },
        {
          anchor: "creditos.saldo.comprar",
          label: "Comprar créditos (Pix)",
          what: 'Abre o diálogo "Comprar créditos": pacotes prontos em botões (cada um com um valor em R$) e o campo "Outro valor (R$, mínimo 100)" para informar um valor livre, com o botão "Gerar Pix" (gera o Pix e passa para o diálogo de pagamento, acima).',
          roles: ["admin", "gestor"],
          notes:
            'Erros do valor livre: "Valor inválido" (não é um número), "Valor mínimo de compra: R$ 100,00" (abaixo de R$ 100) e "Valor máximo de compra: R$ 50.000,00" (acima de R$ 50.000). Erros ao gerar: "Compra por Pix indisponível no momento." (recurso desligado na plataforma), "Esta casa é isenta e não precisa comprar créditos", "Você já tem Pix em aberto. Pague ou aguarde expirar antes de gerar outro." (até 3 Pix em aberto ao mesmo tempo) e "Não foi possível gerar o Pix agora. Tente de novo em instantes." (falha do provedor).',
        },
        {
          label: 'Botão desabilitado "Disponível depois de pagar a mensalidade"',
          what: "Aparece no lugar de \"Comprar créditos (Pix)\" quando a mensalidade da casa está em atraso a ponto de bloquear a compra de créditos.",
          notes:
            'Quem não pode comprar (não é admin/gestor) e a compra não está bloqueada pela mensalidade simplesmente não vê nenhum botão aqui — nem ativo, nem desabilitado.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Alerta de saldo baixo
    // ---------------------------------------------------------------
    {
      id: "alerta",
      title: "Alerta de saldo baixo",
      intro:
        'Define a partir de qual saldo a casa começa a ver o aviso amarelo e a receber um e-mail por dia. Escondido para casa isenta e para a casa de demonstração.',
      items: [
        {
          anchor: "creditos.alerta.card",
          label: "Alerta de saldo baixo",
          what: 'Mostra o texto "Quando o saldo ficar abaixo de R$ X, mostramos um aviso e mandamos um e-mail por dia para os administradores e gestores da casa." (ou "Alerta desligado: só avisamos quando o saldo acabar.", com o limite em R$ 0) e, para quem pode editar, o campo "Avisar abaixo de (R$)" com o botão "Salvar".',
          roles: ["admin", "gestor"],
          notes:
            'Erro ao digitar um valor fora da faixa: "Informe um valor entre R$ 0 e R$ 100.000 (0 desliga o alerta)." Sucesso ao salvar mostra "Limite de saldo baixo salvo." Quem não pode editar (membro) só vê o texto, sem o campo.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Faturas
    // ---------------------------------------------------------------
    {
      id: "faturas",
      title: "Faturas",
      intro: 'Escondida por completo quando a casa nunca teve nenhuma fatura (por exemplo, uma casa isenta).',
      items: [
        {
          anchor: "creditos.faturas.tabela",
          label: "Tabela de faturas",
          what: 'Colunas Período, Vencimento, Valor (com o valor cheio riscado ao lado, quando havia desconto), Situação ("Em aberto", "Paga em DD/MM" ou "Cancelada") e Ação.',
        },
        {
          label: "Pagar (por fatura em aberto)",
          what: "Mesmo fluxo do botão \"Pagar mensalidade (Pix)\" acima, para aquela fatura específica.",
          roles: ["admin", "gestor"],
        },
        {
          anchor: "creditos.faturas.comprovante",
          label: "Comprovante (por fatura paga)",
          what: 'Abre o diálogo "Comprovante de pagamento": Descrição, Data do pagamento, Valor, Forma de pagamento ("Pix", "Pagamento registrado pelo suporte" ou "Desconto integral") e, quando existir, o "Identificador do Pix"; o botão "Imprimir" abre a impressão do navegador. Repete-se em cada fatura paga; a âncora marca só a primeira.',
          notes:
            'Enquanto carrega, mostra "Carregando…"; se não conseguir carregar, mostra "Não foi possível carregar o comprovante."',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Consumo, preços e extrato
    // ---------------------------------------------------------------
    {
      id: "consumo",
      title: "Consumo do mês, preços vigentes e extrato",
      intro:
        "O mesmo resumo da carteira que aparece em Conta e equipe → Saldo SMS, aqui filtrado só pelos canais que a casa tem ligados.",
      items: [
        {
          anchor: "carteira.consumo-mes",
          label: "Consumo do mês",
          what: 'Unidades usadas em cada canal ligado (SMS, Voz, E-mail, Web Push) neste mês, o valor já cobrado, e "X de Y grátis" para o canal que tem franquia mensal.',
        },
        {
          anchor: "carteira.precos-vigentes",
          label: "Preços vigentes",
          what: 'Uma linha por canal ligado, com o preço unitário e a franquia mensal ("-" quando o canal não tem franquia).',
        },
        {
          anchor: "creditos.extrato.tabela",
          label: "Extrato",
          what: 'Colunas Data, Tipo (Compra, Ajuste, Consumo, Estorno ou Conversão de créditos), Canal, Unidades, Valor (verde quando soma saldo, vermelho quando consome) e Saldo depois.',
          notes:
            'Sem nenhuma movimentação, mostra "Nenhuma movimentação ainda." — ou, na casa de demonstração, "Nenhum dado neste ambiente de demonstração".',
        },
      ],
    },
  ],

  states: [
    {
      id: "carregando",
      title: "Carregando",
      what: "Seis cartões cinza piscando, enquanto os dados de cobrança e de carteira chegam do servidor.",
    },
    {
      id: "erro-carregar",
      title: "Não foi possível carregar os dados de cobrança agora. Tente novamente em instantes.",
      what: "Mostrado no lugar de toda a tela quando a carteira ou a cobrança não puderam ser lidas.",
      action: "Recarregue a página em alguns instantes.",
    },
    {
      id: "isento",
      title: "Plano interno — isento",
      what: "A casa não paga mensalidade nem compra créditos — o bloco da mensalidade mostra só o selo, sem valor nem botão de pagar; o saldo e o extrato continuam funcionando normalmente, mas a casa nunca vê o aviso de saldo baixo.",
    },
    {
      id: "em-dia",
      title: "Em dia até DD/MM",
      what: "A mensalidade está paga; DD/MM é o último dia coberto antes da próxima fatura. Sem faixa de aviso em nenhuma tela.",
    },
    {
      id: "vence-em-breve",
      title: "Vence em DD/MM · daqui a N dia(s)",
      what: 'Fatura aberta, ainda dentro do prazo. Toda tela da casa mostra uma faixa amarela: "Sua mensalidade de R$ X vence em DD/MM (daqui a N dias). Pague por Pix para manter tudo funcionando." com o botão "Pagar agora" para quem pode pagar; quem não pode vê um texto mais curto com a dica de pedir ao administrador.',
      action: "Pague a fatura para não entrar em atraso.",
    },
    {
      id: "vencida",
      title: "Vencida em DD/MM",
      what: 'Fatura vencida, acesso ainda liberado. Faixa vermelha em toda tela: "Sua mensalidade venceu em DD/MM. Se não for paga até DD/MM, o acesso ao CRM será bloqueado." (quando o bloqueio automático está ligado) ou "...Pague para regularizar." (quando está desligado — nesse caso a casa nunca chega a ser bloqueada).',
      action: "Pague a fatura antes do bloqueio.",
    },
    {
      id: "bloqueada",
      title: "Bloqueada",
      what: 'Fatura vencida há tempo demais: a casa (menos o super admin) vê uma tela cheia no lugar do conteúdo, com "Acesso suspenso por falta de pagamento" e "A mensalidade de R$ X venceu em DD/MM. Pague por Pix e o acesso volta na hora.", com o botão "Ir para o pagamento" para quem pode pagar. O super admin nunca é bloqueado: vê a faixa vermelha informativa no lugar da tela cheia.',
      action: "Pague por Pix — o acesso volta assim que a confirmação chega.",
    },
    {
      id: "plano-pausado",
      title: "Plano pausado",
      what: 'A casa está com o plano pausado manualmente pela plataforma: tela cheia "Plano pausado" / "Fale com o suporte." (sem botão de pagar — pausa não se resolve pagando).',
      action: "Fale com o suporte para reativar o plano.",
    },
    {
      id: "acesso-suspenso-manual",
      title: "Acesso suspenso",
      what: 'Bloqueio manual pela plataforma, independente de fatura: tela cheia "Acesso suspenso" / "Fale com o suporte." Mostra o botão de pagar só quando havia mesmo uma fatura vencida por trás do bloqueio.',
      action: "Fale com o suporte.",
    },
    {
      id: "aguardando-primeiro-pagamento",
      title: "Aguardando primeiro pagamento",
      what: 'Casa nova que ainda não pagou a primeira mensalidade: tela cheia "Ative sua conta" / "Pague a primeira mensalidade de R$ X por Pix para começar a usar o CRM."',
      action: "Pague a primeira mensalidade para liberar o acesso.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "creditos.mensalidade.card",
        title: "Mensalidade",
        body: "O plano da casa e a situação do pagamento — em dia, vencendo, vencida ou bloqueada.",
        articleSection: "mensalidade",
      },
      {
        anchor: "creditos.mensalidade.pagar",
        title: "Pagar mensalidade",
        body: "Gera um Pix para a fatura em aberto.",
        articleSection: "mensalidade",
      },
      {
        anchor: "creditos.saldo.cartoes",
        title: "Saldo de créditos",
        body: "Saldo atual, total comprado e total consumido — os créditos usados em SMS e Voz.",
        articleSection: "saldo",
      },
      {
        anchor: "creditos.saldo.comprar",
        title: "Comprar créditos",
        body: "Escolha um pacote ou informe outro valor, e pague por Pix.",
        articleSection: "saldo",
      },
      {
        anchor: "creditos.alerta.card",
        title: "Alerta de saldo baixo",
        body: "A partir de qual saldo você quer ser avisado.",
        articleSection: "alerta",
      },
      {
        anchor: "carteira.consumo-mes",
        title: "Consumo do mês",
        body: "Quanto a casa já usou de cada canal este mês, e quanto foi cobrado.",
        articleSection: "consumo",
      },
      {
        anchor: "creditos.extrato.tabela",
        title: "Extrato",
        body: "As movimentações mais recentes da carteira: compras, consumo, ajustes e estornos.",
        articleSection: "consumo",
      },
    ],
  },
};

export default screen;
