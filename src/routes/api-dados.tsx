// "API de dados" (docs/superpowers/specs/2026-11-20-api-leitura-design.md):
// the read-only API for internal spreadsheets, BI and scripts. A step-by-step
// for non-technical users (create a key, keep it, make the first query), each
// step ticked from real data (keys, first query); the user's own keys (a new
// key is shown once); the address and documentation; ready-made examples for
// Planilha Google, Power BI, Python and curl; the queries this user may call;
// care points and common problems. Shown in the menu ("Claude e API") only
// while API_ENABLED is on and the user has MCP access; a direct visit still
// renders the "off"/"no access" notes. Help article: src/help/screens/api-dados.ts.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { copiar, fmtDate } from "@/components/integracoes/copiar";
import { Passo } from "@/components/integracoes/passo-a-passo";
import { requestConfirmation } from "@/components/system-dialog-host";
import { tourAnchor } from "@/help/anchor";
import { createMyApiKey, getMyApiKeys, revokeMyApiKey } from "@/lib/api/keys.functions";

export const Route = createFileRoute("/api-dados")({
  component: ApiDadosPage,
});

type Exemplo = { id: string; rotulo: string; comoUsar: string; codigo: (url: string) => string };

const EXEMPLOS: Exemplo[] = [
  {
    id: "primeira",
    rotulo: "Primeira consulta",
    comoUsar:
      "Mostra as casas e os grupos que a sua chave vê, com os ids que as outras consultas pedem. Cole no terminal (Prompt de Comando, PowerShell ou Terminal) trocando SUA_CHAVE pela chave.",
    codigo: (url) =>
      [`curl -X POST ${url}/listar_escopos \\`, `  -H "Authorization: Bearer SUA_CHAVE"`].join("\n"),
  },
  {
    id: "planilha",
    rotulo: "Planilha Google",
    comoUsar:
      'Na planilha: Extensões → Apps Script → apague o que estiver lá e cole o código. Em Configurações do projeto (engrenagem) → Propriedades do script, crie BETLEADS_CHAVE com a sua chave (assim a chave não fica no código). Troque ID_DA_CASA, salve e clique em Executar. Os dados vão para a aba "Betleads". Para atualizar sozinho, crie um acionador (relógio) diário.',
    codigo: (url) => `function atualizarBetleads() {
  const chave = PropertiesService.getScriptProperties().getProperty("BETLEADS_CHAVE");
  const resposta = UrlFetchApp.fetch("${url}/serie_diaria", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + chave },
    payload: JSON.stringify({
      escopo: { tipo: "casa", id: "ID_DA_CASA" },
      periodo: { preset: "month" },
    }),
  });
  const dados = JSON.parse(resposta.getContentText());
  const colunas = ["data", "casa_id", "cadastros", "ftds", "valor_depositado", "valor_sacado", "anuncios", "ggr", "net", "custo_envios_brl"];
  const linhas = dados.linhas.map((linha) => colunas.map((c) => linha[c]));
  const planilha = SpreadsheetApp.getActiveSpreadsheet();
  const aba = planilha.getSheetByName("Betleads") || planilha.insertSheet("Betleads");
  aba.clearContents();
  aba.getRange(1, 1, 1, colunas.length).setValues([colunas]);
  if (linhas.length) aba.getRange(2, 1, linhas.length, colunas.length).setValues(linhas);
}`,
  },
  {
    id: "powerbi",
    rotulo: "Power BI",
    comoUsar:
      "No Power BI Desktop: Obter dados → Consulta nula → Editor avançado. Cole o código, troque SUA_CHAVE e ID_DO_GRUPO (ou use tipo = \"casa\") e clique em Concluído. Se o Power BI perguntar como se conectar, escolha Anônimo: a chave já vai no código.",
    codigo: (url) => `let
    Chave = "SUA_CHAVE",
    Corpo = Json.FromValue([
        escopo = [tipo = "grupo", id = "ID_DO_GRUPO"],
        periodo = [preset = "month"]
    ]),
    Resposta = Json.Document(Web.Contents("${url}", [
        RelativePath = "serie_diaria",
        Headers = [Authorization = "Bearer " & Chave, #"Content-Type" = "application/json"],
        Content = Corpo
    ])),
    Tabela = Table.FromRecords(Resposta[linhas])
in
    Tabela`,
  },
  {
    id: "python",
    rotulo: "Python",
    comoUsar:
      "Precisa do pacote requests (pip install requests). Guarde a chave numa variável de ambiente BETLEADS_CHAVE em vez de deixá-la no código.",
    codigo: (url) => `import os
import requests

resposta = requests.post(
    "${url}/serie_diaria",
    headers={"Authorization": f"Bearer {os.environ['BETLEADS_CHAVE']}"},
    json={"escopo": {"tipo": "casa", "id": "ID_DA_CASA"}, "periodo": {"preset": "7d"}},
    timeout=60,
)
resposta.raise_for_status()
for linha in resposta.json()["linhas"]:
    print(linha["data"], linha["casa_id"], linha["valor_depositado"])`,
  },
];

