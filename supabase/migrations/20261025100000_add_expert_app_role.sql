-- PostgreSQL only permits a newly-added enum value to be used after the
-- transaction that added it commits. Keep this migration separate from the
-- expert data model built on top of it in 20261025100100_expert_model.sql.
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'expert';
