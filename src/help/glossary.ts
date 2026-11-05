import { FINANCE_TERMS } from "@/components/finance/definitions";
import type { GlossaryTerm } from "./types";

/**
 * One definition per term, reused everywhere (`<Term id>`, help articles).
 * The Financeiro and Resultados entries below reuse the exact texts already
 * shown in the product (spec §4.1) — `short` is the label/sentence already
 * on screen, `long` is the fuller "como calculamos"/"como ler" text.
 * Swapping those screens' own components to import from here (instead of
 * `FINANCE_TERMS` / the Resultados "Como ler" sheet) is deferred to when
 * phases 3/4 touch those screens.
 */
export const GLOSSARY: GlossaryTerm[] = [
  // --- Financeiro (src/components/finance/definitions.ts) ---
  { id: "lucro-liquido", term: FINANCE_TERMS.cashResult.label, short: FINANCE_TERMS.cashResult.how },
  { id: "net", term: FINANCE_TERMS.net.label, short: FINANCE_TERMS.net.how },
  { id: "ggr", term: FINANCE_TERMS.ggr.label, short: FINANCE_TERMS.ggr.how },
  { id: "taxa-de-ggr", term: FINANCE_TERMS.ggrFee.label, short: FINANCE_TERMS.ggrFee.how },
  {
    id: "taxa-de-movimentacao",
    term: FINANCE_TERMS.movementFee.label,
    short: FINANCE_TERMS.movementFee.how,
  },
  { id: "envios", term: FINANCE_TERMS.sends.label, short: FINANCE_TERMS.sends.how },
  { id: "mensalidade", term: FINANCE_TERMS.fee.label, short: FINANCE_TERMS.fee.how },
  { id: "outros-custos", term: FINANCE_TERMS.otherCosts.label, short: FINANCE_TERMS.otherCosts.how },
  { id: "roi", term: FINANCE_TERMS.roi.label, short: FINANCE_TERMS.roi.how },
  { id: "margem", term: FINANCE_TERMS.margin.label, short: FINANCE_TERMS.margin.how },

  // --- "Como ler" de Resultados (src/components/crm-results/central-results.tsx) ---
  {
    id: "recuperado-pelo-crm",
    term: "Recuperado pelo CRM",
    short:
      "Jogador que clicou no link do SMS e depositou em até 7 dias, e o valor depositado. É a medida principal, a mesma do Início (conversão por clique). Conta jogadores, não depósitos: quem deposita 3 vezes conta 1.",
  },
  { id: "taxa-de-clique", term: "Taxa de clique", short: "SMS clicados ÷ SMS enviados." },
  {
    id: "custo-por-jogador-convertido",
    term: "Custo por jogador convertido",
    short: "Custo em SMS ÷ jogadores convertidos pelo clique.",
  },
  {
    id: "retorno-do-envio",
    term: "Retorno",
    short:
      "Recuperado pelo CRM ÷ custo em SMS. Verde quando paga o envio (1x ou mais), vermelho quando não paga. Com menos de 5 jogadores convertidos aparece como “amostra pequena” e não entra em comparações.",
  },
  {
    id: "recuperados-visao-ampla",
    term: "Recuperados (visão ampla)",
    short:
      "Jogador parado há 2+ dias (ou sem 1º depósito) que depositou até 3 dias depois de um SMS, com ou sem clique. Conta retornos, não pessoas, e o valor é só o depósito de retorno. Inclui boa parte do Recuperado pelo CRM: não some os dois.",
  },
  {
    id: "ultimos-7-dias",
    term: "Últimos 7 dias",
    short:
      "Conversões chegam até 7 dias depois do clique. O custo entra no dia do envio, o clique no dia do clique e a conversão no dia do depósito; por isso os últimos 7 dias ainda crescem.",
  },
  {
    id: "teste-de-controle",
    term: "Teste de controle",
    short:
      "Voltar depois do SMS não prova que foi por causa dele. O teste compara com um grupo sorteado que não recebe mensagens e mostra o efeito real.",
  },
  {
    id: "custo-do-envio",
    term: "Custo",
    short: "Só SMS. WhatsApp, e-mail e voz ainda não têm preço cadastrado.",
  },

  // --- New terms (fase 1) ---
  {
    id: "dns",
    term: "DNS",
    short:
      "A agenda que traduz um nome (como mail.suacasa.bet.br) para o endereço real de um servidor. É nela que você cadastra o domínio para liberar o encurtador ou o e-mail.",
  },
  {
    id: "subdominio",
    term: "Subdomínio",
    short:
      "Um nome extra na frente do seu domínio, como mail em mail.suacasa.bet.br. Cada parte usada (encurtador, e-mail) costuma pedir o seu próprio.",
  },
  {
    id: "registro-dns",
    term: "Registro DNS",
    short:
      "Uma linha que você cadastra no painel do seu domínio (Registro.br, Cloudflare, GoDaddy, Hostinger...) para provar que o domínio é seu e apontar para onde ele deve funcionar. Depois de colado, a verificação é automática.",
  },
  {
    id: "remetente",
    term: "Remetente",
    short:
      "O endereço que aparece como quem enviou o e-mail, por exemplo contato@suacasa.bet.br. Só pode ser criado depois que o domínio de e-mail estiver verificado.",
  },
  {
    id: "encurtador",
    term: "Encurtador",
    short:
      "O serviço que transforma um link longo num link curto com o seu domínio, para caber na mensagem e para você acompanhar quem clicou.",
  },
  {
    id: "ftd",
    term: "FTD",
    short: "Sigla de \"first time deposit\": o primeiro depósito que um jogador faz na casa.",
  },
  {
    id: "grupo-de-controle",
    term: "Grupo de controle",
    short:
      "Uma parte dos jogadores sorteada para não receber a mensagem. Serve para comparar e mostrar o efeito real do envio, não só uma coincidência.",
  },
  {
    id: "reentrada",
    term: "Reentrada",
    short:
      "Se um jogador que já passou pela jornada pode entrar nela de novo, e depois de quanto tempo.",
  },
  {
    id: "gatilho",
    term: "Gatilho",
    short: "O evento que faz um jogador entrar numa jornada, por exemplo \"ficou 3 dias sem depositar\".",
  },
  {
    id: "segmento-sms",
    term: "Segmento de SMS",
    short:
      "Cada bloco de até 160 caracteres de uma mensagem. Uma mensagem maior é cobrada em mais de um segmento.",
  },

  // --- Email (Task 11) ---
  {
    id: "cta",
    term: "CTA",
    short:
      "Sigla de \"call to action\" (chamada para ação): o botão principal do e-mail, como \"Acessar agora\", que leva o jogador para o link combinado.",
  },
  {
    id: "preheader",
    term: "Preheader",
    short:
      "O trecho de texto que aparece ao lado ou abaixo do assunto na caixa de entrada, antes de abrir o e-mail. Serve para completar o assunto e aumentar a chance de abertura.",
  },
  {
    id: "hero",
    term: "Hero",
    short:
      "A imagem grande de destaque logo abaixo da logo, no topo do corpo do e-mail — também chamada de \"banner principal\".",
  },
  {
    id: "alt-text",
    term: "Alt text",
    short:
      "O texto alternativo de uma imagem: o que aparece no lugar dela quando a imagem não carrega, e o que leitores de tela leem em voz alta.",
  },
];
