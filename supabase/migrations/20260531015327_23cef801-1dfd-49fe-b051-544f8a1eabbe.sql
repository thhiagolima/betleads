GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_scripts TO authenticated;
GRANT ALL ON public.call_scripts TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_audio_generations TO authenticated;
GRANT ALL ON public.call_audio_generations TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_queue TO authenticated;
GRANT ALL ON public.call_queue TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_history TO authenticated;
GRANT ALL ON public.call_history TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_providers TO authenticated;
GRANT ALL ON public.call_providers TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flows TO authenticated;
GRANT ALL ON public.call_flows TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_scripts TO authenticated;
GRANT ALL ON public.call_flow_scripts TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_post_action TO authenticated;
GRANT ALL ON public.call_flow_post_action TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_executions TO authenticated;
GRANT ALL ON public.call_flow_executions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_blocks TO authenticated;
GRANT ALL ON public.call_flow_blocks TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_block_sms TO authenticated;
GRANT ALL ON public.call_flow_block_sms TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_progress TO authenticated;
GRANT ALL ON public.call_flow_progress TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_flow_history TO authenticated;
GRANT ALL ON public.call_flow_history TO service_role;