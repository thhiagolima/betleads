import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { BookOpen, Download } from "lucide-react";

import { getCrmResults } from "@/lib/crm-results.functions";
import { getComparisonAccess } from "@/lib/tenant-comparison.functions";
import { crmResultsCsv } from "@/lib/crm-results-csv";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { HealthIndicator } from "./health";
import { Holdout } from "./holdout";
import { Origins } from "./origins";
import { type Data, periodLabel } from "./format";
import { Overview } from "./overview";
import { SpendByState } from "./retention";
import { CentralPeriodPicker, EmptyCard } from "./shared";
import { PERIODS, TABS, type CentralSearch, type PeriodKey, type TabKey } from "./search";

export function CentralResults() {
  const search = useSearch({ from: "/resultados" });
  const navigate = useNavigate({ from: "/resultados" });
  const period = PERIODS.find((item) => item.key === search.periodo) ?? PERIODS[3];
  // Retired tabs ("recomendacoes", "base") fall back to the overview.
  const tab: TabKey = TABS.some((item) => item.key === search.aba)
    ? (search.aba as TabKey)
    : "visao";
  const setSearch = (next: Partial<CentralSearch>, replace = false) =>
    void navigate({ search: (current) => ({ ...current, ...next }), replace });

  const load = useServerFn(getCrmResults);
  const query = useQuery({
    queryKey: ["crm-results", period.key],
    queryFn: () => load({ data: { days: period.days, endOffset: period.endOffset } }),
    staleTime: 60_000,
  });
  const loadAccess = useServerFn(getComparisonAccess);
  const access = useQuery({
    queryKey: ["tenant-comparison-access"],
    queryFn: () => loadAccess(),
    staleTime: 5 * 60_000,
  });

  return (
    <Page>
      <div className="space-y-3">
        <PageHeader
          subtitle={
            <>
              Quanto cada jornada e campanha converte e quanto custa cada conversão.
              {query.data &&
                ` ${periodLabel(query.data.from, query.data.to)} · horário de Brasília`}
            </>
          }
          actions={
            <>
              {query.data && <HealthIndicator data={query.data} />}
              <Glossary />
              {access.data?.allowed && (
                <Button size="sm" variant="ghost" asChild>
                  <Link to="/resultados/comparar">Comparar casas</Link>
                </Button>
              )}
              {query.data && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  onClick={() => downloadCsv(query.data, period.key)}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  CSV
                </Button>
              )}
            </>
          }
        />
        <CentralPeriodPicker value={period.key} onChange={(key) => setSearch({ periodo: key })} />
      </div>

      {query.isLoading ? (
        <LoadingSkeleton />
      ) : query.isError || !query.data ? (
        <EmptyCard>
          Não foi possível carregar os resultados. Tente novamente em instantes.
        </EmptyCard>
      ) : (
        <div className="space-y-4">
          <PageTabs
            value={tab}
            onValueChange={(value) => setSearch({ aba: value })}
            label="Seções dos resultados"
            items={TABS.map((item) => ({ value: item.key, label: item.label }))}
          />
          <div role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === "visao" && (
              <Overview
                data={query.data}
                onOpenOrigin={(name) => setSearch({ aba: "origens", busca: name })}
              />
            )}
            {tab === "origens" && (
              <div className="space-y-4">
                <Origins
                  data={query.data}
                  search={search.busca ?? ""}
                  onSearch={(value) => setSearch({ busca: value || undefined }, true)}
                />
                <SpendByState data={query.data} />
              </div>
            )}
            {tab === "controle" && <Holdout data={query.data} />}
          </div>
        </div>
      )}
    </Page>
  );
}

function downloadCsv(data: Data, periodKey: PeriodKey) {
  const url = URL.createObjectURL(
    new Blob([crmResultsCsv(data, data)], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  const name = /^\d+$/.test(periodKey) ? `${periodKey}-dias` : periodKey;
  anchor.download = `resultados-crm-${name}-${data.from}-a-${data.to}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Same shape as the overview, so the page does not jump when it loads (C-11). */
function LoadingSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Carregando resultados">
      <Skeleton className="h-10 w-full max-w-xl rounded-lg" />
      <Skeleton className="h-28 rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-20 rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </div>
  );
}

/** One glossary for the whole Central instead of notes repeated on each tab (C-12). */
function Glossary() {
  const terms: Array<[string, string]> = [
    [
      "Recuperado pelo CRM",
      "Jogador que clicou no link do SMS e depositou em até 7 dias, e o valor depositado. É a medida principal, a mesma do Início (conversão por clique). Conta jogadores, não depósitos: quem deposita 3 vezes conta 1.",
    ],
    ["Taxa de clique", "SMS clicados ÷ SMS enviados."],
    ["Custo por jogador convertido", "Custo em SMS ÷ jogadores convertidos pelo clique."],
    [
      "Retorno",
      "Recuperado pelo CRM ÷ custo em SMS. Verde quando paga o envio (1x ou mais), vermelho quando não paga. Com menos de 5 jogadores convertidos aparece como “amostra pequena” e não entra em comparações.",
    ],
    [
      "Recuperados (visão ampla)",
      "Jogador parado há 2+ dias (ou sem 1º depósito) que depositou até 3 dias depois de um SMS, com ou sem clique. Conta retornos, não pessoas, e o valor é só o depósito de retorno. Inclui boa parte do Recuperado pelo CRM: não some os dois.",
    ],
    [
      "Últimos 7 dias",
      "Conversões chegam até 7 dias depois do clique. O custo entra no dia do envio, o clique no dia do clique e a conversão no dia do depósito; por isso os últimos 7 dias ainda crescem.",
    ],
    [
      "Teste de controle",
      "Voltar depois do SMS não prova que foi por causa dele. O teste compara com um grupo sorteado que não recebe mensagens e mostra o efeito real.",
    ],
    ["Custo", "Só SMS. WhatsApp, e-mail e voz ainda não têm preço cadastrado."],
  ];
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="ghost" className="gap-2">
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          Como ler
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Como ler os números</SheetTitle>
          <SheetDescription>O que cada métrica da Central significa.</SheetDescription>
        </SheetHeader>
        <dl className="mt-4 space-y-4 text-sm">
          {terms.map(([term, definition]) => (
            <div key={term}>
              <dt className="font-medium">{term}</dt>
              <dd className="mt-0.5 text-muted-foreground">{definition}</dd>
            </div>
          ))}
        </dl>
      </SheetContent>
    </Sheet>
  );
}
