
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_created_at
  ON public.whatsapp_messages (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat_created
  ON public.whatsapp_messages (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_players_ultimo_login_nulls_last
  ON public.players (ultimo_login DESC NULLS LAST);

ANALYZE public.whatsapp_messages;
ANALYZE public.players;
