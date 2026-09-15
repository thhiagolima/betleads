import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Trash2, Plus, GraduationCap, ThumbsDown, ThumbsUp, Download } from "lucide-react";
import { PageHeader } from "@/components/ui-premium";

export const Route = createFileRoute("/treino-ia")({
  component: TreinoIA,
});

type Example = {
  id: string; pergunta: string; resposta_ideal: string;
  intent: string | null; tags: string[]; fonte: string; ativo: boolean;
  created_at: string;
};
type Intent = {
  id: string; nome: string; descricao: string | null; palavras_chave: string[];
  campo_alvo: string | null; operador: string | null; limite_padrao: number;
  prioridade: number; ativo: boolean;
};
type Synonym = {
  id: string; termo: string; canonico: string; tipo: string; ativo: boolean;
};
type Feedback = {
  id: string; rating: string; motivo: string | null; created_at: string;
  ai_log_id: string | null;
  ai_logs?: { pergunta: string; resposta: string } | null;
};
type LogRow = { id: string; pergunta: string; resposta: string; created_at: string };

function TreinoIA() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Treino da IA"
        subtitle="Ensine a IA com exemplos, regras e feedback — tudo refletido nas próximas respostas."
        icon={<GraduationCap className="h-5 w-5 text-primary-foreground" />}
      />
      <Tabs defaultValue="exemplos">
        <TabsList>
          <TabsTrigger value="exemplos">Exemplos</TabsTrigger>
          <TabsTrigger value="intents">Intents & Sinônimos</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
        </TabsList>
        <TabsContent value="exemplos"><ExemplosTab /></TabsContent>
        <TabsContent value="intents"><IntentsTab /></TabsContent>
        <TabsContent value="feedback"><FeedbackTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// =================== EXEMPLOS ===================
