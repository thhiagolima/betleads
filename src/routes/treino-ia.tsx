import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Trash2, Plus, ThumbsDown, ThumbsUp, Download } from "lucide-react";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { requestConfirmation } from "@/components/system-dialog-host";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { DEMO_EMPTY_STATE_TEXT } from "@/lib/demo-tenant";

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

// =================== EXEMPLOS ===================
function ExemplosTab() {
  const isDemo = useIsDemoTenant();
  const [items, setItems] = useState<Example[]>([]);
  const [pergunta, setPergunta] = useState("");
  const [resposta, setResposta] = useState("");
  const [intent, setIntent] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);

  async function load() {
    const { data } = await supabase
      .from("ai_training_examples")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    setItems((data as Example[]) ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function add() {
    if (!pergunta.trim() || !resposta.trim()) {
      return toast.error("Preencha a pergunta e a resposta ideal.");
    }
    const { error } = await supabase.from("ai_training_examples").insert({
      pergunta: pergunta.trim(),
      resposta_ideal: resposta.trim(),
      intent: intent.trim() || null,
      fonte: "manual",
      ativo: true,
    });
    if (error) return toast.error(error.message);
    toast.success("Exemplo cadastrado");
    setPergunta("");
    setResposta("");
    setIntent("");
    load();
  }

  async function toggle(it: Example) {
    await supabase.from("ai_training_examples").update({ ativo: !it.ativo }).eq("id", it.id);
    load();
  }
  async function remove(it: Example) {
    await supabase.from("ai_training_examples").delete().eq("id", it.id);
    load();
  }

  async function openImport() {
    setShowImport(true);
    const { data } = await supabase
      .from("ai_logs")
      .select("id,pergunta,resposta,created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    setLogs((data as LogRow[]) ?? []);
  }

  async function importFromLog(l: LogRow) {
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Novo exemplo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px]">
            <Input
              value={pergunta}
              onChange={(e) => setPergunta(e.target.value)}
              placeholder="Pergunta (ex.: os 5 que mais depositaram hoje)"
              aria-label="Pergunta"
            />
            <Input
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="Assunto (opcional)"
              aria-label="Assunto (opcional)"
            />
          </div>
          <Textarea
            value={resposta}
            onChange={(e) => setResposta(e.target.value)}
            rows={3}
            placeholder="Resposta ideal (aceita **negrito** e listas)"
            aria-label="Resposta ideal"
          />
          <div className="flex justify-between gap-2">
            <DemoDisabledTooltip active={isDemo}>
              <Button variant="outline" size="sm" onClick={openImport} disabled={isDemo}>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Importar do histórico
              </Button>
            </DemoDisabledTooltip>
            <DemoDisabledTooltip active={isDemo}>
              <Button onClick={add} disabled={isDemo}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Salvar exemplo
              </Button>
            </DemoDisabledTooltip>
          </div>
        </CardContent>
      </Card>

      {showImport && (
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle>Últimas perguntas feitas à IA</CardTitle>
            <Button size="sm" variant="ghost" onClick={() => setShowImport(false)}>
              Fechar
            </Button>
          </CardHeader>
          <CardContent className="space-y-1 max-h-72 overflow-y-auto">
            {logs.map((l) => (
              <button
                key={l.id}
                onClick={() => importFromLog(l)}
                className="w-full rounded-lg border border-border/40 p-2 text-left text-meta hover:bg-muted/30"
              >
                <p className="font-medium truncate">{l.pergunta}</p>
                <p className="text-muted-foreground truncate">{l.resposta?.slice(0, 120)}</p>
              </button>
            ))}
            {!logs.length && (
              <p className="text-meta text-muted-foreground">Nenhuma pergunta ainda.</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Exemplos cadastrados ({items.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {items.map((it) => (
            <div key={it.id} className="rounded border border-border/40 p-3 space-y-1">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{it.pergunta}</p>
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
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={it.ativo} disabled={isDemo} onCheckedChange={() => toggle(it)} />
                  <DemoDisabledTooltip active={isDemo}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Excluir exemplo"
                      disabled={isDemo}
                      onClick={async () => {
                        const confirmed = await requestConfirmation({
                          title: "Excluir este exemplo?",
                          description: `O exemplo "${it.pergunta}" será apagado e deixa de orientar as respostas da IA. Para só pausar, use a chave ao lado.`,
                          confirmLabel: "Excluir exemplo",
                          destructive: true,
                        });
                        if (confirmed) void remove(it);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-danger" />
                    </Button>
                  </DemoDisabledTooltip>
                </div>
              </div>
            </div>
          ))}
          {!items.length && (
            <p className="text-meta text-muted-foreground">
              {isDemo ? DEMO_EMPTY_STATE_TEXT : "Nenhum exemplo ainda."}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =================== INTENTS + SINÔNIMOS ===================
function IntentsTab() {
  const isDemo = useIsDemoTenant();
  const [intents, setIntents] = useState<Intent[]>([]);
  const [syns, setSyns] = useState<Synonym[]>([]);
  const [novoTermo, setNovoTermo] = useState("");
  const [novoCanonico, setNovoCanonico] = useState("");
  const [novoTipo, setNovoTipo] = useState("geral");

  async function load() {
    const [a, b] = await Promise.all([
      supabase.from("ai_intents").select("*").order("prioridade"),
      supabase.from("ai_synonyms").select("*").order("termo"),
    ]);
    setIntents((a.data as Intent[]) ?? []);
    setSyns((b.data as Synonym[]) ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function toggleIntent(i: Intent) {
    await supabase.from("ai_intents").update({ ativo: !i.ativo }).eq("id", i.id);
    load();
  }
  async function toggleSyn(s: Synonym) {
    await supabase.from("ai_synonyms").update({ ativo: !s.ativo }).eq("id", s.id);
    load();
  }
  async function addSyn() {
    if (!novoTermo.trim() || !novoCanonico.trim())
      return toast.error("Preencha a palavra da casa e o termo conhecido");
    await supabase.from("ai_synonyms").insert({
      termo: novoTermo.trim(),
      canonico: novoCanonico.trim(),
      tipo: novoTipo,
    });
    setNovoTermo("");
    setNovoCanonico("");
    load();
  }
  async function delSyn(s: Synonym) {
    await supabase.from("ai_synonyms").delete().eq("id", s.id);
    load();
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Assuntos que o assistente entende ({intents.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 max-h-[600px] overflow-y-auto">
          {intents.map((i) => (
            <div key={i.id} className="rounded border border-border/40 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <p className="text-sm font-medium">{i.nome}</p>
                  <p className="text-meta text-muted-foreground">{i.descricao}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {i.palavras_chave?.slice(0, 6).map((k, idx) => (
                      <Badge key={idx} variant="outline" className="text-meta">
                        {k}
                      </Badge>
                    ))}
                  </div>
                  {i.campo_alvo && (
                    <p className="text-meta text-muted-foreground mt-1.5">
                      Ordena por <code>{i.campo_alvo}</code> · mostra até {i.limite_padrao}
                    </p>
                  )}
                </div>
                <Switch
                  aria-label={`${i.ativo ? "Desligar" : "Ligar"} ${i.nome}`}
                  checked={i.ativo}
                  disabled={isDemo}
                  onCheckedChange={() => toggleIntent(i)}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Sinônimos ({syns.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2 p-3 rounded border border-border/40 bg-muted/20">
            <Label className="text-label">Adicionar sinônimo</Label>
            <p className="text-meta text-muted-foreground">
              Uma palavra da casa e o termo que o assistente já conhece. Ex.: “banca” →
              saldo_carteira.
            </p>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_110px]">
              <Input
                value={novoTermo}
                onChange={(e) => setNovoTermo(e.target.value)}
                placeholder="Palavra da casa (ex.: banca)"
                aria-label="Palavra da casa"
              />
              <Input
                value={novoCanonico}
                onChange={(e) => setNovoCanonico(e.target.value)}
                placeholder="Termo conhecido (ex.: saldo_carteira)"
                aria-label="Termo que o assistente conhece"
              />
              <select
                value={novoTipo}
                onChange={(e) => setNovoTipo(e.target.value)}
                aria-label="Tipo"
                className="h-10 rounded-lg border border-input bg-background px-2 text-body"
              >
                <option value="geral">Geral</option>
                <option value="campo">Dado do jogador</option>
                <option value="expert">Expert</option>
                <option value="periodo">Período</option>
              </select>
            </div>
            <DemoDisabledTooltip active={isDemo}>
              <Button size="sm" onClick={addSyn} disabled={isDemo}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Adicionar
              </Button>
            </DemoDisabledTooltip>
          </div>
          <div className="space-y-1 max-h-[440px] overflow-y-auto">
            {syns.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-lg border border-border/30 px-2 py-1.5 text-meta"
              >
                <Badge variant="outline" className="text-meta">
                  {s.tipo}
                </Badge>
                <span className="font-medium">{s.termo}</span>
                <span className="text-muted-foreground">→</span>
                <code className="text-success">{s.canonico}</code>
                <div className="ml-auto flex items-center gap-1">
                  <Switch
                    checked={s.ativo}
                    disabled={isDemo}
                    onCheckedChange={() => toggleSyn(s)}
                  />
                  <DemoDisabledTooltip active={isDemo}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Excluir sinônimo ${s.termo}`}
                      disabled={isDemo}
                      onClick={async () => {
                        const confirmed = await requestConfirmation({
                          title: "Excluir este sinônimo?",
                          description: `"${s.termo}" deixa de ser reconhecido como "${s.canonico}". Para só pausar, use a chave ao lado.`,
                          confirmLabel: "Excluir sinônimo",
                          destructive: true,
                        });
                        if (confirmed) void delSyn(s);
                      }}
                    >
                      <Trash2 className="h-3 w-3 text-danger" />
                    </Button>
                  </DemoDisabledTooltip>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// =================== FEEDBACK ===================
function FeedbackTab() {
  const isDemo = useIsDemoTenant();
  const [items, setItems] = useState<Feedback[]>([]);
  const [stats, setStats] = useState({ total: 0, good: 0, bad: 0 });

  async function load() {
    const { data } = await supabase
      .from("ai_feedback")
      .select("id,rating,motivo,created_at,ai_log_id,ai_logs(pergunta,resposta)")
      .order("created_at", { ascending: false })
      .limit(100);
    const list = (data as any) ?? [];
    setItems(list);
    const good = list.filter((x: Feedback) => x.rating === "good").length;
    const bad = list.filter((x: Feedback) => x.rating === "bad").length;
    setStats({ total: list.length, good, bad });
  }
  useEffect(() => {
    load();
  }, []);

  const aprov = stats.total ? Math.round((stats.good / stats.total) * 100) : 0;

  async function turnIntoExample(f: Feedback) {
    const q = f.ai_logs?.pergunta;
    if (!q) return toast.error("Sem pergunta vinculada");
    await supabase.from("ai_training_examples").insert({
      pergunta: q,
      resposta_ideal: f.motivo || "(preencher a resposta ideal)",
      fonte: "feedback",
      ai_log_id: f.ai_log_id,
      ativo: false,
    });
    toast.success("Rascunho criado em Exemplos — abra para editar e ativar");
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-label text-muted-foreground">Aprovação</p>
            <p className="text-kpi mt-1">{aprov}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-label text-muted-foreground">Respostas boas</p>
            <p className="text-kpi mt-1 text-success">{stats.good}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-label text-muted-foreground">Respostas ruins</p>
            <p className="text-kpi mt-1 text-danger">{stats.bad}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Avaliações recentes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {items.map((f) => (
            <div key={f.id} className="rounded-lg border border-border/40 p-3 text-meta">
              <div className="flex items-start gap-2">
                {f.rating === "good" ? (
                  <ThumbsUp className="h-3.5 w-3.5 text-success mt-0.5" />
                ) : (
                  <ThumbsDown className="h-3.5 w-3.5 text-danger mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{f.ai_logs?.pergunta ?? "—"}</p>
                  {f.motivo && <p className="text-muted-foreground mt-1">"{f.motivo}"</p>}
                </div>
                {f.rating === "bad" && (
                  <DemoDisabledTooltip active={isDemo}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => turnIntoExample(f)}
                      disabled={isDemo}
                    >
                      Criar exemplo
                    </Button>
                  </DemoDisabledTooltip>
                )}
              </div>
            </div>
          ))}
          {!items.length && (
            <p className="text-meta text-muted-foreground">
              {isDemo
                ? DEMO_EMPTY_STATE_TEXT
                : "Nenhuma avaliação ainda. Avalie as respostas no Assistente IA (👍 ou 👎)."}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
