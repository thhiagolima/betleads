-- PostgreSQL only permits a newly-added enum value to be used after the
-- transaction that added it commits. Keep this migration separate from the
-- data conversion in 20261003093000_tenant_admin_gestor_model.sql.
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'gestor';
