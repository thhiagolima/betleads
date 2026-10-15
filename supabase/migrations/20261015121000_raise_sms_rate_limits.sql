-- ENV-04 — limites de SMS ajustados à capacidade confirmada pela Short Brasil
-- (15/10/2026): 10.000 mensagens a cada 5 minutos para a conta inteira.
--
-- Global: 30 msg/s + burst 90 (3 s). Pior caso em qualquer janela de 5 min:
--   90 + 30 * 300 = 9.090 mensagens (~9% de folga sobre 10.000).
-- Por tenant (padrão): 15 msg/s + burst 45 — um tenant usa no máximo metade
--   da conta; o rodízio do dispatcher reparte o restante entre os demais.
-- Ajustes futuros: UPDATE direto em channel_rate_limits (sem deploy).

SET LOCAL lock_timeout = '5s';

UPDATE public.channel_rate_limits
   SET per_second = 30, burst = 90,
       notes = 'Short Brasil: 10k msg/5 min por conta (confirmado 15/10/2026); 30/s + burst 90 = máx. 9.090 em 5 min'
 WHERE provider = 'short_brasil' AND channel = 'sms' AND scope = 'global' AND tenant_id IS NULL;

UPDATE public.channel_rate_limits
   SET per_second = 15, burst = 45,
       notes = 'Padrão por tenant: 15/s (metade da conta), burst 3 s'
 WHERE provider = 'short_brasil' AND channel = 'sms' AND scope = 'tenant_default' AND tenant_id IS NULL;
