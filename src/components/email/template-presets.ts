// Catálogo de objetivos, modelos visuais e templates prontos
// usado pelo Editor Assistido de Templates de Email.

export type EmailObjective =
  | "recuperacao"
  | "cashback"
  | "bonus"
  | "vip"
  | "primeiro_deposito"
  | "dinheiro_parado"
  | "aviso_geral";

export const OBJETIVOS: { id: EmailObjective; label: string; descricao: string }[] = [
  { id: "recuperacao", label: "Recuperação", descricao: "Trazer de volta quem parou" },
  { id: "cashback", label: "Cashback", descricao: "Devolução de perdas" },
  { id: "bonus", label: "Bônus", descricao: "Oferta de bônus / depósito" },
  { id: "vip", label: "VIP", descricao: "Comunicação para VIPs" },
  { id: "primeiro_deposito", label: "Primeiro depósito", descricao: "Ativar FTD" },
  { id: "dinheiro_parado", label: "Dinheiro parado", descricao: "Saldo sem uso" },
  { id: "aviso_geral", label: "Aviso geral", descricao: "Comunicado / novidade" },
];

export type ModeloId = "simples" | "promocional" | "vip" | "urgencia" | "cashback" | "cupom";

export type FieldsState = {
  titulo: string;
  texto: string;
  cupom: string;
  beneficio: string;
  cta: string;
  link: string;
  logo_url?: string;
  hero_image_url?: string;
  hero_alt?: string;
  secondary_image_url?: string;
  secondary_alt?: string;
  mostrar_banner_secundario?: boolean;
  benefit_icon_url?: string;
  mostrar_icone_beneficio?: boolean;
};

export const MODELOS: {
  id: ModeloId;
  label: string;
  descricao: string;
  cor: string; // hex primário do CTA
}[] = [
  { id: "simples", label: "Simples", descricao: "Cabeçalho + texto + botão", cor: "#3b82f6" },
  { id: "promocional", label: "Promocional", descricao: "Banner forte + benefício", cor: "#f59e0b" },
  { id: "vip", label: "VIP", descricao: "Tom premium, dourado", cor: "#c9a84c" },
  { id: "urgencia", label: "Urgência", descricao: "Última chance, contagem", cor: "#ef4444" },
  { id: "cashback", label: "Cashback", descricao: "Foco em devolução", cor: "#10b981" },
  { id: "cupom", label: "Cupom", descricao: "Cupom em destaque", cor: "#8b5cf6" },
];

/**
 * Renderiza um HTML responsivo (tabela inline) com base em modelo + campos.
 * Inline styles porque clientes de email (Gmail/Outlook) limitam CSS.
 */