function ExemplosTab() {
  const [items, setItems] = useState<Example[]>([]);
  const [pergunta, setPergunta] = useState("");
  const [resposta, setResposta] = useState("");
  const [intent, setIntent] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [logs, setLogs] = useState<LogRow[]>([]);

  async function load() {
    const { data } = await supabase.from("ai_training_examples")
      .select("*").order("created_at", { ascending: false }).limit(200);
    setItems((data as Example[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!pergunta.trim() || !resposta.trim()) {
      return toast.error("Preencha a pergunta e a resposta ideal.");
    }
    const { error } = await supabase.from("ai_training_examples").insert({
      pergunta: pergunta.trim(), resposta_ideal: resposta.trim(),
      intent: intent.trim() || null, fonte: "manual", ativo: true,
    });
    if (error) return toast.error(error.message);
    toast.success("Exemplo cadastrado");
    setPergunta(""); setResposta(""); setIntent("");
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
    const { data } = await supabase.from("ai_logs")
      .select("id,pergunta,resposta,created_at")
      .order("created_at", { ascending: false }).limit(30);
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
        <CardHeader className="pb-3"><CardTitle className="text-sm">Novo exemplo</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-[1fr_180px] gap-2">
            <Input value={pergunta} onChange={(e) => setPergunta(e.target.value)} placeholder="Pergunta (ex: top 5 depositantes de hoje do Queiroz)" />
            <Input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Intent (opcional)" />
          </div>
          <Textarea value={resposta} onChange={(e) => setResposta(e.target.value)} rows={3} placeholder="Resposta ideal — pode usar markdown" />
          <div className="flex justify-between gap-2">
            <Button variant="outline" size="sm" onClick={openImport}><Download className="h-3.5 w-3.5 mr-1.5" />Importar do histórico</Button>
            <Button onClick={add}><Plus className="h-3.5 w-3.5 mr-1.5" />Salvar exemplo</Button>
          </div>
        </CardContent>
      </Card>

      {showImport && (
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Últimas perguntas feitas à IA</CardTitle>
            <Button size="sm" variant="ghost" onClick={() => setShowImport(false)}>Fechar</Button>
          </CardHeader>
          <CardContent className="space-y-1 max-h-72 overflow-y-auto">
            {logs.map((l) => (
              <button key={l.id} onClick={() => importFromLog(l)}
                className="w-full text-left p-2 rounded border border-border/40 hover:bg-muted/30 text-xs">
                <p className="font-medium truncate">{l.pergunta}</p>
                <p className="text-muted-foreground truncate">{l.resposta?.slice(0, 120)}</p>
              </button>
            ))}
            {!logs.length && <p className="text-xs text-muted-foreground">Nenhum log ainda.</p>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Exemplos cadastrados ({items.length})</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {items.map((it) => (
            <div key={it.id} className="rounded border border-border/40 p-3 space-y-1">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{it.pergunta}</p>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{it.resposta_ideal}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {it.intent && <Badge variant="outline" className="text-[10px]">{it.intent}</Badge>}
                    <Badge variant="secondary" className="text-[10px]">{it.fonte}</Badge>
                    {!it.ativo && <Badge variant="destructive" className="text-[10px]">inativo</Badge>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={it.ativo} onCheckedChange={() => toggle(it)} />
                  <Button size="icon" variant="ghost" onClick={() => remove(it)}>
                    <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {!items.length && <p className="text-xs text-muted-foreground">Nenhum exemplo ainda.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

// =================== INTENTS + SINÔNIMOS ===================
function IntentsTab() {
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
  useEffect(() => { load(); }, []);

  async function toggleIntent(i: Intent) {
    await supabase.from("ai_intents").update({ ativo: !i.ativo }).eq("id", i.id);
    load();
  }
  async function toggleSyn(s: Synonym) {
    await supabase.from("ai_synonyms").update({ ativo: !s.ativo }).eq("id", s.id);
    load();
  }
  async function addSyn() {
    if (!novoTermo.trim() || !novoCanonico.trim()) return toast.error("Preencha termo e canônico");
    await supabase.from("ai_synonyms").insert({
      termo: novoTermo.trim(), canonico: novoCanonico.trim(), tipo: novoTipo,
    });
    setNovoTermo(""); setNovoCanonico("");
    load();
  }
  async function delSyn(s: Synonym) {
    await supabase.from("ai_synonyms").delete().eq("id", s.id);
    load();
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Intents ({intents.length})</CardTitle></CardHeader>
        <CardContent className="space-y-2 max-h-[600px] overflow-y-auto">
          {intents.map((i) => (
            <div key={i.id} className="rounded border border-border/40 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <p className="text-sm font-medium">{i.nome}</p>
                  <p className="text-xs text-muted-foreground">{i.descricao}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {i.palavras_chave?.slice(0, 6).map((k, idx) => (
                      <Badge key={idx} variant="outline" className="text-[10px]">{k}</Badge>
                    ))}
                  </div>
                  {i.campo_alvo && (
                    <p className="text-[10px] text-muted-foreground mt-1.5">
                      campo: <code>{i.campo_alvo}</code> {i.operador && `(${i.operador})`} · limite {i.limite_padrao}
                    </p>
                  )}
                </div>
                <Switch checked={i.ativo} onCheckedChange={() => toggleIntent(i)} />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Sinônimos ({syns.length})</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2 p-3 rounded border border-border/40 bg-muted/20">
            <Label className="text-xs">Adicionar sinônimo</Label>
            <div className="grid grid-cols-[1fr_1fr_100px] gap-2">
              <Input value={novoTermo} onChange={(e) => setNovoTermo(e.target.value)} placeholder="banca" />
              <Input value={novoCanonico} onChange={(e) => setNovoCanonico(e.target.value)} placeholder="saldo_carteira" />
              <select value={novoTipo} onChange={(e) => setNovoTipo(e.target.value)}
                className="bg-background border border-input rounded-md px-2 text-sm">
                <option value="geral">geral</option>
                <option value="campo">campo</option>
                <option value="expert">expert</option>
                <option value="periodo">período</option>
              </select>
            </div>
            <Button size="sm" onClick={addSyn}><Plus className="h-3.5 w-3.5 mr-1" />Adicionar</Button>
          </div>
          <div className="space-y-1 max-h-[440px] overflow-y-auto">
            {syns.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-xs border border-border/30 rounded px-2 py-1.5">
                <Badge variant="outline" className="text-[10px]">{s.tipo}</Badge>
                <span className="font-medium">{s.termo}</span>
                <span className="text-muted-foreground">→</span>
                <code className="text-emerald-400">{s.canonico}</code>
                <div className="ml-auto flex items-center gap-1">
                  <Switch checked={s.ativo} onCheckedChange={() => toggleSyn(s)} />
                  <Button size="icon" variant="ghost" onClick={() => delSyn(s)}>
                    <Trash2 className="h-3 w-3 text-rose-400" />
                  </Button>
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
  const [items, setItems] = useState<Feedback[]>([]);
  const [stats, setStats] = useState({ total: 0, good: 0, bad: 0 });

  async function load() {
    const { data } = await supabase.from("ai_feedback")
      .select("id,rating,motivo,created_at,ai_log_id,ai_logs(pergunta,resposta)")
      .order("created_at", { ascending: false }).limit(100);
    const list = (data as any) ?? [];
    setItems(list);
    const good = list.filter((x: Feedback) => x.rating === "good").length;
    const bad = list.filter((x: Feedback) => x.rating === "bad").length;
    setStats({ total: list.length, good, bad });
  }
  useEffect(() => { load(); }, []);

  const aprov = stats.total ? Math.round((stats.good / stats.total) * 100) : 0;

  async function turnIntoExample(f: Feedback) {
    const q = f.ai_logs?.pergunta;
    if (!q) return toast.error("Sem pergunta vinculada");
    await supabase.from("ai_training_examples").insert({
      pergunta: q, resposta_ideal: f.motivo || "(preencher a resposta ideal)",
      fonte: "feedback", ai_log_id: f.ai_log_id, ativo: false,
    });
    toast.success("Rascunho criado em Exemplos — abra para editar e ativar");
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="p-4">
          <p className="text-[10px] uppercase text-muted-foreground">Aprovação</p>
          <p className="text-2xl font-bold mt-1">{aprov}%</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-[10px] uppercase text-muted-foreground">👍 Boas</p>
          <p className="text-2xl font-bold mt-1 text-emerald-400">{stats.good}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-[10px] uppercase text-muted-foreground">👎 Ruins</p>
          <p className="text-2xl font-bold mt-1 text-rose-400">{stats.bad}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Feedbacks recentes</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {items.map((f) => (
            <div key={f.id} className="rounded border border-border/40 p-3 text-xs">
              <div className="flex items-start gap-2">
                {f.rating === "good"
                  ? <ThumbsUp className="h-3.5 w-3.5 text-emerald-400 mt-0.5" />
                  : <ThumbsDown className="h-3.5 w-3.5 text-rose-400 mt-0.5" />}
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{f.ai_logs?.pergunta ?? "—"}</p>
                  {f.motivo && <p className="text-muted-foreground mt-1">"{f.motivo}"</p>}
                </div>
                {f.rating === "bad" && (
                  <Button size="sm" variant="outline" onClick={() => turnIntoExample(f)}>
                    Criar exemplo
                  </Button>
                )}
              </div>
            </div>
          ))}
          {!items.length && <p className="text-xs text-muted-foreground">Nenhum feedback ainda. Use 👍/👎 nas respostas da IA.</p>}
        </CardContent>
      </Card>
    </div>
  );
}