const AREA_TITULO = { geral: "Geral", financeiro: "Financeiro", operacao: "Operação" } as const;

const PROBLEMAS = [
  {
    q: '401 — "Chave de API inválida ou revogada."',
    a: 'A chave foi digitada errada, foi revogada, ou o seu acesso ao Claude/API foi retirado pelo super admin. Confira se o cabeçalho é exatamente "Authorization: Bearer " seguido da chave.',
  },
  {
    q: "403 — sem permissão ou sem acesso a uma área",
    a: "A casa, o grupo ou a área (financeiro ou operação) não está liberada para o seu usuário. Rode listar_escopos para ver o que a chave vê, ou peça ao super admin.",
  },
  {
    q: '400 — "Argumentos inválidos." ou outra mensagem',
    a: 'O corpo da chamada tem algum campo errado. O campo "detalhes" da resposta diz qual. A documentação (openapi.json) mostra os campos de cada consulta.',
  },
  {
    q: '429 — "Muitas chamadas. Aguarde um minuto."',
    a: "O limite é de 60 chamadas por minuto por chave. Para muitos dias, use serie_diaria (até 366 dias numa chamada só) em vez de uma chamada por dia.",
  },
  {
    q: "Os números não batem com o painel",
    a: 'Cada resposta traz calculado_em: os números são os do painel naquele horário. Resultados de CRM atualizam a cada 15 minutos e o GGR depende do lançamento. Se mesmo assim estiver diferente, anote a casa, o dia e o número e avise o suporte.',
  },
];