export function renderModeloHtml(modelo: ModeloId, f: FieldsState): string {
  const m = MODELOS.find((x) => x.id === modelo) ?? MODELOS[0];
  const cor = m.cor;

  const titulo = (f.titulo || "").trim();
  const texto = (f.texto || "").trim().replace(/\n/g, "<br/>");
  const cupom = (f.cupom || "").trim();
  const beneficio = (f.beneficio || "").trim();
  const cta = (f.cta || "Acessar agora").trim();
  const link = (f.link || "{link_login}").trim();
  const logoUrl = (f.logo_url || "").trim();
  const heroUrl = (f.hero_image_url || "").trim();
  const heroAlt = (f.hero_alt || "Banner").trim();
  const secUrl = (f.secondary_image_url || "").trim();
  const secAlt = (f.secondary_alt || "Banner secundário").trim();
  const showSec = f.mostrar_banner_secundario !== false && Boolean(secUrl);
  const iconUrl = (f.benefit_icon_url || "").trim();
  const showIcon = f.mostrar_icone_beneficio !== false && Boolean(iconUrl);

  const logoBlock = logoUrl
    ? `<tr><td align="center" style="padding:20px 24px 8px;background:#ffffff">
        <img src="${escapeAttr(logoUrl)}" alt="Logo" width="220" style="display:block;margin:0 auto;max-width:220px;width:100%;height:auto;border:0" />
      </td></tr>`
    : "";

  const heroBlock = heroUrl
    ? `<tr><td style="padding:0;background:#ffffff">
        <img src="${escapeAttr(heroUrl)}" alt="${escapeAttr(heroAlt)}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0" />
      </td></tr>`
    : "";

  const secondaryBlock = showSec
    ? `<tr><td style="padding:8px 0 0;background:#ffffff">
        <img src="${escapeAttr(secUrl)}" alt="${escapeAttr(secAlt)}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0" />
      </td></tr>`
    : "";

  const iconHtml = showIcon
    ? `<img src="${escapeAttr(iconUrl)}" alt="" width="24" style="display:inline-block;vertical-align:middle;width:24px;height:auto;border:0;margin-right:6px" />`
    : "";

  const cupomBlock = cupom
    ? `<tr><td align="center" style="padding:8px 24px 16px">
        <div style="display:inline-block;border:2px dashed ${cor};border-radius:10px;padding:10px 18px;font:700 18px/1.2 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:2px;color:${cor};background:#fff8e1">
          ${escapeHtml(cupom)}
        </div>
      </td></tr>`
    : "";

  const beneficioBlock = beneficio
    ? `<tr><td style="padding:0 24px 16px;font:600 16px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;text-align:center">
        ${iconHtml}${escapeHtml(beneficio)}
      </td></tr>`
    : "";

  // Headers por modelo
  const header = (() => {
    switch (modelo) {
      case "vip":
        return `<tr><td style="background:linear-gradient(135deg,#1a1410,#3d2914);padding:24px;text-align:center;color:${cor};font:700 14px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:3px">★ ÁREA VIP ★</td></tr>`;
      case "urgencia":
        return `<tr><td style="background:${cor};padding:14px;text-align:center;color:#fff;font:700 13px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:2px">⚠ ÚLTIMA CHANCE</td></tr>`;
      case "cashback":
        return `<tr><td style="background:${cor};padding:14px;text-align:center;color:#fff;font:700 14px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:2px">💸 CASHBACK LIBERADO</td></tr>`;
      case "promocional":
        return `<tr><td style="background:${cor};padding:18px;text-align:center;color:#fff;font:800 18px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif">🎁 OFERTA ESPECIAL</td></tr>`;
      case "cupom":
        return `<tr><td style="background:${cor};padding:14px;text-align:center;color:#fff;font:700 14px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:2px">🎟 CUPOM ATIVO</td></tr>`;
      default:
        return `<tr><td style="background:#0f172a;padding:14px;text-align:center;color:#fff;font:700 13px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;letter-spacing:2px">BETLEADS</td></tr>`;
    }
  })();

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.06)">
      ${header}
      ${logoBlock}
      ${heroBlock}
      <tr><td style="padding:28px 24px 8px;font:700 22px/1.25 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;text-align:center">
        ${escapeHtml(titulo) || "Olá, {primeiro_nome}!"}
      </td></tr>
      <tr><td style="padding:8px 24px 16px;font:400 15px/1.55 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#334155;text-align:center">
        ${texto || "Conteúdo do email..."}
      </td></tr>
      ${beneficioBlock}
      ${cupomBlock}
      <tr><td align="center" style="padding:8px 24px 28px">
        <a href="${escapeAttr(link)}" style="display:inline-block;background:${cor};color:#ffffff;text-decoration:none;font:700 15px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:14px 28px;border-radius:10px">
          ${escapeHtml(cta)}
        </a>
      </td></tr>
      ${secondaryBlock}
      <tr><td style="background:#f8fafc;padding:18px 24px;text-align:center;font:400 11px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#94a3b8">
        Você recebe este email porque é cadastrado na BETLEADS.<br/>
        <a href="{link_descadastro}" style="color:#94a3b8;text-decoration:underline">Descadastrar</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s: string) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

// ============ 10 Templates prontos ============

export type PresetTemplate = {
  id: string;
  nome: string;
  objetivo: EmailObjective;
  modelo: ModeloId;
  assunto: string;
  preheader: string;
  fromName: string;
  campos: FieldsState;
  tags: string[];
};

