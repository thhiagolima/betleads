-- Ligações: cria coluna de condições de saída
ALTER TABLE public.call_flows
  ADD COLUMN IF NOT EXISTS exit_conditions jsonb NOT NULL
  DEFAULT '{"login":true,"deposit":true,"first_deposit":true,"voltou_jogar":false}'::jsonb;

-- WhatsApp/Automações: muda default para incluir first_deposit
ALTER TABLE public.flows
  ALTER COLUMN exit_conditions
  SET DEFAULT '{"bet": true, "login": true, "deposit": true, "first_deposit": true, "human_takeover": true, "whatsapp_reply": true}'::jsonb;