-- Suporte ao dedup global de mensagens fromMe no webhook do Evolution.
-- O lookup roda em cada evento messages.upsert com fromMe=true.
CREATE INDEX IF NOT EXISTS idx_wmsg_evo_msgid_fromme
  ON public.whatsapp_messages (evolution_message_id)
  WHERE from_me = true AND evolution_message_id IS NOT NULL;
