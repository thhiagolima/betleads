UPDATE public.dispatch_rate_state
   SET max_per_minute = 5000,
       target_per_minute = 5000,
       updated_at = now()
 WHERE channel = 'sms';