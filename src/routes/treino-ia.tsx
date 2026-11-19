import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2, Plus, ThumbsDown, ThumbsUp, Download, Check } from "lucide-react";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { LoadError } from "@/components/journeys/load-error";
import { requestConfirmation } from "@/components/system-dialog-host";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { DEMO_EMPTY_STATE_TEXT } from "@/lib/demo-tenant";
import { tourAnchor } from "@/help/anchor";

export const Route = createFileRoute("/treino-ia")({
  component: TreinoIA,
});

type Example = {
  id: string;
  pergunta: string;
  resposta_ideal: string;
  intent: string | null;
  tags: string[];
  fonte: string;
  ativo: boolean;
  created_at: string;
};
type Intent = {
  id: string;
  nome: string;
  descricao: string | null;
  palavras_chave: string[];
  campo_alvo: string | null;
  operador: string | null;
  limite_padrao: number;
  prioridade: number;
  ativo: boolean;
};
type Synonym = {
  id: string;
  termo: string;
  canonico: string;
  tipo: string;
  ativo: boolean;
};
type Feedback = {
  id: string;
  rating: string;
  motivo: string | null;
  created_at: string;
  ai_log_id: string | null;
  ai_logs?: { pergunta: string; resposta: string } | null;
};
type LogRow = { id: string; pergunta: string; resposta: string; created_at: string };

const VIEWS = [
  { value: "exemplos", label: "Exemplos" },
  { value: "assuntos", label: "Assuntos e sinônimos" },
  { value: "avaliacoes", label: "Avaliações" },
] as const;
type View = (typeof VIEWS)[number]["value"];

const SYNONYM_TYPES = [
  { value: "geral", label: "Geral" },
  { value: "campo", label: "Dado do jogador" },
  { value: "expert", label: "Expert" },
  { value: "periodo", label: "Período" },
] as const;

const KEYS = {
  examples: ["treino-ia", "examples"],
  logs: ["treino-ia", "logs"],
  intents: ["treino-ia", "intents"],
  synonyms: ["treino-ia", "synonyms"],
  feedback: ["treino-ia", "feedback"],
} as const;

/** Supabase calls return `{ error }` instead of throwing: turn it into a throw. */
function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

const onMutationError = (error: Error) => toast.error(error.message);

function TreinoIA() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const view: View = VIEWS.find((item) => item.value === hash)?.value ?? "exemplos";
  const setView = (next: View) =>
    void navigate({ to: "/treino-ia", hash: next === "exemplos" ? undefined : next });
  return (
    <Page>
      <PageHeader subtitle="Ensine o assistente com exemplos de resposta, palavras da casa e as avaliações da equipe." />
      <PageTabs
        value={view}
        onValueChange={setView}
        label="Seções de Configurar IA"
        items={VIEWS}
      />
      <div role="tabpanel" aria-labelledby={`tab-${view}`}>
        {view === "exemplos" && <ExemplosTab />}
        {view === "assuntos" && <IntentsTab />}
        {view === "avaliacoes" && <FeedbackTab />}
      </div>
    </Page>
  );
}

function LoadingText({ children = "Carregando…" }: { children?: string }) {
  return <p className="py-4 text-center text-meta text-muted-foreground">{children}</p>;
}

