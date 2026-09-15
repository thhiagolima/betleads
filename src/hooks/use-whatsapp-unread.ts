import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getWhatsappPendingTotal } from "@/lib/whatsapp.functions";

async function fetchTotal(): Promise<number> {
  try {
    const r = await getWhatsappPendingTotal();
    return r?.pending ?? 0;
  } catch {
    return 0;
  }
}

export function useWhatsappUnreadTotal(enabled = true) {
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setTotal(0);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        fetchTotal().then((n) => {
          if (!cancelled) setTotal(n);
        });
      }, 250);
    };
    refresh();
    const channel = supabase
      .channel("whatsapp-unread-total")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "whatsapp_chats" },
        refresh,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "whatsapp_messages" },
        refresh,
      )
      .subscribe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [enabled]);

  return { total };
}