function ApiDadosPage() {
  const qc = useQueryClient();
  const keysFn = useServerFn(getMyApiKeys);
  const createFn = useServerFn(createMyApiKey);
  const revokeFn = useServerFn(revokeMyApiKey);
  const [nome, setNome] = useState("");
  const [novaChave, setNovaChave] = useState<string | null>(null);
  const [exemploId, setExemploId] = useState(EXEMPLOS[0].id);

  const { data, isLoading } = useQuery({ queryKey: ["api", "my-keys"], queryFn: () => keysFn() });
  const create = useMutation({
    mutationFn: (value: string) => createFn({ data: { nome: value } }),
    onSuccess: ({ key }) => {
      setNovaChave(key);
      setNome("");
      qc.invalidateQueries({ queryKey: ["api", "my-keys"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Erro ao criar a chave."),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Chave revogada");
      qc.invalidateQueries({ queryKey: ["api", "my-keys"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Erro ao revogar."),
  });

  if (isLoading || !data) {
    return (
      <Page>
        <PageHeader title="API de dados" subtitle="Carregando…" />
      </Page>
    );
  }

  if (!data.enabled) {
    return (
      <Page>
        <PageHeader title="API de dados" />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            A API está desligada neste ambiente ou o seu usuário não tem acesso. Peça ao super
            admin.
          </CardContent>
        </Card>
      </Page>
    );
  }

  async function revogar(id: string, keyName: string) {
    const confirmed = await requestConfirmation({
      title: "Revogar a chave?",
      description: `As planilhas, painéis e scripts que usam a chave "${keyName}" param de funcionar na hora.`,
      confirmLabel: "Revogar",
      destructive: true,
    });
    if (confirmed) revoke.mutate(id);
  }

  const temChave = data.keys.length > 0;
  const exemplo = EXEMPLOS.find((item) => item.id === exemploId) ?? EXEMPLOS[0];
  const codigo = exemplo.codigo(data.apiUrl);
  const openapiUrl = `${data.apiUrl}/openapi.json`;
  const grupos = (["geral", "financeiro", "operacao"] as const)
    .map((area) => ({
      area,
      itens: data.ferramentas.filter((tool) => (tool.area ?? "geral") === area),
    }))
    .filter((grupo) => grupo.itens.length > 0);

  return (
    <Page>
      <PageHeader
        title="API de dados"
        subtitle="Os números do Betleads em planilhas, BI e scripts internos. Só leitura."
      />

      <Card {...tourAnchor("api.passos.card")}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> Passo a passo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A API entrega os mesmos números do painel e do Claude para uma planilha, um painel de
            BI ou um script, sem copiar e colar. Ela só lê: nada no Betleads muda por ela. Vê as
            mesmas casas e áreas que você vê.
          </p>
          <ol className="space-y-4">
            <Passo numero={1} titulo="Crie uma chave" feito={temChave || data.hasUsedApi}>
              <p>
                Em <strong>Chaves</strong>, logo abaixo, dê um nome que diga onde ela vai ser usada
                (ex.: "Planilha do financeiro") e clique em <strong>Criar chave</strong>. Use uma
                chave por planilha ou sistema: assim dá para revogar uma sem parar as outras.
              </p>
            </Passo>
            <Passo numero={2} titulo="Copie e guarde a chave" feito={temChave || data.hasUsedApi}>
              <p>
                A chave aparece <strong>uma vez só</strong>. Copie e guarde num lugar seguro, como
                um gerenciador de senhas. Ela funciona como uma senha: quem tiver a chave vê os
                mesmos números que você.
              </p>
            </Passo>
            <Passo numero={3} titulo="Faça a primeira consulta" feito={data.hasUsedApi}>
              <p>
                Em <strong>Exemplos prontos</strong>, escolha a sua ferramenta (Planilha Google,
                Power BI ou Python), copie o código e troque SUA_CHAVE e o id da casa ou do grupo.
                Os ids aparecem na "Primeira consulta".
              </p>
              <p>
                Para planilhas e BI, a consulta indicada é a <strong>serie_diaria</strong>: uma
                linha por casa e por dia, até 366 dias de uma vez.
              </p>
            </Passo>
          </ol>
        </CardContent>
      </Card>

      <Card {...tourAnchor("api.chaves.card")}>
        <CardHeader>
          <CardTitle>Chaves</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {novaChave ? (
            <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
              <div className="font-medium">Copie a chave agora: ela não aparece de novo.</div>
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label="Nova chave de API"
                  value={novaChave}
                  className="min-w-0 flex-1 font-mono"
                />
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() => void copiar(novaChave, "Chave copiada")}
                >
                  <Copy className="h-4 w-4" /> Copiar
                </Button>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setNovaChave(null)}>
                Já copiei
              </Button>
            </div>
          ) : null}

          <form
            className="flex flex-col gap-2 sm:flex-row"
            {...tourAnchor("api.chaves.criar")}
            onSubmit={(event) => {
              event.preventDefault();
              if (nome.trim()) create.mutate(nome.trim());
            }}
          >
            <Input
              aria-label="Nome da chave"
              placeholder='Nome da chave (ex.: "Planilha do financeiro")'
              value={nome}
              maxLength={80}
              onChange={(event) => setNome(event.target.value)}
              className="min-w-0 flex-1"
            />
            <Button type="submit" disabled={!nome.trim() || create.isPending}>
              {create.isPending ? "Criando…" : "Criar chave"}
            </Button>
          </form>

          <div className="space-y-2">
            {data.keys.length === 0 && (
              <p className="text-muted-foreground">Nenhuma chave ativa.</p>
            )}
            {data.keys.map((key, index) => (
              <div
                key={key.id}
                className="flex items-center justify-between gap-2 border-b border-border/40 pb-2 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{key.nome}</div>
                  <div className="text-meta text-muted-foreground">
                    <span className="font-mono">{key.prefixo}…</span> · criada em{" "}
                    {fmtDate(key.createdAt)} · último uso: {fmtDate(key.lastUsedAt)}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  {...(index === 0 ? tourAnchor("api.chaves.revogar") : {})}
                  disabled={revoke.isPending && revoke.variables === key.id}
                  onClick={() => void revogar(key.id, key.nome)}
                >
                  {revoke.isPending && revoke.variables === key.id ? "Revogando…" : "Revogar"}
                </Button>
              </div>
            ))}
          </div>
          <p className="text-meta text-muted-foreground">Até 5 chaves ativas por pessoa.</p>
        </CardContent>
      </Card>

      <Card {...tourAnchor("api.exemplos.card")}>
        <CardHeader>
          <CardTitle>Exemplos prontos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Ferramenta">
            {EXEMPLOS.map((item) => (
              <Button
                key={item.id}
                type="button"
                size="sm"
                role="tab"
                aria-selected={item.id === exemplo.id}
                variant={item.id === exemplo.id ? "default" : "outline"}
                onClick={() => setExemploId(item.id)}
              >
                {item.rotulo}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground">{exemplo.comoUsar}</p>
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
            {codigo}
          </pre>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            {...tourAnchor("api.exemplos.copiar")}
            onClick={() => void copiar(codigo, "Código copiado")}
          >
            <Copy className="h-4 w-4" /> Copiar código
          </Button>
        </CardContent>
      </Card>

      <Card {...tourAnchor("api.consultas.card")}>
        <CardHeader>
          <CardTitle>Consultas disponíveis</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Cada consulta é um POST em {data.apiUrl}/<em>nome</em>, com os argumentos em JSON (os
            mesmos que o Claude usa). Os campos de cada uma estão na documentação.
          </p>
          {grupos.map((grupo) => (
            <div key={grupo.area} className="space-y-1">
              <div className="font-medium">{AREA_TITULO[grupo.area]}</div>
              <ul className="space-y-1">
                {grupo.itens.map((tool) => (
                  <li key={tool.nome} className="flex flex-wrap gap-x-2">
                    <code className="font-mono">{tool.nome}</code>
                    <span className="text-muted-foreground">{tool.titulo}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card {...tourAnchor("api.endereco.card")}>
        <CardHeader>
          <CardTitle>Endereço e documentação</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {[
            { rotulo: "Endereço da API", valor: data.apiUrl, aviso: "Endereço copiado" },
            { rotulo: "Documentação (OpenAPI)", valor: openapiUrl, aviso: "Endereço copiado" },
          ].map((item, index) => (
            <div key={item.rotulo} className="space-y-1">
              <div className="text-muted-foreground">{item.rotulo}</div>
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label={item.rotulo}
                  value={item.valor}
                  className="min-w-0 flex-1 bg-muted/30 font-mono"
                />
                <Button
                  variant="outline"
                  className="gap-2"
                  {...(index === 0 ? tourAnchor("api.endereco.copiar") : {})}
                  onClick={() => void copiar(item.valor, item.aviso)}
                >
                  <Copy className="h-4 w-4" /> Copiar
                </Button>
              </div>
            </div>
          ))}
          <p className="text-meta text-muted-foreground">
            A documentação pode ser importada no Postman, Insomnia ou em ferramentas de BI que
            aceitam OpenAPI.
          </p>
        </CardContent>
      </Card>

      <Card {...tourAnchor("api.cuidados.card")}>
        <CardHeader>
          <CardTitle>Cuidados</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              A chave é como uma senha. Não a coloque em planilha compartilhada com quem não deve
              ver os números, nem em mensagem ou e-mail.
            </li>
            <li>Vazou ou não usa mais? Clique em Revogar: ela para na hora.</li>
            <li>
              A API só lê. Nenhum dado de jogador sai por ela (nome, telefone, e-mail, CPF): só
              números somados.
            </li>
            <li>
              Se o super admin tirar o seu acesso, todas as suas chaves param de funcionar.
            </li>
            <li>Limite de 60 chamadas por minuto por chave.</li>
          </ul>
        </CardContent>
      </Card>

      <Card {...tourAnchor("api.problemas.card")}>
        <CardHeader>
          <CardTitle>Problemas comuns</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {PROBLEMAS.map((item) => (
            <details key={item.q} className="rounded-md border px-3 py-2">
              <summary className="cursor-pointer font-medium">{item.q}</summary>
              <p className="mt-1.5 text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </CardContent>
      </Card>
    </Page>
  );
}
