import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Phone, Play, Pause, Plus, Trash2, MessageCircle, ExternalLink, Eye } from "lucide-react";
import { toast } from "sonner";
import {
  listPrecallCampaigns,
  createPrecallCampaign,
  setPrecallCampaignStatus,
  getPrecallCampaign,
  markPrecallLeadCalled,
  previewPrecallAudience,
} from "@/lib/precall.functions";
import { listWhatsappSessions } from "@/lib/whatsapp.functions";
import { DEFAULT_PRECALL_VIP_TEMPLATES, PRECALL_FILTERS } from "./default-templates";
import { MetricCard } from "@/components/ui-premium";

export function PrecallTab() {
  const list = useServerFn(listPrecallCampaigns);
  const { data, refetch } = useQuery({
    queryKey: ["precall-campaigns"],
    queryFn: () => list(),
    refetchInterval: 5000,
  });
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><Phone className="h-4 w-4" /> Pré-ligação</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Dispara um WhatsApp curto pedindo permissão pra ligar. Quem responder vira "ligar agora" pro gerente.
            </p>
          </div>
          <NewCampaignDialog onCreated={() => refetch()} />
        </CardHeader>
        <CardContent>
          {(data?.campaigns ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Nenhuma campanha ainda. Clique em "Nova campanha" pra começar.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Leads</TableHead>
                  <TableHead>Enviados</TableHead>
                  <TableHead>Responderam</TableHead>
                  <TableHead>Ligadas</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.campaigns.map((c: any) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.nome}</TableCell>
                    <TableCell><Badge variant="outline">{c.status}</Badge></TableCell>
                    <TableCell>{c.total_leads}</TableCell>
                    <TableCell>{c.enviados}</TableCell>
                    <TableCell className={c.respondidos > 0 ? "text-emerald-400 font-semibold" : ""}>{c.respondidos}</TableCell>
                    <TableCell>{c.ligacoes_feitas}</TableCell>
                    <TableCell className="text-right">
                      <CampaignActions campaign={c} onChange={() => refetch()} onOpen={() => setOpenId(c.id)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {openId && <CampaignDetailDialog id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function CampaignActions({ campaign, onChange, onOpen }: { campaign: any; onChange: () => void; onOpen: () => void }) {
  const setStatus = useServerFn(setPrecallCampaignStatus);
  const m = useMutation({
    mutationFn: (status: "rodando" | "pausada" | "cancelada") => setStatus({ data: { id: campaign.id, status } }),
    onSuccess: () => { toast.success("Status atualizado"); onChange(); },
    onError: (e: any) => toast.error(e?.message ?? "falha"),
  });
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="ghost" onClick={onOpen}><Eye className="h-4 w-4" /></Button>
      {campaign.status === "rascunho" || campaign.status === "pausada" ? (
        <Button size="sm" variant="default" onClick={() => m.mutate("rodando")} disabled={m.isPending}>
          <Play className="h-4 w-4 mr-1" /> Iniciar
        </Button>
      ) : campaign.status === "rodando" ? (
        <Button size="sm" variant="secondary" onClick={() => m.mutate("pausada")} disabled={m.isPending}>
          <Pause className="h-4 w-4 mr-1" /> Pausar
        </Button>
      ) : null}
      {campaign.status !== "cancelada" && campaign.status !== "concluida" && (
        <Button size="sm" variant="ghost" onClick={() => m.mutate("cancelada")} disabled={m.isPending}>
          Cancelar
        </Button>
      )}
    </div>
  );
}

function NewCampaignDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState("Pré-call VIP sem login");
  const [filtro, setFiltro] = useState<string>("vip_sem_login");
  const [sessionId, setSessionId] = useState<string>("");
  const [delayMin, setDelayMin] = useState(60);
  const [delayMax, setDelayMax] = useState(180);
  const [templates, setTemplates] = useState<string>(DEFAULT_PRECALL_VIP_TEMPLATES.join("\n---\n"));

  const listSess = useServerFn(listWhatsappSessions);
  const { data: sessions } = useQuery({
    queryKey: ["whatsapp-sessions-precall"],
    queryFn: () => listSess(),
    enabled: open,
  });
  const connectedSessions = ((sessions?.sessions ?? []) as any[]).filter((s) => s.status === "connected");

  const preview = useServerFn(previewPrecallAudience);
  const { data: previewData } = useQuery({
    queryKey: ["precall-audience-preview", filtro],
    queryFn: () => preview({ data: { filtro_id: filtro } }),
    enabled: open,
  });

  const createFn = useServerFn(createPrecallCampaign);
  const m = useMutation({
    mutationFn: () => {
      const tpls = templates.split(/\n-{3,}\n|\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean);
      if (!sessionId) throw new Error("escolha uma sessão WhatsApp conectada");
      if (tpls.length === 0) throw new Error("adicione pelo menos 1 template");
      return createFn({
        data: {
          nome,
          filtro_id: filtro,
          session_id: sessionId,
          delay_min_seconds: delayMin,
          delay_max_seconds: delayMax,
          templates: tpls,
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`Campanha criada com ${res.total_leads} leads`);
      setOpen(false);
      onCreated();
    },
    onError: (e: any) => toast.error(e?.message ?? "falha ao criar"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Nova campanha</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Nova campanha de pré-ligação</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Nome</Label>
            <Input value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Filtro de público</Label>
              <Select value={filtro} onValueChange={setFiltro}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRECALL_FILTERS.map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {PRECALL_FILTERS.find((f) => f.id === filtro)?.description}
              </p>
              <p className="text-xs mt-1">
                Leads encontrados: <strong>{previewData?.count ?? "…"}</strong>
              </p>
            </div>
            <div>
              <Label>Sessão WhatsApp</Label>
              <Select value={sessionId} onValueChange={setSessionId}>
                <SelectTrigger><SelectValue placeholder="Escolha uma sessão conectada" /></SelectTrigger>
                <SelectContent>
                  {connectedSessions.length === 0 && (
                    <SelectItem value="__none" disabled>Nenhuma sessão conectada</SelectItem>
                  )}
                  {connectedSessions.map((s: any) => (
                    <SelectItem key={s.id} value={s.id}>{s.name} ({s.phone_number ?? "—"})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Delay mínimo (s)</Label>
              <Input type="number" value={delayMin} onChange={(e) => setDelayMin(Number(e.target.value) || 60)} />
            </div>
            <div>
              <Label>Delay máximo (s)</Label>
              <Input type="number" value={delayMax} onChange={(e) => setDelayMax(Number(e.target.value) || 180)} />
            </div>
          </div>
          <div>
            <Label>Templates (separe cada mensagem com uma linha contendo só "---")</Label>
            <Textarea
              value={templates}
              onChange={(e) => setTemplates(e.target.value)}
              rows={12}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Variáveis: {"{primeiro_nome}, {nome}, {dias_sem_login}, {total_depositado}, {saldo}, {categoria}"}. O sistema sorteia 1 mensagem por lead.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>
            {m.isPending ? "Criando..." : "Criar campanha"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CampaignDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const get = useServerFn(getPrecallCampaign);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["precall-campaign", id],
    queryFn: () => get({ data: { id } }),
    refetchInterval: 3000,
  });
  const markCalled = useServerFn(markPrecallLeadCalled);
  const m = useMutation({
    mutationFn: (lead_id: string) => markCalled({ data: { lead_id } }),
    onSuccess: () => { toast.success("Marcado como ligado"); qc.invalidateQueries({ queryKey: ["precall-campaign", id] }); qc.invalidateQueries({ queryKey: ["precall-campaigns"] }); },
  });

  const c = data?.campaign;
  const leads = data?.leads ?? [];
  const cards = [
    { label: "Total", value: leads.length },
    { label: "Enviados", value: leads.filter((l) => l.status !== "pendente" && l.status !== "cancelado" && l.status !== "falhou").length },
    { label: "Responderam", value: leads.filter((l) => ["respondido", "ligar_agora", "ligado"].includes(l.status)).length },
    { label: "Aguardando", value: leads.filter((l) => l.status === "enviado").length },
    { label: "Falhas", value: leads.filter((l) => l.status === "falhou").length },
    { label: "Ligadas", value: leads.filter((l) => l.status === "ligado").length },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{c?.nome ?? "Campanha"} <Badge className="ml-2" variant="outline">{c?.status}</Badge></DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-4">
          {cards.map((k) => (
            <MetricCard key={k.label} label={k.label} value={String(k.value)} accent="primary" icon={<MessageCircle className="h-4 w-4" />} />
          ))}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Telefone</TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Dias s/login</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Enviado</TableHead>
              <TableHead>Respondeu?</TableHead>
              <TableHead className="text-right">Ação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((l) => (
              <TableRow key={l.id} className={l.status === "ligar_agora" ? "bg-emerald-500/10" : ""}>
                <TableCell className="font-medium">{l.nome ?? "—"}</TableCell>
                <TableCell className="font-mono text-xs">{l.telefone_e164}</TableCell>
                <TableCell>{l.categoria}</TableCell>
                <TableCell>{l.dias_sem_login ?? "—"}</TableCell>
                <TableCell>
                  {l.status === "ligar_agora" ? (
                    <Badge className="bg-emerald-500 text-white">Ligar agora</Badge>
                  ) : (
                    <Badge variant="outline">{l.status}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs">{l.sent_at ? new Date(l.sent_at).toLocaleTimeString("pt-BR") : "—"}</TableCell>
                <TableCell className="text-xs max-w-[200px] truncate" title={l.resposta_texto ?? ""}>
                  {l.resposta_texto ?? "—"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {(l.status === "ligar_agora" || l.status === "respondido") && (
                      <Button asChild size="sm" variant="default">
                        <a href={`tel:+${l.telefone_e164.replace(/\D/g, "")}`}><Phone className="h-3 w-3 mr-1" /> Ligar</a>
                      </Button>
                    )}
                    {l.status !== "ligado" && l.status !== "pendente" && (
                      <Button size="sm" variant="ghost" onClick={() => m.mutate(l.id)} disabled={m.isPending}>
                        Marcar ligado
                      </Button>
                    )}
                    {l.player_id && (
                      <Button asChild size="sm" variant="ghost">
                        <a href={`/players?id=${l.player_id}`}><ExternalLink className="h-3 w-3" /></a>
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  );
}