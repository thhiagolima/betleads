-- webhook_configs: bloqueia leitura direta da coluna 'secret' para tenant members.
-- Acesso à secret deve ser feito via public.get_webhook_config_secret(_id) (SECURITY DEFINER).
REVOKE SELECT (secret) ON public.webhook_configs FROM authenticated;
REVOKE SELECT (secret) ON public.webhook_configs FROM anon;

-- call_providers: defesa em profundidade — mesmo sem política SELECT para authenticated hoje,
-- revoga colunas sensíveis para garantir que qualquer futura policy não vaze credenciais.
REVOKE SELECT (api_key, api_secret, headers_config) ON public.call_providers FROM authenticated;
REVOKE SELECT (api_key, api_secret, headers_config) ON public.call_providers FROM anon;