import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Send,
  Paperclip,
  Mic,
  Search,
  FileText,
  X,
  Check,
  CheckCheck,
  Clock,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/ui-premium";
import { MessageCircle } from "lucide-react";
import { toast } from "sonner";
import {
  listInboxChats,
  listChatMessages,
  sendWhatsappMessage,
  sendWhatsappImage,
  sendWhatsappVideo,
  sendWhatsappDocument,
  sendWhatsappAudio,
  refreshGroupNames,
  refreshContactNames,
  getLeadProfileByPhone,
} from "@/lib/whatsapp.functions";
import {
  listRecentFollowupKeys,
  markConversionOutcome,
} from "@/lib/pending-conversion.functions";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MAX_BYTES = 12 * 1024 * 1024; // 12MB

type Chat = {
  id: string;
  session_id: string;
  remote_jid: string;
  phone: string | null;
  name: string | null;
  is_group: boolean;
  unread_count: number;
  last_message: string | null;
  last_message_at: string | null;
  profile_pic_url: string | null;
  session_name: string | null;
  orphaned?: boolean;
  last_message_from_me?: boolean;
  pending_count?: number;
};

type Msg = {
  id: string;
  from_me: boolean;
  message_type: string;
  text: string | null;
  media_url: string | null;
  media_mimetype: string | null;
  media_filename: string | null;
  media_size: number | null;
  media_duration: number | null;
  message_timestamp: string;
  status: string | null;
  sender_name?: string | null;
};

