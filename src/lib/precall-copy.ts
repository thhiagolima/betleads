// Gerador de copy de pré-ligação para WhatsApp.
// Objetivo único: pedir permissão para ligar 2 min. Tom curto, natural,
// sem pressionar depósito. Cada clique sorteia uma variação diferente da
// última (guardada em módulo) para reduzir padrão de bloqueio de WhatsApp.

// Variações com remetente, motivo, estrutura e fechamento diferentes em cada
// template, para não criar padrão detectável pelo WhatsApp. Regras fixas:
// - sempre "te ligar" / "te ligo" (nunca "te chamar")
// - remetente varia (gerente VIP, equipe de presentes, central de bônus, etc.)
// - sem mencionar depósito/saque/bônus específicos — só pedir 2 min de ligação
const TEMPLATES: string[] = [
  "Oi, {nome}, tudo bem? Aqui é da equipe de relacionamento da {brand}. Tinha um assunto importante sobre sua conta pra alinhar com você. Posso te ligar 2 min?",
  "Fala, {nome}! Aqui é o gerente VIP da {brand}. Apareceu um ponto sobre seu cadastro que prefiro te explicar por ligação. Te ligo agora?",
  "{nome}, aqui é da equipe de presentes da {brand}. Tem uma informação sobre sua conta que vale a pena te passar pessoalmente. Posso te ligar rapidinho?",
  "Oi, {nome}. Aqui é da central de bônus da {brand}. Surgiu um detalhe na sua conta que preciso te explicar em 2 min. Posso te ligar agora?",
  "Tudo bem, {nome}? Aqui é do time de contas VIP da {brand}. Tenho um assunto rápido sobre seu cadastro pra falar com você. Tem 2 min pra eu te ligar?",
  "{nome}, apareceu um ponto importante na sua conta aqui na {brand}. Sou do atendimento exclusivo. Posso te ligar 2 min pra te explicar?",
  "Oi, {nome}! Aqui é da equipe de fidelidade da {brand}. Precisava alinhar uma coisa sobre sua conta com você. Te ligo rapidinho, pode ser?",
  "Fala, {nome}, tudo certo? Aqui é o consultor de contas da {brand}. Tem um ajuste no seu perfil que prefiro te explicar por ligação. Posso te ligar agora?",
  "{nome}, aqui é do time de retenção da {brand}. Surgiu uma informação sobre sua conta que precisa de 2 min seus por ligação. Te ligo agora?",
  "Oi, {nome}. Sou da equipe VIP da {brand}. Tinha um detalhe na sua conta pra te passar — prefiro ligar pra te explicar direito. Posso te ligar 2 min?",
  "Tudo bem, {nome}? Aqui é da equipe de presentes da {brand}. Tem um ponto rápido sobre sua conta que quero te falar pessoalmente. Te ligo rapidinho?",
  "{nome}, da central VIP da {brand} aqui. Apareceu um assunto importante sobre seu cadastro. Posso te ligar agora pra te explicar em 2 min?",
  "Oi, {nome}! Sou o gerente de contas VIP da {brand}. Precisava falar com você sobre um detalhe da sua conta, é rapidinho. Tem 2 min pra eu te ligar?",
  "Fala, {nome}. Aqui é do atendimento exclusivo da {brand}. Tem uma informação sobre sua conta que prefiro te passar por ligação. Te ligo agora?",
  "{nome}, tudo bem? Aqui é da equipe de relacionamento VIP da {brand}. Surgiu um ponto sobre seu cadastro pra alinhar com você. Posso te ligar 2 min?",
  "Oi, {nome}. Da central de bônus da {brand}. Tenho um assunto rápido sobre sua conta pra falar com você pessoalmente. Te ligo rapidinho?",
  "Tudo bem, {nome}? Sou da equipe de fidelidade da {brand}. Apareceu uma informação importante na sua conta. Posso te ligar agora 2 min?",
  "{nome}, aqui é o consultor VIP da {brand}. Tinha um detalhe sobre seu cadastro pra te explicar — é melhor por ligação. Te ligo rapidinho?",
  "Oi, {nome}! Aqui é do time de presentes da {brand}. Precisava te passar uma informação sobre sua conta. Posso te ligar 2 min agora?",
  "Fala, {nome}, beleza? Sou da equipe de contas VIP da {brand}. Surgiu um assunto na sua conta que prefiro alinhar por ligação. Te ligo agora?",
];

let lastIndex = -1;

function pickIndex(): number {
  if (TEMPLATES.length <= 1) return 0;
  let i = Math.floor(Math.random() * TEMPLATES.length);
  if (i === lastIndex) i = (i + 1) % TEMPLATES.length;
  lastIndex = i;
  return i;
}

function firstNameOf(full: string): string {
  const p = (full ?? "").trim().split(/\s+/)[0] ?? "";
  if (!p) return "";
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

export function nextPrecallCopy(opts: { fullName: string; brand: string }): string {
  const nome = firstNameOf(opts.fullName) || "tudo bem";
  const brand = (opts.brand || "").trim() || "nossa plataforma";
  const tpl = TEMPLATES[pickIndex()];
  return tpl.replace(/\{nome\}/g, nome).replace(/\{brand\}/g, brand);
}