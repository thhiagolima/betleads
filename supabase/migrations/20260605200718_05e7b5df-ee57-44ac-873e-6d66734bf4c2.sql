DROP POLICY IF EXISTS "Authenticated manage chat_conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Authenticated manage chat_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "Authenticated manage chat_providers" ON public.chat_providers;

CREATE POLICY "Admins manage chat_conversations" ON public.chat_conversations
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins manage chat_messages" ON public.chat_messages
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins manage chat_providers" ON public.chat_providers
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));