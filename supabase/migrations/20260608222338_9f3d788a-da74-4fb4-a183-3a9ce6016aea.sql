-- Permite que cada conta tenha suas próprias intenções de IA com o mesmo nome,
-- e seus próprios singletons de janela de envio / anti-ban.
ALTER TABLE public.ai_intents DROP CONSTRAINT IF EXISTS ai_intents_nome_key;
ALTER TABLE public.ai_intents ADD CONSTRAINT ai_intents_tenant_nome_key UNIQUE (tenant_id, nome);

ALTER TABLE public.antiban_settings DROP CONSTRAINT IF EXISTS antiban_settings_singleton_key;
ALTER TABLE public.antiban_settings ADD CONSTRAINT antiban_settings_tenant_singleton_key UNIQUE (tenant_id, singleton);

ALTER TABLE public.send_window_settings DROP CONSTRAINT IF EXISTS send_window_settings_singleton_key;
ALTER TABLE public.send_window_settings ADD CONSTRAINT send_window_settings_tenant_singleton_key UNIQUE (tenant_id, singleton);