UPDATE public.dispatch_rate_state
   SET last_provider_error = NULL,
       backoff_until = NULL,
       updated_at = now()
 WHERE channel IN ('sms','email','call','sms_status');