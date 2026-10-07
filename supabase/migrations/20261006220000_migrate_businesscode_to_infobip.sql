-- Infobip é o provedor único de e-mail e voz. Mantém a resposta original
-- em JSON de auditoria; apenas a coluna normalizada de provedor é migrada.
UPDATE call_history
SET provider = 'infobip'
WHERE provider IN ('businesscode', 'businesscode-voice');

UPDATE journey_step_executions
SET provider = 'infobip'
WHERE provider IN ('businesscode', 'businesscode-email', 'businesscode-voice');

UPDATE email_send_logs
SET provider_response = jsonb_set(
  COALESCE(provider_response, '{}'::jsonb),
  '{provider}',
  '"infobip"'::jsonb,
  true
)
WHERE provider_response ->> 'provider' IN ('businesscode', 'businesscode-email');
