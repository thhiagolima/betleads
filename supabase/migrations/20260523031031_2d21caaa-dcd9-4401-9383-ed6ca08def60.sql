-- Conversas (contatos) por sessão
CREATE TABLE public.whatsapp_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.whatsapp_sessions(id) ON DELETE CASCADE,
  remote_jid text NOT NULL,
  phone text,
  name text,
  profile_pic_url text,
  is_group boolean NOT NULL DEFAULT false,
  unread_count integer NOT NULL DEFAULT 0,
  last_message text,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, remote_jid)
);

CREATE INDEX idx_whatsapp_chats_session_last ON public.whatsapp_chats (session_id, last_message_at DESC NULLS LAST);

ALTER TABLE public.whatsapp_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access whatsapp_chats" ON public.whatsapp_chats
  FOR ALL TO authenticated USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

CREATE TRIGGER trg_whatsapp_chats_updated_at BEFORE UPDATE ON public.whatsapp_chats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Mensagens
CREATE TABLE public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.whatsapp_chats(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.whatsapp_sessions(id) ON DELETE CASCADE,
  evolution_message_id text,
  remote_jid text NOT NULL,
  from_me boolean NOT NULL DEFAULT false,
  message_type text NOT NULL DEFAULT 'text',
  text text,
  media_url text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text,
  message_timestamp timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, evolution_message_id)
);

CREATE INDEX idx_whatsapp_messages_chat_ts ON public.whatsapp_messages (chat_id, message_timestamp DESC);

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access whatsapp_messages" ON public.whatsapp_messages
  FOR ALL TO authenticated USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

-- Realtime
ALTER TABLE public.whatsapp_chats REPLICA IDENTITY FULL;
ALTER TABLE public.whatsapp_messages REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_chats;
ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_messages;