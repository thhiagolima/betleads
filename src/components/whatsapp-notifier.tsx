import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuthSession } from "@/components/auth-gate";

const PERMISSION_FLAG = "whatsapp-notif-permission-asked";

// Toca um "ding" curto usando Web Audio API (sem precisar de arquivo de áudio).
function playDing() {
  try {
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx: AudioContext = new Ctx();
    const now = ctx.currentTime;
    const tone = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.18, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    };
    // dois tons rápidos, estilo "blip-blop" de chat
    tone(880, 0, 0.18);
    tone(1320, 0.12, 0.22);
    setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch {
    // silencioso — se browser bloquear, ignora
  }
}

export function WhatsappNotifier() {
  const navigate = useNavigate();
  const lastSoundRef = useRef(0);
  const session = useAuthSession();

  useEffect(() => {
    if (!session) return;
    // Pede permissão de notificação uma única vez por device
    if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "default" &&
      !localStorage.getItem(PERMISSION_FLAG)
    ) {
      localStorage.setItem(PERMISSION_FLAG, "1");
      Notification.requestPermission().catch(() => {});
    }

    const channel = supabase
      .channel("whatsapp-notifier")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "whatsapp_messages",
          filter: "from_me=eq.false",
        },
        (payload) => {
          const msg = payload.new as any;
          if (!msg) return;

          // Não notifica mensagens já lidas / em background sync antigo
          const ts = msg.message_timestamp
            ? new Date(msg.message_timestamp).getTime()
            : Date.now();
          if (Date.now() - ts > 60_000) return;

          const sender = msg.sender_name || "Nova mensagem";
          const preview =
            msg.text ||
            (msg.message_type === "audio"
              ? "🎤 Áudio"
              : msg.message_type === "image"
                ? "📷 Imagem"
                : msg.message_type === "video"
                  ? "🎥 Vídeo"
                  : msg.message_type === "document"
                    ? "📎 Documento"
                    : "Nova mensagem");

          // Throttle de som: 1 a cada 1,5s
          const now = Date.now();
          if (now - lastSoundRef.current > 1500) {
            lastSoundRef.current = now;
            playDing();
          }

          // Toast
          toast.message(sender, {
            description: preview,
            action: {
              label: "Abrir",
              onClick: () =>
                navigate({
                  to: "/whatsapp",
                  hash: "inbox",
                  search: { tab: "inbox", chat: undefined },
                }),
            },
          });

          // Notificação nativa quando aba em background
          if (
            typeof document !== "undefined" &&
            document.hidden &&
            "Notification" in window &&
            Notification.permission === "granted"
          ) {
            try {
              const notif = new Notification(`WhatsApp · ${sender}`, {
                body: preview,
                tag: `wa-${msg.chat_id ?? msg.id}`,
                icon: "/favicon.ico",
              });
              notif.onclick = () => {
                window.focus();
                navigate({
                  to: "/whatsapp",
                  hash: "inbox",
                  search: { tab: "inbox", chat: undefined },
                });
                notif.close();
              };
            } catch {
              // ignore
            }
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [navigate, session?.user.id]);

  return null;
}