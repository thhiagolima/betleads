INSERT INTO public.dispatch_rate_state (channel, target_per_minute, max_per_minute)
VALUES ('voice', 30, 30)
ON CONFLICT (channel) DO NOTHING;
