import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Trash2, UserCog } from "lucide-react";
import { PageHeader } from "@/components/ui-premium";

type Expert = {
  id: string;
  affiliate_id: string;
  nome: string;
  created_at: string;
  count?: number;
};

export const Route = createFileRoute("/experts")({
  component: ExpertsPage,
});

function ExpertsPage() {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [affId, setAffId] = useState("");
  const [nome, setNome] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    const { data } = await supabase
      .from("experts")
      .select("*")
      .order("nome");
    if (!data) return setExperts([]);
    // count players per affiliate
    const enriched = await Promise.all(
      data.map(async (e: Expert) => {
        const { count } = await supabase
          .from("players")
          .select("*", { count: "exact", head: true })
          .eq("affiliate_id", e.affiliate_id);
        return { ...e, count: count ?? 0 };
      }),
    );
    setExperts(enriched);
  }

  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!affId.trim() || !nome.trim()) return;
    setLoading(true);
    const { error } = await supabase
      .from("experts")
      .insert({ affiliate_id: affId.trim(), nome: nome.trim() });
    if (error) {
      toast.error(error.message);
    } else {
      // backfill players already in DB for this affiliate
      await supabase
        .from("players")
        .update({ expert: nome.trim() })
        .eq("affiliate_id", affId.trim());
      toast.success("Expert cadastrado");
      setAffId("");
      setNome("");
      load();
    }
    setLoading(false);
  }

  async function remove(id: string) {
    await supabase.from("experts").delete().eq("id", id);
    load();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Experts / Afiliados"
        subtitle="Mapeie IDs de afiliados às pessoas responsáveis. Novos cadastros são atribuídos automaticamente."
        icon={<UserCog className="h-5 w-5 text-primary-foreground" />}
      />

      <Card>
        <CardHeader>
          <CardTitle>Adicionar expert</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={add} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
            <div className="space-y-1">
              <Label>ID do afiliado</Label>
              <Input
                value={affId}
                onChange={(e) => setAffId(e.target.value)}
                placeholder="ex: 69cde3d75779177c6fed3c7c"
              />
            </div>
            <div className="space-y-1">
              <Label>Nome do expert</Label>
              <Input
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="ex: Queiroz"
              />
            </div>
            <Button type="submit" disabled={loading}>
              Adicionar
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cadastrados ({experts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {experts.map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-3"
              >
                <div className="min-w-0">
                  <div className="font-medium">{e.nome}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {e.affiliate_id}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">
                    {e.count ?? 0} players
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => remove(e.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
            {experts.length === 0 && (
              <p className="text-sm text-muted-foreground">Nenhum expert cadastrado.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}