// =================== EXEMPLOS ===================
function ExemplosTab() {
  const isDemo = useIsDemoTenant();
  const queryClient = useQueryClient();
  const [pergunta, setPergunta] = useState("");
  const [resposta, setResposta] = useState("");
  const [intent, setIntent] = useState("");
  const [showImport, setShowImport] = useState(false);

  const examples = useQuery({
    queryKey: KEYS.examples,
    queryFn: async () =>
      (check(
        await supabase
          .from("ai_training_examples")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(200),
      ) ?? []) as Example[],
  });
  const logs = useQuery({
    queryKey: KEYS.logs,
    enabled: showImport,
    queryFn: async () =>
      (check(
        await supabase
          .from("ai_logs")
          .select("id,pergunta,resposta,created_at")
          .order("created_at", { ascending: false })
          .limit(30),
      ) ?? []) as LogRow[],
  });
  const refreshExamples = () => queryClient.invalidateQueries({ queryKey: KEYS.examples });

  const add = useMutation({
    mutationFn: async () => {
      check(
        await supabase.from("ai_training_examples").insert({
          pergunta: pergunta.trim(),
          resposta_ideal: resposta.trim(),
          intent: intent.trim() || null,
          fonte: "manual",
          ativo: true,
        }),
      );
    },
    onSuccess: async () => {
      toast.success("Exemplo cadastrado");
      // Fields are cleared only after the insert worked (a failure keeps the text).
      setPergunta("");
      setResposta("");
      setIntent("");
      await refreshExamples();
    },
    onError: onMutationError,
  });
  const toggle = useMutation({
    mutationFn: async (it: Example) => {
      check(
        await supabase.from("ai_training_examples").update({ ativo: !it.ativo }).eq("id", it.id),
      );
    },
    onSettled: refreshExamples,
    onError: onMutationError,
  });
  const remove = useMutation({
    mutationFn: async (it: Example) => {
      check(await supabase.from("ai_training_examples").delete().eq("id", it.id));
    },
    onSuccess: () => toast.success("Exemplo excluído"),
    onSettled: refreshExamples,
    onError: onMutationError,
  });

  function submit() {
    if (!pergunta.trim() || !resposta.trim()) {
      toast.error("Preencha a pergunta e a resposta ideal.");
      return;
    }
    add.mutate();
  }

  function importFromLog(l: LogRow) {
    setPergunta(l.pergunta);
    try {
      const parsed = JSON.parse(l.resposta);
      setResposta(parsed.summary ?? l.resposta);
    } catch {
      setResposta(l.resposta);
    }
    setShowImport(false);
    toast.info("Edite a resposta e clique em Salvar para virar exemplo");
  }

  const items = examples.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Novo exemplo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <div className="space-y-1.5">
              <Label htmlFor="example-question">Pergunta</Label>
              <Input
                id="example-question"
                {...tourAnchor("exemplos.pergunta")}
                value={pergunta}
                onChange={(e) => setPergunta(e.target.value)}
                placeholder="Ex.: os 5 que mais depositaram hoje"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="example-intent">Assunto (opcional)</Label>
              <Input
                id="example-intent"
                {...tourAnchor("exemplos.assunto")}
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="Ex.: top_depositantes"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="example-answer">Resposta ideal</Label>
            <Textarea
              id="example-answer"
              {...tourAnchor("exemplos.resposta")}
              value={resposta}
              onChange={(e) => setResposta(e.target.value)}
              rows={3}
              placeholder="Aceita **negrito** e listas"
            />
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <DemoDisabledTooltip active={isDemo}>
              <Button
                {...tourAnchor("exemplos.importar")}
                variant="outline"
                size="sm"
                onClick={() => setShowImport(true)}
                disabled={isDemo}
              >
                <Download className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                Importar do histórico
              </Button>
            </DemoDisabledTooltip>
            <DemoDisabledTooltip active={isDemo}>
              <Button
                {...tourAnchor("exemplos.salvar")}
                onClick={submit}
                disabled={isDemo || add.isPending}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                {add.isPending ? "Salvando…" : "Salvar exemplo"}
              </Button>
            </DemoDisabledTooltip>
          </div>
        </CardContent>
      </Card>

      {showImport && (
        <Card {...tourAnchor("exemplos.importar-lista")}>
          <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
            <CardTitle>Últimas perguntas feitas à IA</CardTitle>
            <Button size="sm" variant="ghost" onClick={() => setShowImport(false)}>
              Fechar
            </Button>
          </CardHeader>
          <CardContent className="space-y-1 md:max-h-72 md:overflow-y-auto">
            {logs.isLoading ? (
              <LoadingText />
            ) : logs.isError ? (
              <LoadError
                title="Não foi possível carregar as perguntas"
                message={logs.error.message}
                onRetry={() => void logs.refetch()}
                retrying={logs.isFetching}
              />
            ) : (
              <>
                {(logs.data ?? []).map((l, i) => (
                  <button
                    key={l.id}
                    type="button"
                    {...(i === 0 ? tourAnchor("exemplos.importar-item") : {})}
                    onClick={() => importFromLog(l)}
                    className="min-h-11 w-full rounded-lg border border-border/40 p-2 text-left text-meta hover:bg-muted/30"
                  >
                    <p className="font-medium truncate">{l.pergunta}</p>
                    <p className="text-muted-foreground truncate">{l.resposta?.slice(0, 120)}</p>
                  </button>
                ))}
                {!logs.data?.length && (
                  <p className="text-meta text-muted-foreground">Nenhuma pergunta ainda.</p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card {...tourAnchor("exemplos.lista")}>
        <CardHeader className="pb-3">
          <CardTitle>
            Exemplos cadastrados{examples.data ? ` (${items.length})` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {examples.isLoading ? (
            <LoadingText>Carregando exemplos…</LoadingText>
          ) : examples.isError ? (
            <LoadError
              title="Não foi possível carregar os exemplos"
              message={examples.error.message}
              onRetry={() => void examples.refetch()}
              retrying={examples.isFetching}
            />
          ) : (
            <>
              {items.map((it, i) => {
                const busy =
                  (toggle.isPending && toggle.variables?.id === it.id) ||
                  (remove.isPending && remove.variables?.id === it.id);
                return (
                  <div key={it.id} className="rounded border border-border/40 p-3 space-y-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium break-words">{it.pergunta}</p>
                        <p className="text-meta text-muted-foreground mt-1 line-clamp-2">
                          {it.resposta_ideal}
                        </p>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {it.intent && (
                            <Badge variant="outline" className="text-meta">
                              {it.intent}
                            </Badge>
                          )}
                          <Badge variant="secondary" className="text-meta">
                            {it.fonte}
                          </Badge>
                          {!it.ativo && (
                            <Badge variant="destructive" className="text-meta">
                              inativo
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Switch
                          {...(i === 0 ? tourAnchor("exemplos.item.ligar") : {})}
                          aria-label={`${it.ativo ? "Desligar" : "Ligar"} o exemplo "${it.pergunta}"`}
                          checked={it.ativo}
                          disabled={isDemo || busy}
                          onCheckedChange={() => toggle.mutate(it)}
                        />
                        <DemoDisabledTooltip active={isDemo}>
                          <IconButton
                            {...(i === 0 ? tourAnchor("exemplos.item.excluir") : {})}
                            label="Excluir exemplo"
                            icon={<Trash2 className="h-4 w-4 text-danger" aria-hidden="true" />}
                            disabled={isDemo || busy}
                            onClick={async () => {
                              const confirmed = await requestConfirmation({
                                title: "Excluir este exemplo?",
                                description: `O exemplo "${it.pergunta}" será apagado e deixa de orientar as respostas da IA. Para só pausar, use a chave ao lado.`,
                                confirmLabel: "Excluir exemplo",
                                destructive: true,
                              });
                              if (confirmed) remove.mutate(it);
                            }}
                          />
                        </DemoDisabledTooltip>
                      </div>
                    </div>
                  </div>
                );
              })}
              {!items.length && (
                <p className="text-meta text-muted-foreground">
                  {isDemo ? DEMO_EMPTY_STATE_TEXT : "Nenhum exemplo ainda."}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =================== INTENTS + SINÔNIMOS ===================
function IntentsTab() {
  const isDemo = useIsDemoTenant();
  const queryClient = useQueryClient();
  const [novoTermo, setNovoTermo] = useState("");
  const [novoCanonico, setNovoCanonico] = useState("");
  const [novoTipo, setNovoTipo] = useState("geral");

  const intents = useQuery({
    queryKey: KEYS.intents,
    queryFn: async () =>
      (check(await supabase.from("ai_intents").select("*").order("prioridade")) ??
        []) as Intent[],
  });
  const synonyms = useQuery({
    queryKey: KEYS.synonyms,
    queryFn: async () =>
      (check(await supabase.from("ai_synonyms").select("*").order("termo")) ?? []) as Synonym[],
  });
  const refreshIntents = () => queryClient.invalidateQueries({ queryKey: KEYS.intents });
  const refreshSynonyms = () => queryClient.invalidateQueries({ queryKey: KEYS.synonyms });

  const toggleIntent = useMutation({
    mutationFn: async (i: Intent) => {
      check(await supabase.from("ai_intents").update({ ativo: !i.ativo }).eq("id", i.id));
    },
    onSettled: refreshIntents,
    onError: onMutationError,
  });
  const toggleSyn = useMutation({
    mutationFn: async (s: Synonym) => {
      check(await supabase.from("ai_synonyms").update({ ativo: !s.ativo }).eq("id", s.id));
    },
    onSettled: refreshSynonyms,
    onError: onMutationError,
  });
  const addSyn = useMutation({
    mutationFn: async () => {
      check(
        await supabase.from("ai_synonyms").insert({
          termo: novoTermo.trim(),
          canonico: novoCanonico.trim(),
          tipo: novoTipo,
        }),
      );
    },
    onSuccess: async () => {
      toast.success("Sinônimo adicionado");
      setNovoTermo("");
      setNovoCanonico("");
      await refreshSynonyms();
    },
    onError: onMutationError,
  });
  const delSyn = useMutation({
    mutationFn: async (s: Synonym) => {
      check(await supabase.from("ai_synonyms").delete().eq("id", s.id));
    },
    onSuccess: () => toast.success("Sinônimo excluído"),
    onSettled: refreshSynonyms,
    onError: onMutationError,
  });

  function submitSyn() {
    if (!novoTermo.trim() || !novoCanonico.trim()) {
      toast.error("Preencha a palavra da casa e o termo conhecido");
      return;
    }
    addSyn.mutate();
  }

  const intentRows = intents.data ?? [];
  const syns = synonyms.data ?? [];

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card {...tourAnchor("assuntos.lista")}>
        <CardHeader className="pb-3">
          <CardTitle>
            Assuntos que o assistente entende{intents.data ? ` (${intentRows.length})` : ""}
          </CardTitle>
        </CardHeader>
        {/* Own scroll only on desktop: on phones a nested scroll traps the finger. */}
        <CardContent className="space-y-2 md:max-h-[600px] md:overflow-y-auto">
          {intents.isLoading ? (
            <LoadingText>Carregando assuntos…</LoadingText>
          ) : intents.isError ? (
            <LoadError
              title="Não foi possível carregar os assuntos"
              message={intents.error.message}
              onRetry={() => void intents.refetch()}
              retrying={intents.isFetching}
            />
          ) : (
            intentRows.map((i, idx) => (
              <div key={i.id} className="rounded border border-border/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{i.nome}</p>
                    <p className="text-meta text-muted-foreground">{i.descricao}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {i.palavras_chave?.slice(0, 6).map((k, kidx) => (
                        <Badge key={kidx} variant="outline" className="text-meta">
                          {k}
                        </Badge>
                      ))}
                    </div>
                    {i.campo_alvo && (
                      <p className="text-meta text-muted-foreground mt-1.5">
                        Ordena por <code className="break-all">{i.campo_alvo}</code> · mostra até{" "}
                        {i.limite_padrao}
                      </p>
                    )}
                  </div>
                  <Switch
                    {...(idx === 0 ? tourAnchor("assuntos.item.ligar") : {})}
                    aria-label={`${i.ativo ? "Desligar" : "Ligar"} ${i.nome}`}
                    checked={i.ativo}
                    disabled={
                      isDemo || (toggleIntent.isPending && toggleIntent.variables?.id === i.id)
                    }
                    onCheckedChange={() => toggleIntent.mutate(i)}
                  />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Sinônimos{synonyms.data ? ` (${syns.length})` : ""}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2 p-3 rounded border border-border/40 bg-muted/20">
            <p className="text-label font-medium">Adicionar sinônimo</p>
            <p className="text-meta text-muted-foreground">
              Uma palavra da casa e o termo que o assistente já conhece. Ex.: “banca” →
              saldo_carteira.
            </p>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px]">
              <div className="space-y-1.5">
                <Label htmlFor="synonym-term">Palavra da casa</Label>
                <Input
                  id="synonym-term"
                  {...tourAnchor("assuntos.syn.termo")}
                  value={novoTermo}
                  onChange={(e) => setNovoTermo(e.target.value)}
                  placeholder="Ex.: banca"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="synonym-canonical">Termo conhecido</Label>
                <Input
                  id="synonym-canonical"
                  {...tourAnchor("assuntos.syn.canonico")}
                  value={novoCanonico}
                  onChange={(e) => setNovoCanonico(e.target.value)}
                  placeholder="Ex.: saldo_carteira"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="synonym-type">Tipo</Label>
                <Select value={novoTipo} onValueChange={setNovoTipo}>
                  <SelectTrigger
                    id="synonym-type"
                    className="h-10"
                    {...tourAnchor("assuntos.syn.tipo")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SYNONYM_TYPES.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DemoDisabledTooltip active={isDemo}>
              <Button
                {...tourAnchor("assuntos.syn.adicionar")}
                size="sm"
                onClick={submitSyn}
                disabled={isDemo || addSyn.isPending}
              >
                <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                {addSyn.isPending ? "Adicionando…" : "Adicionar"}
              </Button>
            </DemoDisabledTooltip>
          </div>
          <div
            {...tourAnchor("assuntos.syn.lista")}
            className="space-y-1 md:max-h-[440px] md:overflow-y-auto"
          >
            {synonyms.isLoading ? (
              <LoadingText>Carregando sinônimos…</LoadingText>
            ) : synonyms.isError ? (
              <LoadError
                title="Não foi possível carregar os sinônimos"
                message={synonyms.error.message}
                onRetry={() => void synonyms.refetch()}
                retrying={synonyms.isFetching}
              />
            ) : (
              syns.map((s, sidx) => {
                const busy =
                  (toggleSyn.isPending && toggleSyn.variables?.id === s.id) ||
                  (delSyn.isPending && delSyn.variables?.id === s.id);
                return (
                  <div
                    key={s.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/30 px-2 py-1.5 text-meta"
                  >
                    <Badge variant="outline" className="text-meta">
                      {s.tipo}
                    </Badge>
                    <span className="min-w-0 break-words font-medium">{s.termo}</span>
                    <span className="text-muted-foreground" aria-hidden="true">
                      →
                    </span>
                    <span className="sr-only">significa</span>
                    <code className="min-w-0 break-all text-success">{s.canonico}</code>
                    <div className="ml-auto flex items-center gap-1">
                      <Switch
                        {...(sidx === 0 ? tourAnchor("assuntos.syn.item.ligar") : {})}
                        aria-label={`${s.ativo ? "Desligar" : "Ligar"} o sinônimo ${s.termo}`}
                        checked={s.ativo}
                        disabled={isDemo || busy}
                        onCheckedChange={() => toggleSyn.mutate(s)}
                      />
                      <DemoDisabledTooltip active={isDemo}>
                        <IconButton
                          {...(sidx === 0 ? tourAnchor("assuntos.syn.item.excluir") : {})}
                          label={`Excluir sinônimo ${s.termo}`}
                          icon={<Trash2 className="h-4 w-4 text-danger" aria-hidden="true" />}
                          disabled={isDemo || busy}
                          onClick={async () => {
                            const confirmed = await requestConfirmation({
                              title: "Excluir este sinônimo?",
                              description: `"${s.termo}" deixa de ser reconhecido como "${s.canonico}". Para só pausar, use a chave ao lado.`,
                              confirmLabel: "Excluir sinônimo",
                              destructive: true,
                            });
                            if (confirmed) delSyn.mutate(s);
                          }}
                        />
                      </DemoDisabledTooltip>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// =================== FEEDBACK ===================
function FeedbackTab() {
  const isDemo = useIsDemoTenant();
  const queryClient = useQueryClient();
  // Feedback already turned into a draft in this visit: the button stays "Rascunho criado".
  const [drafted, setDrafted] = useState<ReadonlySet<string>>(() => new Set());

  const feedback = useQuery({
    queryKey: KEYS.feedback,
    queryFn: async () =>
      (check(
        await supabase
          .from("ai_feedback")
          .select("id,rating,motivo,created_at,ai_log_id,ai_logs(pergunta,resposta)")
          .order("created_at", { ascending: false })
          .limit(100),
      ) ?? []) as unknown as Feedback[],
  });
  const items = feedback.data ?? [];
  const good = items.filter((x) => x.rating === "good").length;
  const bad = items.filter((x) => x.rating === "bad").length;
  const aprov = items.length ? Math.round((good / items.length) * 100) : 0;

  const turnIntoExample = useMutation({
    mutationFn: async (f: Feedback) => {
      const q = f.ai_logs?.pergunta;
      if (!q) throw new Error("Sem pergunta vinculada");
      check(
        await supabase.from("ai_training_examples").insert({
          pergunta: q,
          resposta_ideal: f.motivo || "(preencher a resposta ideal)",
          fonte: "feedback",
          ai_log_id: f.ai_log_id,
          ativo: false,
        }),
      );
    },
    onSuccess: async (_result, f) => {
      setDrafted((current) => new Set(current).add(f.id));
      toast.success("Rascunho criado em Exemplos — abra para editar e ativar");
      await queryClient.invalidateQueries({ queryKey: KEYS.examples });
    },
    onError: onMutationError,
  });

  const kpi = (value: string | number) => (feedback.data ? value : "—");

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card {...tourAnchor("avaliacoes.kpi.aprovacao")}>
          <CardContent className="p-4">
            <p className="text-label text-muted-foreground">Aprovação</p>
            <p className="text-kpi mt-1">{kpi(`${aprov}%`)}</p>
          </CardContent>
        </Card>
        <Card {...tourAnchor("avaliacoes.kpi.boas")}>
          <CardContent className="p-4">
            <p className="text-label text-muted-foreground">Respostas boas</p>
            <p className="text-kpi mt-1 text-success">{kpi(good)}</p>
          </CardContent>
        </Card>
        <Card {...tourAnchor("avaliacoes.kpi.ruins")}>
          <CardContent className="p-4">
            <p className="text-label text-muted-foreground">Respostas ruins</p>
            <p className="text-kpi mt-1 text-danger">{kpi(bad)}</p>
          </CardContent>
        </Card>
      </div>

      <Card {...tourAnchor("avaliacoes.lista")}>
        <CardHeader className="pb-3">
          <CardTitle>Avaliações recentes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {feedback.isLoading ? (
            <LoadingText>Carregando avaliações…</LoadingText>
          ) : feedback.isError ? (
            <LoadError
              title="Não foi possível carregar as avaliações"
              message={feedback.error.message}
              onRetry={() => void feedback.refetch()}
              retrying={feedback.isFetching}
            />
          ) : (
            <>
              {items.map((f, i) => {
                const done = drafted.has(f.id);
                const pending =
                  turnIntoExample.isPending && turnIntoExample.variables?.id === f.id;
                return (
                  <div key={f.id} className="rounded-lg border border-border/40 p-3 text-meta">
                    <div className="flex flex-wrap items-start gap-2">
                      {f.rating === "good" ? (
                        <ThumbsUp
                          className="h-3.5 w-3.5 text-success mt-0.5"
                          aria-label="Resposta boa"
                        />
                      ) : (
                        <ThumbsDown
                          className="h-3.5 w-3.5 text-danger mt-0.5"
                          aria-label="Resposta ruim"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium break-words">{f.ai_logs?.pergunta ?? "—"}</p>
                        {f.motivo && <p className="text-muted-foreground mt-1">"{f.motivo}"</p>}
                      </div>
                      {f.rating === "bad" && (
                        <DemoDisabledTooltip active={isDemo}>
                          <Button
                            {...(i === 0 ? tourAnchor("avaliacoes.criar-exemplo") : {})}
                            size="sm"
                            variant="outline"
                            onClick={() => turnIntoExample.mutate(f)}
                            disabled={isDemo || done || turnIntoExample.isPending}
                          >
                            {done ? (
                              <>
                                <Check className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                                Rascunho criado
                              </>
                            ) : pending ? (
                              "Criando…"
                            ) : (
                              "Criar exemplo"
                            )}
                          </Button>
                        </DemoDisabledTooltip>
                      )}
                    </div>
                  </div>
                );
              })}
              {!items.length && (
                <p className="text-meta text-muted-foreground">
                  {isDemo
                    ? DEMO_EMPTY_STATE_TEXT
                    : "Nenhuma avaliação ainda. Avalie as respostas no Assistente IA (👍 ou 👎)."}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
