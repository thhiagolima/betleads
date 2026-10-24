// Ficha do lead na Área do Expert (Fase 2, Task 7): cabeçalho (nome,
// telefone, origem, nível e situação), cartões de números e "Benefícios já
// recebidos". Os dados vêm de `getExpertLeadSheet`.
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HomeCard, KpiCard } from "@/components/home/home-cards";
import { PageHeader } from "@/components/ui-premium/page-header";
import { LevelBadge } from "@/components/players/level-badge";
import { SituationText } from "@/components/players/situation-text";
import type { ExpertLeadSheet } from "@/lib/expert-lead-sheet";
import { brl, num } from "@/lib/format";

import { formatBrtDate, formatBrtDdMm } from "./sheet-format";

export function LeadSheetHeader({ sheet }: { sheet: ExpertLeadSheet }) {
  const { lead, claim, podeAssumir } = sheet;
  // Quem não pode assumir não vê o cartão "Assumir lead"; o aviso de que
  // outro expert está atendendo aparece aqui no cabeçalho.
  const claimNotice =
    !podeAssumir && claim && !claim.minha
      ? `Em atendimento por ${claim.expertNome} até ${formatBrtDdMm(claim.expiresAt)}`
      : null;

  return (
    <PageHeader
      title={lead.nome}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="tabular-nums">{lead.telefone ?? "Sem telefone"}</span>
          {lead.origemAfiliadoDoExpert && <Badge variant="secondary">Afiliado seu</Badge>}
          <LevelBadge level={lead.nivel} />
          <span aria-hidden="true">·</span>
          <SituationText situation={lead.situacao} />
          {claimNotice && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-warning">{claimNotice}</span>
            </>
          )}
        </span>
      }
      actions={
        <Button asChild variant="outline" className="h-11 gap-2 px-4 sm:h-9">
          <Link to="/expert/leads">
            <ArrowLeft className="h-4 w-4" />
            Voltar para leads
          </Link>
        </Button>
      }
    />
  );
}

function semDepositarLabel(lead: ExpertLeadSheet["lead"]): string {
  if (lead.situacao === "no_deposit" || lead.diasSemDepositar == null) return "Nunca depositou";
  if (lead.diasSemDepositar === 0) return "Depositou hoje";
  return `${num(lead.diasSemDepositar)} ${lead.diasSemDepositar === 1 ? "dia" : "dias"}`;
}

export function LeadSheetStats({ lead }: { lead: ExpertLeadSheet["lead"] }) {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
      <KpiCard title="Sem depositar" value={semDepositarLabel(lead)} />
      <KpiCard title="Total depositado" value={brl(lead.totalDepositado)} />
      <KpiCard title="Depósitos" value={num(lead.depositos)} />
      <KpiCard
        title="Ticket médio"
        value={lead.ticketMedio == null ? "—" : brl(lead.ticketMedio)}
      />
      <KpiCard
        title="Último depósito"
        value={lead.ultimoDeposito ? brl(lead.ultimoDeposito.valor) : "—"}
        detail={lead.ultimoDeposito ? formatBrtDate(lead.ultimoDeposito.at) : undefined}
      />
      <KpiCard title="Saques" value={brl(lead.totalSacado)} />
    </div>
  );
}

export function LeadBenefits({ beneficios }: { beneficios: ExpertLeadSheet["beneficios"] }) {
  // O saldo de bônus atual não é um benefício recebido: aparece à parte.
  const recebidos = beneficios.filter((b) => b.tipo === "cashback");
  const bonusAtual = beneficios.find((b) => b.tipo === "bonus_atual");
  return (
    <HomeCard className="p-4 sm:p-5">
      <h2 className="text-section">Benefícios já recebidos</h2>
      {recebidos.length === 0 ? (
        <p className="mt-2 text-body text-muted-foreground">Nenhum benefício recebido ainda.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border/70">
          {recebidos.map((b, index) => (
            <li
              key={`${b.tipo}:${b.at ?? "sem-data"}:${index}`}
              className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]"
            >
              <span className="text-muted-foreground">
                Cashback
                {b.at && <span> · {formatBrtDate(b.at)}</span>}
              </span>
              <strong className="font-semibold tabular-nums">{brl(b.valor)}</strong>
            </li>
          ))}
        </ul>
      )}
      {bonusAtual && (
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/70 pt-2.5 text-[13.5px]">
          <span className="text-muted-foreground">Saldo de bônus atual</span>
          <strong className="font-semibold tabular-nums">{brl(bonusAtual.valor)}</strong>
        </div>
      )}
    </HomeCard>
  );
}
