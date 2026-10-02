-- Refresh PostgREST after removing the synchronous analytics triggers that
-- saturated its request workers.
notify pgrst, 'reload schema';
notify pgrst, 'reload config';
