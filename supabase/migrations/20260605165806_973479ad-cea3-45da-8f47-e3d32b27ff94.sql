-- Chat inbox tables (JivoChat + provider-agnostic)

CREATE TABLE public.chat_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL UNIQUE,            -- 'jivochat', 'digisac', ...
  account_id text,                          -- ex: JivoChat widget/channel ID
  api_token text,                           -- token de API (escopo: server-only)
  webhook_secret text,                      -- shared secret p/ validar webhook
  extra jsonb NOT NULL DEFAULT '{}'::jsonb, -- campos extras por provedor
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_providers TO authenticated;
GRANT ALL ON public.chat_providers TO service_role;
ALTER TABLE public.chat_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated manage chat_providers"
  ON public.chat_providers FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
CREATE TRIGGER trg_chat_providers_updated_at
  BEFORE UPDATE ON public.chat_providers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_id text NOT NULL,                -- ID da conversa no provedor
  visitor_name text,
  visitor_email text,
  visitor_phone text,
  visitor_ip text,
  visitor_page text,                        -- URL onde abriu o chat
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open',      -- open | pending | closed
  assigned_to uuid,                         -- auth.users id do agente
  unread_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  last_message_preview text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, external_id)
);
CREATE INDEX idx_chat_conv_status_lastmsg ON public.chat_conversations(status, last_message_at DESC);
CREATE INDEX idx_chat_conv_player ON public.chat_conversations(player_id);
CREATE INDEX idx_chat_conv_phone ON public.chat_conversations(visitor_phone);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_conversations TO authenticated;
GRANT ALL ON public.chat_conversations TO service_role;
ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated manage chat_conversations"
  ON public.chat_conversations FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
CREATE TRIGGER trg_chat_conv_updated_at
  BEFORE UPDATE ON public.chat_conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  direction text NOT NULL,                  -- 'in' | 'out'
  sender_type text NOT NULL,                -- visitor | agent | system | bot
  sender_name text,
  sender_user_id uuid,                      -- auth.users id quando agente
  body text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_message_id text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_msgs_conv_sent ON public.chat_messages(conversation_id, sent_at);
CREATE UNIQUE INDEX uq_chat_msgs_provider_msg ON public.chat_messages(conversation_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_messages TO authenticated;
GRANT ALL ON public.chat_messages TO service_role;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated manage chat_messages"
  ON public.chat_messages FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
ALTER TABLE public.chat_conversations REPLICA IDENTITY FULL;
ALTER TABLE public.chat_messages REPLICA IDENTITY FULL;