function initials(s: string) {
  return s
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function fmtDayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Hoje";
  if (d.toDateString() === y.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR");
}

function fmtBytes(n: number | null) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDuration(sec: number | null) {
  if (!sec) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function fileToBase64(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

function kindOf(mimetype: string): "image" | "video" | "audio" | "document" {
  const clean = cleanMimetype(mimetype);
  if (clean.startsWith("image/")) return "image";
  if (clean.startsWith("video/")) return "video";
  if (clean.startsWith("audio/")) return "audio";
  return "document";
}

function cleanMimetype(mimetype: string) {
  return mimetype.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function audioExtension(mimetype: string) {
  const clean = cleanMimetype(mimetype);
  if (clean === "audio/ogg" || clean === "audio/opus") return "ogg";
  if (clean === "audio/webm") return "webm";
  if (clean === "audio/mpeg") return "mp3";
  if (clean === "audio/mp4" || clean === "audio/aac") return "m4a";
  if (clean === "audio/wav" || clean === "audio/x-wav") return "wav";
  return "audio";
}

function normalizeAudioFilename(filename: string, mimetype: string) {
  const ext = audioExtension(mimetype);
  const base = filename.replace(/\.[^/.]+$/, "") || "audio";
  return `${base}.${ext}`;
}

function sessionChipClass(id: string): string {
  const palette = [
    "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    "bg-sky-500/15 text-sky-300 border-sky-500/30",
    "bg-violet-500/15 text-violet-300 border-violet-500/30",
    "bg-amber-500/15 text-amber-300 border-amber-500/30",
    "bg-rose-500/15 text-rose-300 border-rose-500/30",
    "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function brl(v: number | null | undefined) {
  if (v == null || Number.isNaN(Number(v))) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));
}

const TRIGGER_LABEL: Record<string, string> = {
  dinheiro_parado: "Dinheiro parado",
  recuperacao_vip: "Recuperação VIP",
  frequencia_de_queda: "Frequência de queda",
  lead_quente_esfriando: "Lead quente esfriando",
  receita_em_queda: "Receita em queda",
  vip_esfriando: "VIP esfriando",
  quase_vip: "Quase VIP",
  alto_potencial: "Alto potencial",
  reativacao_em_curso: "Reativação em curso",
  engajado_sem_conversao: "Engajado sem conversão",
  cadastrados_sem_deposito: "Cadastrados sem depósito",
  sem_login_7_14: "7 a 14 dias sem login",
  sem_login_15_24: "15 a 24 dias sem login",
  sem_login_25_34: "25 a 34 dias sem login",
  sem_login_35_44: "35 a 44 dias sem login",
  sem_login_45_59: "45 a 59 dias sem login",
  sem_login_60_mais: "60+ dias sem login",
};

export function WhatsappInbox({ openChatId }: { openChatId?: string } = {}) {
  const qc = useQueryClient();
  const listChatsFn = useServerFn(listInboxChats);
  const listMsgsFn = useServerFn(listChatMessages);
  const sendTextFn = useServerFn(sendWhatsappMessage);
  const sendImageFn = useServerFn(sendWhatsappImage);
  const sendVideoFn = useServerFn(sendWhatsappVideo);
  const sendDocumentFn = useServerFn(sendWhatsappDocument);
  const sendAudioFn = useServerFn(sendWhatsappAudio);
  const refreshGroupNamesFn = useServerFn(refreshGroupNames);
  const refreshContactNamesFn = useServerFn(refreshContactNames);

  // Ao montar o Inbox, dispara em segundo plano a "cura" dos nomes de grupo
  // que possam ter ficado errados (legado: nome do participante em vez do grupo).
  useEffect(() => {
    refreshGroupNamesFn()
      .then((r) => {
        if (r?.updated && r.updated > 0) {
          qc.invalidateQueries({ queryKey: ["inbox-chats"] });
        }
      })
      .catch(() => {});
    refreshContactNamesFn()
      .then((r) => {
        if (r?.updated && r.updated > 0) {
          qc.invalidateQueries({ queryKey: ["inbox-chats"] });
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: chatsData, isLoading: chatsLoading } = useQuery({
    queryKey: ["inbox-chats"],
    queryFn: () => listChatsFn(),
    refetchInterval: 15000,
  });
  const chats = (chatsData?.chats ?? []) as Chat[];
  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"chats" | "groups">("chats");
  const [sessionFilter, setSessionFilter] = useState<string>("all");

  useEffect(() => {
    if (!activeId && chats.length > 0) setActiveId(chats[0].id);
  }, [chats, activeId]);

  // Deep-link: abrir conversa específica quando vier por query param
  useEffect(() => {
    if (openChatId && chats.some((c) => c.id === openChatId)) {
      setActiveId(openChatId);
      const chat = chats.find((c) => c.id === openChatId);
      if (chat) setTab(chat.is_group ? "groups" : "chats");
    }
  }, [openChatId, chats]);

  const activeChat = chats.find((c) => c.id === activeId) ?? null;

  const filteredChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    let byTab = chats.filter((c) => (tab === "groups" ? c.is_group : !c.is_group));
    if (sessionFilter !== "all") {
      byTab = byTab.filter((c) => c.session_id === sessionFilter);
    }
    if (!q) return byTab;
    return byTab.filter(
      (c) =>
        (c.name ?? "").toLowerCase().includes(q) ||
        (c.phone ?? "").includes(q) ||
        (c.last_message ?? "").toLowerCase().includes(q),
    );
  }, [chats, search, tab, sessionFilter]);

  // Lista única de sessões representadas nos chats — para o seletor
  const sessionOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of chats) {
      if (!map.has(c.session_id)) {
        map.set(c.session_id, c.session_name ?? "WhatsApp");
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [chats]);

  const { data: msgsData } = useQuery({
    queryKey: ["inbox-messages", activeId],
    queryFn: () =>
      activeId
        ? listMsgsFn({ data: { chat_id: activeId } })
        : Promise.resolve({ messages: [] as Msg[] }),
    enabled: !!activeId,
    refetchInterval: 5000,
  });
  const messages = (msgsData?.messages ?? []) as Msg[];

  // ===== Perfil do lead (player + último gatilho) =====
  const getLeadProfileFn = useServerFn(getLeadProfileByPhone);
  const activePhone = activeChat?.phone ?? null;
  const { data: profileData } = useQuery({
    queryKey: ["inbox-lead-profile", activePhone],
    queryFn: () =>
      activePhone
        ? getLeadProfileFn({ data: { phone: activePhone } })
        : Promise.resolve({ player: null, lastTrigger: null }),
    enabled: !!activePhone && !activeChat?.is_group,
    staleTime: 60_000,
  });
  const leadPlayer = profileData?.player ?? null;
  const leadTrigger = profileData?.lastTrigger ?? null;

  // ===== Desfecho de conversão (botões Converteu / Não converteu) =====
  const fetchFollowupKeys = useServerFn(listRecentFollowupKeys);
  const { data: followupKeysData } = useQuery({
    queryKey: ["inbox-followup-keys"],
    queryFn: () => fetchFollowupKeys(),
    enabled: !!leadPlayer?.id,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const pendingAlertasForLead = useMemo<string[]>(() => {
    if (!leadPlayer?.id) return [];
    const out: string[] = [];
    for (const k of followupKeysData?.keys ?? []) {
      const [pid, tipo] = k.split(":");
      if (pid === leadPlayer.id) out.push(tipo);
    }
    return out;
  }, [followupKeysData, leadPlayer]);
  const hasPendingOutcome = pendingAlertasForLead.length > 0;
  const markOutcomeFn = useServerFn(markConversionOutcome);
  const [outcomeBusy, setOutcomeBusy] = useState(false);

  async function handleOutcome(converted: boolean) {
    if (!leadPlayer?.id || outcomeBusy) return;
    // Marca todos os alerta_tipo pendentes do lead. Se não houver pendência
    // mas o gerente quiser registrar mesmo assim, usa o último gatilho ou
    // um alerta_tipo genérico "whatsapp".
    const tipos = pendingAlertasForLead.length > 0
      ? pendingAlertasForLead
      : [leadTrigger?.trigger_type ?? "whatsapp"];
    setOutcomeBusy(true);
    try {
      for (const alerta_tipo of tipos) {
        await markOutcomeFn({
          data: { player_id: leadPlayer.id, alerta_tipo, converted },
        });
      }
      toast.success(converted ? "Marcado como convertido" : "Marcado como sem resposta");
      qc.invalidateQueries({ queryKey: ["inbox-followup-keys"] });
      qc.invalidateQueries({ queryKey: ["players-recent-followup-keys"] });
      qc.invalidateQueries({ queryKey: ["players-pending-conversion"] });
      qc.invalidateQueries({ queryKey: ["players-converted"] });
      qc.invalidateQueries({ queryKey: ["players-not-converted"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao registrar desfecho");
    } finally {
      setOutcomeBusy(false);
    }
  }

  // ===== Optimistic outbound messages (per chat) =====
  // Bolhas que aparecem na hora do clique, antes do servidor confirmar.
  // Persistem em estado local pra sobreviver a refetch da query.
  const [pendingByChat, setPendingByChat] = useState<Record<string, Msg[]>>({});
  const objectUrlsRef = useRef<Set<string>>(new Set());

  const addPending = (chatId: string, msg: Msg) => {
    if (msg.media_url && msg.media_url.startsWith("blob:")) {
      objectUrlsRef.current.add(msg.media_url);
    }
    setPendingByChat((prev) => ({
      ...prev,
      [chatId]: [...(prev[chatId] ?? []), msg],
    }));
  };

  const updatePending = (chatId: string, id: string, patch: Partial<Msg>) => {
    setPendingByChat((prev) => ({
      ...prev,
      [chatId]: (prev[chatId] ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  };

  const removePending = (chatId: string, id: string) => {
    setPendingByChat((prev) => {
      const list = prev[chatId] ?? [];
      const target = list.find((m) => m.id === id);
      if (target?.media_url && objectUrlsRef.current.has(target.media_url)) {
        URL.revokeObjectURL(target.media_url);
        objectUrlsRef.current.delete(target.media_url);
      }
      return { ...prev, [chatId]: list.filter((m) => m.id !== id) };
    });
  };

  // Reconciliação: quando uma mensagem real (from_me) chega via realtime/refetch
  // e bate com uma tmp, descartamos a tmp.
  useEffect(() => {
    if (!activeId) return;
    const pending = pendingByChat[activeId];
    if (!pending || pending.length === 0) return;
    const realOutbound = messages.filter((m) => m.from_me && !m.id.startsWith("tmp-"));
    if (realOutbound.length === 0) return;
    const toDrop: string[] = [];
    for (const t of pending) {
      const tTime = new Date(t.message_timestamp).getTime();
      const match = realOutbound.find((r) => {
        if (r.message_type !== t.message_type) return false;
        const rTime = new Date(r.message_timestamp).getTime();
        if (Math.abs(rTime - tTime) > 5 * 60_000) return false;
        if (t.message_type === "text") return (r.text ?? "") === (t.text ?? "");
        return (
          (t.media_filename && r.media_filename === t.media_filename) ||
          (t.text && r.text === t.text)
        );
      });
      if (match) toDrop.push(t.id);
    }
    if (toDrop.length > 0) {
      toDrop.forEach((id) => removePending(activeId, id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeId]);

  // Cleanup global de object URLs ao desmontar
  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      objectUrlsRef.current.clear();
    };
  }, []);

  // Lista final exibida: reais + tmp pendentes, ordenadas por timestamp
  const displayMessages = useMemo(() => {
    const pending = activeId ? pendingByChat[activeId] ?? [] : [];
    if (pending.length === 0) return messages;
    return [...messages, ...pending].sort((a, b) =>
      a.message_timestamp.localeCompare(b.message_timestamp),
    );
  }, [messages, pendingByChat, activeId]);

  // Realtime
  useEffect(() => {
    const ch = supabase
      .channel("whatsapp-inbox-v2")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_messages" },
        () => {
          qc.invalidateQueries({ queryKey: ["inbox-chats"] });
          qc.invalidateQueries({ queryKey: ["inbox-messages"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_chats" },
        () => qc.invalidateQueries({ queryKey: ["inbox-chats"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  // Auto scroll
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [displayMessages.length, activeId]);

  const sendTextMut = useMutation({
    mutationFn: (vars: { chatId: string; text: string; tmpId: string }) =>
      sendTextFn({ data: { chat_id: vars.chatId, text: vars.text } }),
    onSuccess: (_data, vars) => {
      updatePending(vars.chatId, vars.tmpId, { status: "sent" });
      qc.invalidateQueries({ queryKey: ["inbox-messages", vars.chatId] });
      qc.invalidateQueries({ queryKey: ["inbox-chats"] });
    },
    onError: (e: any, vars) => {
      removePending(vars.chatId, vars.tmpId);
      if (activeId === vars.chatId) setDraft(vars.text);
      toast.error(e?.message ?? "Falha ao enviar");
    },
  });

  const sendMediaMut = useMutation({
    mutationFn: async (vars: {
      chatId: string;
      tmpId: string;
      payload: {
        base64: string;
        mimetype: string;
        filename: string;
        kind: "image" | "video" | "audio" | "document";
        caption?: string;
      };
    }) => {
      const payload = vars.payload;
      const request = {
        data: {
          chat_id: vars.chatId,
          base64: payload.base64,
          mimetype: payload.mimetype,
          filename: payload.filename,
          kind: payload.kind,
          caption: payload.caption ?? null,
        },
      };
      if (payload.kind === "image") return sendImageFn(request);
      if (payload.kind === "video") return sendVideoFn(request);
      if (payload.kind === "audio") return sendAudioFn(request);
      return sendDocumentFn(request);
    },
    onSuccess: (_data, vars) => {
      updatePending(vars.chatId, vars.tmpId, { status: "sent" });
      qc.invalidateQueries({ queryKey: ["inbox-messages", vars.chatId] });
      qc.invalidateQueries({ queryKey: ["inbox-chats"] });
    },
    onError: (e: any, vars) => {
      removePending(vars.chatId, vars.tmpId);
      toast.error(e?.message ?? "Falha ao enviar mídia");
    },
  });

  const handleSendText = () => {
    if (!activeId) return;
    const text = draft.trim();
    if (!text) return;
    const tmpId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    addPending(activeId, {
      id: tmpId,
      from_me: true,
      message_type: "text",
      text,
      media_url: null,
      media_mimetype: null,
      media_filename: null,
      media_size: null,
      media_duration: null,
      message_timestamp: now,
      status: "sending",
    });
    setDraft("");
    sendTextMut.mutate({ chatId: activeId, text, tmpId });
  };

  const handleSendMedia = (p: {
    base64: string;
    mimetype: string;
    filename: string;
    kind: "image" | "video" | "audio" | "document";
    caption?: string;
    previewUrl?: string; // blob: URL para preview imediato
  }) => {
    if (!activeId) return;
    const tmpId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    addPending(activeId, {
      id: tmpId,
      from_me: true,
      message_type: p.kind,
      text: p.caption ?? null,
      media_url: p.previewUrl ?? null,
      media_mimetype: p.mimetype,
      media_filename: p.filename,
      media_size: null,
      media_duration: null,
      message_timestamp: now,
      status: "sending",
    });
    sendMediaMut.mutate({
      chatId: activeId,
      tmpId,
      payload: {
        base64: p.base64,
        mimetype: p.mimetype,
        filename: p.filename,
        kind: p.kind,
        caption: p.caption,
      },
    });
  };

  // Agrupar mensagens por dia
  const groups = useMemo(() => {
    const out: { day: string; items: Msg[] }[] = [];
    for (const m of displayMessages) {
      const day = fmtDayLabel(m.message_timestamp);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(m);
      else out.push({ day, items: [m] });
    }
    return out;
  }, [displayMessages]);

  return (
    <div className="h-full overflow-hidden border-t border-border bg-card">
      <div className="grid grid-cols-1 md:grid-cols-[300px_1fr] lg:grid-cols-[320px_1fr_280px] h-full min-h-0">
        {/* Sidebar */}
        <aside className="border-r border-border flex flex-col min-h-0 bg-background/40">
          <div className="p-3.5 border-b border-border space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold tracking-tight">Conversas</span>
              <span className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/60 animate-pulse" />
                tempo real
              </span>
            </div>
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar conversa…"
                className="h-9 pl-9 text-sm rounded-md"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-5 w-5 rounded-full hover:bg-muted flex items-center justify-center text-muted-foreground"
                  aria-label="Limpar busca"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <Tabs value={tab} onValueChange={(v) => setTab(v as "chats" | "groups")}>
              <TabsList className="grid w-full grid-cols-2 h-8 bg-muted/40 p-0.5">
                <TabsTrigger value="chats" className="text-xs data-[state=active]:bg-card data-[state=active]:shadow-sm">Conversas</TabsTrigger>
                <TabsTrigger value="groups" className="text-xs data-[state=active]:bg-card data-[state=active]:shadow-sm">Grupos</TabsTrigger>
              </TabsList>
            </Tabs>
            {sessionOptions.length > 1 && (
              <Select value={sessionFilter} onValueChange={setSessionFilter}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as sessões</SelectItem>
                  {sessionOptions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <ScrollArea className="flex-1">
            {chatsLoading ? (
              <div className="p-3 space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex gap-3 p-2 animate-pulse">
                    <div className="h-10 w-10 rounded-full bg-muted/60" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 bg-muted/60 rounded w-3/4" />
                      <div className="h-2.5 bg-muted/40 rounded w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredChats.length === 0 ? (
              <EmptyState
                icon={<MessageCircle className="h-6 w-6" />}
                title="Nenhuma conversa"
                description="Envie ou receba algo no WhatsApp conectado — aparece aqui em tempo real."
                className="py-8"
              />
            ) : (
              filteredChats.map((c) => {
                const name = c.name || c.phone || c.remote_jid;
                const isActive = activeId === c.id;
                // pending_count já vem do backend: conta mensagens inbound
                // seguidas sem resposta, com fallback para o unread_count
                // nativo do WhatsApp. É a fonte única da bolinha.
                const unread = c.pending_count ?? 0;
                return (
                  <button
                    key={c.id}
                    onClick={() => setActiveId(c.id)}
                    className={`relative w-full text-left px-3 py-2.5 flex gap-3 border-b border-border/40 hover:bg-muted/30 transition-colors ${
                      isActive
                        ? "bg-primary/8 before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-8 before:w-[3px] before:rounded-r-full before:bg-primary before:shadow-[0_0_8px] before:shadow-primary/60"
                        : ""
                    }`}
                  >
                    <ChatAvatar name={name} url={c.profile_pic_url} size={44} />
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-baseline gap-2">
                        <span className={`text-sm truncate ${unread > 0 ? "font-bold" : "font-semibold"}`}>{name}</span>
                        <span className={`text-[10px] shrink-0 font-medium ${unread > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                          {c.last_message_at ? fmtTime(c.last_message_at) : ""}
                        </span>
                      </div>
                      {c.session_name && (
                        <span
                          className={`inline-block mt-0.5 text-[9px] px-1.5 py-0 rounded border ${sessionChipClass(c.session_id)}`}
                        >
                          {c.session_name}
                        </span>
                      )}
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 mt-0.5">
                        <p className={`text-xs truncate min-w-0 ${unread > 0 ? "text-foreground font-medium" : "text-muted-foreground/80"}`}>
                          {c.last_message ?? "—"}
                        </p>
                        {unread > 0 ? (
                          <Badge
                            className="h-5 min-w-[20px] px-1.5 text-[11px] font-semibold rounded-full bg-emerald-500 hover:bg-emerald-500 text-white shrink-0 flex items-center justify-center shadow-[0_0_6px] shadow-emerald-500/50"
                            title="Mensagens não lidas"
                          >
                            {unread > 99 ? "99+" : unread}
                          </Badge>
                        ) : (
                          <span className="w-0" />
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </ScrollArea>
        </aside>

        {/* Chat */}
        <section className="flex flex-col h-full min-h-0 min-w-0 overflow-hidden bg-[radial-gradient(circle_at_30%_20%,rgba(16,185,129,0.04),transparent_60%),radial-gradient(circle_at_80%_80%,rgba(20,184,166,0.04),transparent_55%)]">
          {!activeChat ? (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                icon={<MessageCircle className="h-7 w-7" />}
                title="Selecione uma conversa"
                description="Escolha uma conversa na lista para começar a responder."
              />
            </div>
          ) : (
            <>
              {/* Header */}
              <header className="sticky top-0 z-10 px-4 py-3 border-b border-border bg-background/80 backdrop-blur-md flex items-center gap-3">
                <ChatAvatar
                  name={activeChat.name || activeChat.phone || activeChat.remote_jid}
                  url={activeChat.profile_pic_url}
                  size={40}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold tracking-tight truncate">
                    {activeChat.name || activeChat.phone}
                  </div>
                  {!activeChat.is_group && (
                    <div className="text-[11px] text-muted-foreground truncate">
                      {activeChat.phone ?? activeChat.remote_jid}
                    </div>
                  )}
                  {activeChat.is_group && (
                    <div className="text-[11px] text-muted-foreground truncate">Grupo</div>
                  )}
                </div>
                {activeChat.session_name && (
                  <span
                    className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border font-medium ${sessionChipClass(activeChat.session_id)}`}
                  >
                    {activeChat.session_name}
                  </span>
                )}
              </header>

              {/* Mensagens */}
              <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
                {groups.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-8">
                    Sem mensagens nesta conversa.
                  </p>
                )}
                {groups.map((g) => (
                  <div key={g.day} className="space-y-1.5">
                    <div className="flex justify-center">
                      <span className="text-[10px] uppercase tracking-wider font-medium px-2.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground border border-border/40">
                        {g.day}
                      </span>
                    </div>
                    {g.items.map((m) => (
                      <MessageBubble
                        key={m.id}
                        m={m}
                        showSender={activeChat.is_group && !m.from_me}
                      />
                    ))}
                  </div>
                ))}
              </div>

              {/* Composer */}
              <Composer
                draft={draft}
                setDraft={setDraft}
                onSendText={handleSendText}
                onSendMedia={handleSendMedia}
              />
            </>
          )}
        </section>

        {/* Painel do lead — só em ≥lg */}
        {activeChat && (
          <aside className="hidden lg:flex flex-col border-l border-border bg-background/40 min-h-0">
            <div className="p-5 border-b border-border flex flex-col items-center text-center">
              <ChatAvatar
                name={activeChat.name || activeChat.phone || activeChat.remote_jid}
                url={activeChat.profile_pic_url}
                size={72}
              />
              <div className="mt-3 text-sm font-semibold tracking-tight truncate max-w-full">
                {activeChat.name || activeChat.phone}
              </div>
              {activeChat.phone && (
                <div className="text-xs text-muted-foreground mt-0.5">{activeChat.phone}</div>
              )}
              {activeChat.session_name && (
                <span
                  className={`mt-2 inline-block text-[10px] px-2 py-0.5 rounded-full border font-medium ${sessionChipClass(activeChat.session_id)}`}
                >
                  {activeChat.session_name}
                </span>
              )}
            </div>
            <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
                  Informações
                </div>
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Tipo</dt>
                    <dd className="font-medium">{activeChat.is_group ? "Grupo" : "Contato"}</dd>
                  </div>
                  {activeChat.phone && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Telefone</dt>
                      <dd className="font-medium truncate">{activeChat.phone}</dd>
                    </div>
                  )}
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Mensagens</dt>
                    <dd className="font-medium">{messages.length}</dd>
                  </div>
                  {activeChat.unread_count > 0 && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Não lidas</dt>
                      <dd className="font-medium text-emerald-400">{activeChat.unread_count}</dd>
                    </div>
                  )}
                </dl>
              </div>

              {leadPlayer && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
                    Dados do lead
                  </div>
                  <dl className="space-y-1.5 text-xs">
                    {leadPlayer.nome && (
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Nome</dt>
                        <dd className="font-medium truncate">{leadPlayer.nome}</dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Categoria</dt>
                      <dd className="font-medium">{leadPlayer.vip ? "VIP" : "Regular"}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Saldo</dt>
                      <dd className="font-medium">{brl(leadPlayer.saldo_carteira)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Depositado</dt>
                      <dd className="font-medium text-emerald-400">{brl(leadPlayer.total_depositado)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Sacado</dt>
                      <dd className="font-medium text-rose-400">{brl(leadPlayer.total_sacado)}</dd>
                    </div>
                    <div className="flex justify-between gap-2 pt-1 border-t border-border/40">
                      <dt className="text-muted-foreground">Lucro</dt>
                      <dd className={`font-semibold ${
                        Number(leadPlayer.total_depositado ?? 0) - Number(leadPlayer.total_sacado ?? 0) >= 0
                          ? "text-emerald-300"
                          : "text-rose-300"
                      }`}>
                        {brl(
                          Number(leadPlayer.total_depositado ?? 0) -
                            Number(leadPlayer.total_sacado ?? 0),
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>
              )}

              {leadTrigger && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
                    Último gatilho
                  </div>
                  <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 p-2.5">
                    <div className="text-xs font-semibold text-violet-200">
                      {leadTrigger.rule_name ??
                        TRIGGER_LABEL[leadTrigger.trigger_type] ??
                        leadTrigger.trigger_type}
                    </div>
                    {leadTrigger.rule_name && (
                      <div className="text-[10px] text-violet-300/70 mt-0.5">
                        {TRIGGER_LABEL[leadTrigger.trigger_type] ?? leadTrigger.trigger_type}
                      </div>
                    )}
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {new Date(leadTrigger.fired_at).toLocaleString("pt-BR")}
                    </div>
                  </div>
                </div>
              )}

              {!leadPlayer && activeChat.phone && !activeChat.is_group && (
                <div className="text-[11px] text-muted-foreground italic">
                  Este número não está vinculado a nenhum player da base.
                </div>
              )}

              {leadPlayer && !activeChat.is_group && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
                    Desfecho do contato
                  </div>
                  {hasPendingOutcome ? (
                    <div className="mb-2 text-[10px] text-sky-300">
                      ⏳ Aguardando desfecho ({pendingAlertasForLead.length} alerta{pendingAlertasForLead.length > 1 ? "s" : ""})
                    </div>
                  ) : (
                    <div className="mb-2 text-[10px] text-muted-foreground">
                      Registre o resultado da conversa.
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={outcomeBusy}
                      onClick={() => handleOutcome(true)}
                      className="flex-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      ✅ Converteu
                    </button>
                    <button
                      type="button"
                      disabled={outcomeBusy}
                      onClick={() => handleOutcome(false)}
                      className="flex-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                    >
                      ❌ Não converteu
                    </button>
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

// ============================================================
// BUBBLE
// ============================================================
function ChatAvatar({
  name,
  url,
  size = 40,
}: {
  name: string;
  url: string | null;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);
  const dim = { height: size, width: size };
  if (url && !errored) {
    return (
      <img
        src={url}
        alt={name}
        loading="lazy"
        onError={() => setErrored(true)}
        style={dim}
        className="shrink-0 rounded-full object-cover bg-muted"
      />
    );
  }
  return (
    <div
      style={dim}
      className="shrink-0 rounded-full bg-gradient-to-br from-emerald-500/40 to-teal-700/40 flex items-center justify-center text-xs font-semibold text-emerald-100"
    >
      {initials(name)}
    </div>
  );
}

function MessageBubble({ m, showSender }: { m: Msg; showSender?: boolean }) {
  const mine = m.from_me;
  // Cor estável por nome (estilo WhatsApp): hash simples → paleta fixa
  const senderColor = (() => {
    const palette = [
      "text-emerald-300",
      "text-sky-300",
      "text-amber-300",
      "text-pink-300",
      "text-violet-300",
      "text-orange-300",
      "text-teal-300",
      "text-rose-300",
    ];
    const name = m.sender_name ?? "";
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  })();
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
          mine
            ? "bg-gradient-to-br from-primary/25 to-primary/15 border border-primary/20 text-foreground rounded-br-md"
            : "bg-card/80 backdrop-blur-sm border border-border rounded-bl-md"
        }`}
      >
        {showSender && m.sender_name && (
          <div className={`text-[11px] font-semibold mb-0.5 ${senderColor}`}>
            {m.sender_name}
          </div>
        )}
        <MessageBody m={m} />
        <div
          className={`flex items-center gap-1 mt-1 text-[10px] ${
            mine ? "text-emerald-200/70 justify-end" : "text-muted-foreground/70"
          }`}
        >
          <span>{fmtTime(m.message_timestamp)}</span>
          {mine &&
            (m.status === "sending" ? (
              <Clock className="h-3 w-3 opacity-70" />
            ) : m.status === "READ" ? (
              <CheckCheck className="h-3 w-3 text-sky-400" />
            ) : m.status === "DELIVERY_ACK" ? (
              <CheckCheck className="h-3 w-3" />
            ) : (
              <Check className="h-3 w-3" />
            ))}
        </div>
      </div>
    </div>
  );
}

function MessageBody({ m }: { m: Msg }) {
  if (m.message_type === "image" && m.media_url) {
    return (
      <div className="space-y-1.5">
        <a href={m.media_url} target="_blank" rel="noreferrer">
          <img
            src={m.media_url}
            alt={m.media_filename ?? ""}
            loading="lazy"
            className="rounded-lg max-h-72 object-cover"
          />
        </a>
        {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
      </div>
    );
  }
  if (m.message_type === "video" && m.media_url) {
    return (
      <div className="space-y-1.5">
        <video src={m.media_url} controls className="rounded-lg max-h-72 max-w-full" />
        {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
      </div>
    );
  }
  if (m.message_type === "audio" && m.media_url) {
    return (
      <WhatsappAudio
        messageId={m.id}
        src={m.media_url}
        mimetype={m.media_mimetype}
        durationHint={m.media_duration}
      />
    );
  }
  if (m.message_type === "document" && m.media_url) {
    return (
      <a
        href={m.media_url}
        download={m.media_filename ?? undefined}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2.5 min-w-[200px]"
      >
        <div className="h-9 w-9 rounded bg-background/40 flex items-center justify-center">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium truncate">{m.media_filename ?? "Documento"}</div>
          <div className="text-[10px] opacity-70">{fmtBytes(m.media_size)}</div>
        </div>
      </a>
    );
  }
  if (m.text) return <p className="whitespace-pre-wrap break-words">{m.text}</p>;
  return <p className="opacity-60 italic">[{m.message_type}]</p>;
}

// WhatsApp PTT audio (OGG/Opus) frequently ships without seekable duration
// metadata. Streaming the remote URL makes Chromium report duration=Infinity
// and stop playback after a few seconds. Downloading the file as a Blob first
// lets the browser scan the full payload and play to the end reliably.
//
// Cache global por messageId: o inbox refaz a query a cada 5s e o realtime
// invalida ao receber updates, gerando novas signed URLs. Sem cache, o player
// voltaria pro estado "Carregando áudio…" no meio da reprodução. Mantemos o
// blob por messageId pra reutilizar o mesmo objeto entre refetches.
const audioBlobCache = new Map<string, { url: string; type: string }>();
const audioInflight = new Map<string, Promise<{ url: string; type: string }>>();

function WhatsappAudio({
  messageId,
  src,
  mimetype,
  durationHint,
}: {
  messageId: string;
  src: string;
  mimetype?: string | null;
  durationHint?: number | null;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const fixedRef = useRef(false);
  const cached = audioBlobCache.get(messageId);
  const [blobUrl, setBlobUrl] = useState<string | null>(cached?.url ?? null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const existing = audioBlobCache.get(messageId);
    if (existing) {
      setBlobUrl(existing.url);
      setError(false);
      return;
    }
    setError(false);
    setBlobUrl(null);
    fixedRef.current = false;
    const pending =
      audioInflight.get(messageId) ??
      (async () => {
        const res = await fetch(src);
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.arrayBuffer();
        const type = cleanMimetype(mimetype || res.headers.get("content-type") || "audio/ogg");
        const blob = new Blob([buf], { type });
        const url = URL.createObjectURL(blob);
        const entry = { url, type };
        audioBlobCache.set(messageId, entry);
        return entry;
      })();
    audioInflight.set(messageId, pending);
    pending
      .then((entry) => {
        if (!cancelled) setBlobUrl(entry.url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        audioInflight.delete(messageId);
      });
    return () => {
      cancelled = true;
    };
    // Importante: NÃO depender de `src` — a signed URL muda a cada refetch
    // e recriaria o blob. messageId é a identidade estável do áudio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  const handleLoaded = () => {
    const el = ref.current;
    if (!el || fixedRef.current) return;
    if (!durationHint && (!Number.isFinite(el.duration) || el.duration === 0)) {
      fixedRef.current = true;
      try {
        el.currentTime = 1e101;
      } catch {
        // ignore — some browsers throw on out-of-range seek
      }
    }
  };
  const handleDurationChange = () => {
    const el = ref.current;
    if (!el) return;
    if (fixedRef.current && Number.isFinite(el.duration)) {
      try {
        el.currentTime = 0;
      } catch {
        // ignore
      }
    }
  };

  if (error) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="text-xs underline opacity-80"
      >
        Baixar áudio
      </a>
    );
  }
  if (!blobUrl) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-[200px]">
        <Mic className="h-3.5 w-3.5" />
        <span>Carregando áudio{durationHint ? ` (${fmtDuration(durationHint)})` : ""}…</span>
      </div>
    );
  }
  return (
    <audio
      ref={ref}
      src={blobUrl}
      controls
      preload="auto"
      onLoadedMetadata={handleLoaded}
      onDurationChange={handleDurationChange}
      className="max-w-[260px]"
    />
  );
}

// ============================================================
// COMPOSER (texto + anexo + áudio PTT)
// ============================================================
function Composer({
  draft,
  setDraft,
  onSendText,
  onSendMedia,
}: {
  draft: string;
  setDraft: (s: string) => void;
  onSendText: () => void;
  onSendMedia: (p: {
    base64: string;
    mimetype: string;
    filename: string;
    kind: "image" | "video" | "audio" | "document";
    caption?: string;
    previewUrl?: string;
  }) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{
    file: File;
    url: string;
    kind: "image" | "video" | "audio" | "document";
  } | null>(null);
  const [caption, setCaption] = useState("");

  // ===== Gravação de áudio via microfone =====
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordStartRef = useRef<number>(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  useEffect(() => {
    if (!isRecording) return;
    const id = window.setInterval(() => {
      setRecordSeconds(Math.floor((Date.now() - recordStartRef.current) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, [isRecording]);

  const pickRecorderMime = () => {
    const candidates = [
      "audio/ogg;codecs=opus",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
    ];
    if (typeof MediaRecorder === "undefined") return null;
    for (const c of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(c)) return c;
      } catch {}
    }
    return "";
  };

  const stopRecorderStream = () => {
    recordStreamRef.current?.getTracks().forEach((t) => t.stop());
    recordStreamRef.current = null;
  };

  const startRecording = async () => {
    if (isRecording) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Microfone não suportado neste navegador.");
      return;
    }
    const mime = pickRecorderMime();
    if (mime === null) {
      toast.error("Gravação de áudio não suportada neste navegador.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      audioChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        const recordedType = rec.mimeType || mime || "audio/webm";
        const blob = new Blob(audioChunksRef.current, { type: recordedType });
        audioChunksRef.current = [];
        stopRecorderStream();
        if (blob.size < 200) {
          toast.error("Gravação muito curta.");
          return;
        }
        // Evolution faz a transcodificação para ogg/opus quando enviamos com `encoding: true`.
        // Declaramos sempre o mimetype como audio/ogg + .ogg para o WhatsApp tratar como PTT.
        const sentMimetype = "audio/ogg";
        const sentName = `voice-${Date.now()}.ogg`;
        const file = new File([blob], sentName, { type: sentMimetype });
        // Preview imediato (blob URL) — a bolha aparece na hora,
        // o upload + envio rodam em segundo plano.
        const previewUrl = URL.createObjectURL(file);
        const b64 = await fileToBase64(file);
        onSendMedia({
          base64: b64,
          mimetype: sentMimetype,
          filename: sentName,
          kind: "audio",
          previewUrl,
        });
      };
      rec.start();
      mediaRecorderRef.current = rec;
      recordStartRef.current = Date.now();
      setRecordSeconds(0);
      setIsRecording(true);
    } catch (err: any) {
      stopRecorderStream();
      const msg = err?.name === "NotAllowedError"
        ? "Permissão de microfone negada."
        : err?.message || "Falha ao iniciar gravação.";
      toast.error(msg);
    }
  };

  const stopRecording = () => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      try { rec.stop(); } catch {}
    }
    mediaRecorderRef.current = null;
    setIsRecording(false);
  };

  const cancelRecording = () => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.ondataavailable = null as any;
        rec.onstop = null as any;
        rec.stop();
      } catch {}
    }
    audioChunksRef.current = [];
    stopRecorderStream();
    mediaRecorderRef.current = null;
    setIsRecording(false);
  };

  useEffect(() => {
    return () => {
      stopRecorderStream();
    };
  }, []);

  const handleFile = (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error("Arquivo grande demais (máx 12 MB)");
      return;
    }
    const kind = kindOf(file.type);
    setPreview({ file, url: URL.createObjectURL(file), kind });
    setCaption("");
  };

  const onPick: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = "";
  };

  const sendPreview = async () => {
    if (!preview) return;
    // Captura o estado atual antes de limpar a UI.
    const current = preview;
    const currentCaption = caption.trim() || undefined;
    const mimetype = cleanMimetype(current.file.type);
    const filename =
      current.kind === "audio"
        ? normalizeAudioFilename(current.file.name, mimetype)
        : current.file.name;
    // Limpa a UI na hora — a bolha aparece imediatamente no chat.
    // A object URL é transferida para a bolha (não revogamos aqui).
    setPreview(null);
    setCaption("");
    const b64 = await fileToBase64(current.file);
    onSendMedia({
      base64: b64,
      mimetype,
      filename,
      kind: current.kind,
      caption: currentCaption,
      previewUrl: current.url,
    });
  };

  return (
    <>
      {preview && (
        <div className="border-t border-border bg-background/80 p-3 flex items-center gap-3">
          <button
            onClick={() => {
              URL.revokeObjectURL(preview.url);
              setPreview(null);
            }}
            className="h-7 w-7 rounded-full bg-muted/60 hover:bg-muted flex items-center justify-center"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="h-12 w-12 rounded bg-muted/40 overflow-hidden flex items-center justify-center shrink-0">
            {preview.kind === "image" ? (
              <img src={preview.url} className="h-full w-full object-cover" />
            ) : preview.kind === "video" ? (
              <video src={preview.url} className="h-full w-full object-cover" />
            ) : preview.kind === "audio" ? (
              <Mic className="h-5 w-5 text-muted-foreground" />
            ) : (
              <FileText className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">{preview.file.name}</div>
            <div className="text-[10px] text-muted-foreground">{fmtBytes(preview.file.size)}</div>
            {(preview.kind === "image" || preview.kind === "video") && (
              <Input
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Adicionar legenda…"
                className="h-7 mt-1.5 text-xs"
              />
            )}
          </div>
          <Button onClick={sendPreview} size="sm">
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <div className="border-t border-border/60 p-3 flex items-end gap-2 bg-background/70 backdrop-blur-sm">
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.zip,.txt"
          onChange={onPick}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => fileInput.current?.click()}
          title="Anexar arquivo"
        >
          <Paperclip className="h-4 w-4" />
        </Button>

        {isRecording ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={cancelRecording}
              title="Cancelar gravação"
            >
              <X className="h-4 w-4" />
            </Button>
            <div className="flex-1 flex items-center gap-2 px-3 h-9 rounded-md bg-red-500/10 text-red-600 text-sm">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              Gravando… {String(Math.floor(recordSeconds / 60)).padStart(2, "0")}:
              {String(recordSeconds % 60).padStart(2, "0")}
            </div>
            <Button
              onClick={stopRecording}
              size="icon"
              className="bg-emerald-500 hover:bg-emerald-600 text-white"
              title="Enviar áudio"
            >
              <Send className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={startRecording}
              title="Gravar áudio"
            >
              <Mic className="h-4 w-4" />
            </Button>

            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && draft.trim()) {
                  e.preventDefault();
                  onSendText();
                }
              }}
              placeholder="Digite uma mensagem…"
              className="flex-1 rounded-full px-4 bg-muted/30 border-border/60 focus-visible:bg-card"
            />
            <Button
              onClick={onSendText}
              disabled={!draft.trim()}
              size="icon"
              className="bg-emerald-500 hover:bg-emerald-600 text-white rounded-full"
            >
              <Send className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
    </>
  );
}

