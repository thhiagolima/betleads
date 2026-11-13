-- Vazão das campanhas de SMS no bulk da Short Brasil (13/11/2026).
--
-- Com burst 45 por casa e 90 global, cada execução do cron (1×/min) recebia
-- no máximo ~45-70 envios: o crédito acumulado no intervalo se perdia no teto
-- do balde. Um POST bulk leva 500 destinatários, então o balde precisa
-- guardar o ritmo de um minuto, não de 3 segundos.
--
-- Global: 30 msg/s + burst 900. Pior caso em qualquer janela de 5 min:
--   900 + 30 * 300 = 9.900 mensagens (abaixo das 10.000 da conta).
-- Por casa (padrão): 25 msg/s + burst 750 (~1.500/min). Sobram 5/s do global
--   para as jornadas das outras casas enquanto uma campanha grande roda.
-- Ajustes futuros: UPDATE direto em channel_rate_limits (sem deploy).

SET LOCAL lock_timeout = '5s';

UPDATE public.channel_rate_limits
   SET per_second = 30, burst = 900,
       notes = 'Short Brasil: 10k msg/5 min por conta; 30/s + burst 900 = máx. 9.900 em 5 min',
       updated_at = now()
 WHERE provider = 'short_brasil' AND channel = 'sms' AND scope = 'global' AND tenant_id IS NULL;

UPDATE public.channel_rate_limits
   SET per_second = 25, burst = 750,
       notes = 'Padrão por casa: 25/s + burst 750 (um minuto de campanha bulk); 5/s do global ficam para as demais',
       updated_at = now()
 WHERE provider = 'short_brasil' AND channel = 'sms' AND scope = 'tenant_default' AND tenant_id IS NULL;
