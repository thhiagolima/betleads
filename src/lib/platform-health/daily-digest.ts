// Pure builder for the super-admin "Saúde" daily digest e-mail (F3, Task 4).
//
// One e-mail a day (08:00 BRT) summarizing: open platform alerts (critical
// first, silenced ones listed apart), houses in red/yellow, and who owes
// money. No DB access, no server-only import — `daily-digest.server.ts`
// gathers the data and calls this.

import { isSilenced, type StoredAlert } from "./alert-lifecycle";
import type { HouseHealthRow } from "./house-health";
import type { Debtor } from "@/lib/billing/billing-state-summary";

/** What the digest needs of an open alert (a `StoredAlert` fits, so does a computed alert). */
export type DigestAlert = Pick<StoredAlert, "severity" | "message" | "silencedUntil">;

export type DigestInput = {
  /** Brasília calendar day the digest is for, YYYY-MM-DD. */
  day: string;
  /** When the digest runs: decides whether a silence is still in force. */
  now: Date;
  openAlerts: DigestAlert[];
  houses: HouseHealthRow[];
  debtors: Debtor[];
  owedCents: number;
};

const ADMIN_HEALTH_URL = "https://betleads.io/admin#saude";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "DD/MM" from a YYYY-MM-DD string. */
function ddmm(day: string): string {
  const [, month, dayOfMonth] = day.split("-");
  return `${dayOfMonth}/${month}`;
}

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const SEVERITY_RANK: Record<StoredAlert["severity"], number> = { critical: 0, warning: 1 };

const EMPTY_TEXT = "Nada aqui hoje.";

function section(title: string, itemsHtml: string[]): string {
  const body =
    itemsHtml.length > 0
      ? `<ul style="font-size:14px; line-height:1.5; margin:0 0 20px; padding-left:20px;">
${itemsHtml.join("\n")}
      </ul>`
      : `<p style="font-size:14px; color:#6b7280; margin:0 0 20px;">${EMPTY_TEXT}</p>`;
  return `<h2 style="font-size:16px; margin:0 0 8px;">${escapeHtml(title)}</h2>
      ${body}`;
}

function alertItem(a: DigestAlert): string {
  return `        <li style="margin:0 0 8px;"><strong>${escapeHtml(a.message)}</strong></li>`;
}

function houseItem(h: HouseHealthRow): string {
  const reason = h.reason ? ` — ${escapeHtml(h.reason)}` : "";
  return `        <li style="margin:0 0 8px;"><strong>${escapeHtml(h.name)}</strong>${reason}</li>`;
}

function debtorItem(d: Debtor): string {
  const overdue = d.daysOverdue !== null ? ` · ${d.daysOverdue} dias` : "";
  return `        <li style="margin:0 0 8px;"><strong>${escapeHtml(d.name)}</strong> — ${escapeHtml(brl(d.amountCents))}${overdue}</li>`;
}

/** Subject + inline HTML for the daily digest, in the same card style as the critical alert e-mail. */
export function buildDailyDigest(input: DigestInput): { subject: string; html: string } {
  const { day, now, openAlerts, houses, debtors, owedCents } = input;

  const redHouses = houses.filter((h) => h.level === "red");
  const yellowHouses = houses.filter((h) => h.level === "yellow");

  const subject = `BetLeads — resumo de ${ddmm(day)}: ${openAlerts.length} alertas, ${redHouses.length} casas em vermelho`;

  const active = openAlerts.filter((a) => !isSilenced(a, now));
  const silenced = openAlerts.filter((a) => isSilenced(a, now));
  const sortedActive = [...active].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );

  const alertsSection = section("Alertas abertos", sortedActive.map(alertItem));
  const silencedSection = section("Silenciados", silenced.map(alertItem));
  const housesSection = section(
    "Casas em vermelho/amarelo",
    [...redHouses, ...yellowHouses].map(houseItem),
  );
  const debtorsIntro =
    debtors.length > 0
      ? `<p style="font-size:13px; color:#6b7280; margin:0 0 8px;">Total devido: ${escapeHtml(brl(owedCents))}</p>`
      : "";
  const debtorsSection = `${debtorsIntro}${section("Quem está devendo", debtors.map(debtorItem))}`;

  const html = `<!doctype html>
<html>
  <body style="margin:0; padding:24px; background:#f5f5f5; font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:8px; padding:24px; color:#1f2937;">
      <p style="font-size:16px; line-height:1.5; margin:0 0 16px;">Resumo diário da plataforma — ${ddmm(day)}.</p>
      ${alertsSection}
      ${silencedSection}
      ${housesSection}
      ${debtorsSection}
      <p style="text-align:center; margin:20px 0 0;">
        <a href="${ADMIN_HEALTH_URL}" style="background:#2563eb; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">Abrir a aba Saúde</a>
      </p>
    </div>
  </body>
</html>`;

  return { subject, html };
}