export const TEMPLATES_PRONTOS: PresetTemplate[] = [
  {
    id: "recuperacao-vip",
    nome: "Recuperação VIP",
    objetivo: "recuperacao",
    modelo: "vip",
    assunto: "{primeiro_nome}, sua bancada VIP está esperando",
    preheader: "Voltamos com benefícios exclusivos para você",
    fromName: "BETLEADS VIP",
    tags: ["vip", "recuperacao"],
    campos: {
      titulo: "Sentimos sua falta, {primeiro_nome}",
      texto: "Notamos que faz um tempo que você não acessa. Preparamos uma condição exclusiva para o seu retorno como membro VIP.",
      cupom: "VIPVOLTA",
      beneficio: "Bônus de 100% no próximo depósito",
      cta: "Voltar para a área VIP",
      link: "{link_login}",
    },
  },
  {
    id: "cashback-ativo",
    nome: "Cashback ativo",
    objetivo: "cashback",
    modelo: "cashback",
    assunto: "Seu cashback de R$ {valor_cashback} foi liberado",
    preheader: "Resgate agora antes que expire",
    fromName: "BETLEADS",
    tags: ["cashback"],
    campos: {
      titulo: "Cashback liberado, {primeiro_nome}!",
      texto: "Devolvemos parte da sua última jornada em forma de cashback. O valor já está disponível na sua conta.",
      cupom: "",
      beneficio: "Saldo extra para você jogar agora",
      cta: "Resgatar cashback",
      link: "{link_login}",
    },
  },
  {
    id: "cupom-liberado",
    nome: "Cupom liberado",
    objetivo: "bonus",
    modelo: "cupom",
    assunto: "🎟 Seu cupom exclusivo está pronto",
    preheader: "Use antes de meia-noite",
    fromName: "BETLEADS",
    tags: ["cupom", "bonus"],
    campos: {
      titulo: "Um cupom só seu, {primeiro_nome}",
      texto: "Liberamos um cupom exclusivo para a sua conta. Use no próximo depósito e aproveite o bônus.",
      cupom: "BONUS50",
      beneficio: "+50% no próximo depósito",
      cta: "Usar cupom",
      link: "{link_deposito}",
    },
  },
  {
    id: "dinheiro-parado",
    nome: "Dinheiro parado",
    objetivo: "dinheiro_parado",
    modelo: "promocional",
    assunto: "{primeiro_nome}, você tem R$ {saldo} esperando",
    preheader: "Seu saldo está parado — bora usar?",
    fromName: "BETLEADS",
    tags: ["saldo", "ativacao"],
    campos: {
      titulo: "Você tem saldo parado",
      texto: "Identificamos que seu saldo de R$ {saldo} está disponível e sem uso. Que tal voltar e fazer ele render?",
      cupom: "",
      beneficio: "Saldo disponível: R$ {saldo}",
      cta: "Usar meu saldo",
      link: "{link_login}",
    },
  },
  {
    id: "primeiro-deposito",
    nome: "Primeiro depósito",
    objetivo: "primeiro_deposito",
    modelo: "promocional",
    assunto: "Bônus de boas-vindas para você, {primeiro_nome}",
    preheader: "Dobramos seu primeiro depósito",
    fromName: "BETLEADS",
    tags: ["ftd", "boas-vindas"],
    campos: {
      titulo: "Bem-vindo, {primeiro_nome}!",
      texto: "Estamos felizes em ter você aqui. Faça seu primeiro depósito e ganhe um bônus especial para começar com tudo.",
      cupom: "PRIMEIRO100",
      beneficio: "+100% no seu primeiro depósito",
      cta: "Fazer meu primeiro depósito",
      link: "{link_deposito}",
    },
  },
  {
    id: "reativacao-7d",
    nome: "Reativação 7 dias",
    objetivo: "recuperacao",
    modelo: "simples",
    assunto: "{primeiro_nome}, faz uma semana que não te vemos",
    preheader: "Tem novidade esperando por você",
    fromName: "BETLEADS",
    tags: ["reativacao", "7d"],
    campos: {
      titulo: "Sentimos sua falta",
      texto: "Faz 7 dias que você não entra. Voltamos com mais opções e uma surpresa para você.",
      cupom: "VOLTA7",
      beneficio: "Bônus de retorno liberado",
      cta: "Voltar agora",
      link: "{link_login}",
    },
  },
  {
    id: "reativacao-30d",
    nome: "Reativação 30 dias",
    objetivo: "recuperacao",
    modelo: "promocional",
    assunto: "Há 30 dias sem você, {primeiro_nome}",
    preheader: "Liberamos um benefício especial",
    fromName: "BETLEADS",
    tags: ["reativacao", "30d"],
    campos: {
      titulo: "Estamos com saudade",
      texto: "Já se passou um mês desde sua última visita. Para te trazer de volta, preparamos um benefício exclusivo.",
      cupom: "VOLTA30",
      beneficio: "Bônus duplo + cashback",
      cta: "Voltar e resgatar",
      link: "{link_login}",
    },
  },
  {
    id: "vip-esfriando",
    nome: "VIP esfriando",
    objetivo: "vip",
    modelo: "vip",
    assunto: "{primeiro_nome}, seu status VIP precisa de atenção",
    preheader: "Mantenha seus benefícios exclusivos",
    fromName: "BETLEADS VIP",
    tags: ["vip", "retencao"],
    campos: {
      titulo: "Seu status VIP em risco",
      texto: "Notamos uma queda na sua atividade. Para manter todos os benefícios VIP ativos, continue jogando essa semana.",
      cupom: "",
      beneficio: "Mantenha cashback, suporte prioritário e bônus exclusivos",
      cta: "Acessar minha área VIP",
      link: "{link_login}",
    },
  },
  {
    id: "ultimo-aviso",
    nome: "Último aviso",
    objetivo: "recuperacao",
    modelo: "urgencia",
    assunto: "⚠ Última chance, {primeiro_nome}",
    preheader: "Sua oferta expira hoje",
    fromName: "BETLEADS",
    tags: ["urgencia", "ultimo"],
    campos: {
      titulo: "Sua oferta expira hoje",
      texto: "Esta é a última vez que enviaremos esta condição. Depois de hoje, o benefício será retirado da sua conta.",
      cupom: "ULTIMA",
      beneficio: "Bônus exclusivo válido só hoje",
      cta: "Resgatar antes que expire",
      link: "{link_login}",
    },
  },
  {
    id: "bonus-maximo",
    nome: "Bônus máximo",
    objetivo: "bonus",
    modelo: "promocional",
    assunto: "🎁 Bônus máximo liberado para você",
    preheader: "A maior oferta do mês",
    fromName: "BETLEADS",
    tags: ["bonus", "promo"],
    campos: {
      titulo: "Bônus máximo desbloqueado",
      texto: "Você foi selecionado para receber nossa maior oferta do mês. Aproveite com depósito qualificado.",
      cupom: "MAX200",
      beneficio: "+200% no próximo depósito",
      cta: "Ativar bônus máximo",
      link: "{link_deposito}",
    },
  },
];
