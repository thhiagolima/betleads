import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { BookOpen, Download } from "lucide-react";

import { useTenantCurrency } from "@/hooks/use-tenant-currency";
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
import { Reactivations } from "./reactivations";
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

  const currency = useTenantCurrency();
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
                  onClick={() => downloadCsv(query.data, period.key, currency)}
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
                onOpenProof={() => setSearch({ aba: "controle" })}
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
            {tab === "controle" && (
              <div className="space-y-4">
                <Reactivations data={query.data} />
                <Holdout data={query.data} />
              </div>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

function downloadCsv(data: Data, periodKey: PeriodKey, currency: string) {
  const url = URL.createObjectURL(
    new Blob([crmResultsCsv(data, data, currency)], { type: "text/csv;charset=utf-8" }),
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
      <Skeleton className="h-12 w-full max-w-md rounded-lg" />
      <Skeleton className="h-56 rounded-xl" />
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
      "Jogador parado há 2 dias ou mais (ou sem 1º depósito) que clicou no link do SMS e depositou em até 7 dias, e tudo o que ele depositou nesses 7 dias. É a medida principal, a mesma do Início. Conta jogadores, não depósitos: quem deposita 3 vezes conta 1.",
    ],
    [
      "Já estavam jogando",
      "Clicaram, mas tinham depositado nos 2 dias anteriores. Iam depositar de qualquer forma, então não entram no Recuperado pelo CRM nem no retorno.",
    ],
    [
      "Cliques no link",
      "Cliques de pessoas no link do SMS (robôs ficam fora). Taxa: cliques ÷ SMS enviados.",
    ],
    [
      "Cliques que viraram depósito",
      "Dos cliques do período, quantos levaram a um depósito em até 7 dias. Por isso pode ser diferente do número de jogadores que voltaram no período, que conta pelo dia do depósito.",
    ],
    ["Custo por jogador que voltou", "Custo em SMS ÷ jogadores que voltaram pelo link."],
    [
      "Cada R$ 1 em SMS trouxe",
      "Recuperado pelo CRM ÷ custo em SMS. Verde quando paga o envio (R$ 1 ou mais), vermelho quando não paga. Com menos de 5 jogadores aparece como “amostra pequena”. Em Hoje e Ontem usa os últimos 7 dias, porque o depósito de hoje pode vir de um SMS de dias atrás.",
    ],
    [
      "Comparação",
      "Hoje e Ontem comparam com o mesmo dia da semana anterior; os outros períodos, com o período anterior de mesmo tamanho. Com menos de 20 jogadores ou 1.000 SMS mostra a diferença em valor, não em %, porque a porcentagem seria ruído.",
    ],
    [
      "Parcial",
      "Quem clicou tem até 7 dias para depositar. O custo entra no dia do envio, o clique no dia do clique e o jogador no dia do depósito; por isso os últimos 7 dias ainda crescem.",
    ],
    [
      "Reativações após SMS",
      "Fica em Prova e método. Jogadores que estavam há 2 dias ou mais sem depositar (ou que nunca depositaram), receberam um SMS e voltaram a depositar em até 3 dias, mesmo sem clicar no link. O valor é tudo o que depositaram nesses 3 dias. Já inclui o Recuperado pelo CRM (quem clicou), por isso é sempre igual ou maior: não some os dois.",
    ],
    [
      "Teste de controle",
      "Em Prova e método. Voltar depois do SMS não prova que foi por causa dele. O teste compara com um grupo sorteado que não recebe mensagens e mostra o efeito real.",
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
