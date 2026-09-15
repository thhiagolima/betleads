-- ============================================================
-- PRECALL CAMPAIGNS
-- ============================================================
CREATE TABLE public.precall_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT COALESCE(public.current_tenant_id(), '00000000-0000-0000-0000-000000000001'::uuid) REFERENCES public.tenants(id) ON DELETE CASCADE,
  nome text NOT NULL,
  filtro_id text NOT NULL DEFAULT 'vip_sem_login',
  session_id uuid REFERENCES public.whatsapp_sessions(id) ON DELETE SET NULL,
  delay_min_seconds integer NOT NULL DEFAULT 60,
  delay_max_seconds integer NOT NULL DEFAULT 180,
  status text NOT NULL DEFAULT 'rascunho',
  total_leads integer NOT NULL DEFAULT 0,
  enviados integer NOT NULL DEFAULT 0,
  respondidos integer NOT NULL DEFAULT 0,
  falhas integer NOT NULL DEFAULT 0,
  ligacoes_feitas integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT precall_campaigns_status_chk CHECK (status IN ('rascunho','rodando','pausada','concluida','cancelada')),
  CONSTRAINT precall_campaigns_delay_chk CHECK (delay_min_seconds >= 5 AND delay_max_seconds >= delay_min_seconds)
);
CREATE INDEX precall_campaigns_tenant_idx ON public.precall_campaigns(tenant_id, created_at DESC);
CREATE INDEX precall_campaigns_status_idx ON public.precall_campaigns(status) WHERE status = 'rodando';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.precall_campaigns TO authenticated;
GRANT ALL ON public.precall_campaigns TO service_role;

ALTER TABLE public.precall_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "precall_campaigns_tenant_isolation"
  ON public.precall_campaigns FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());

-- ============================================================
-- PRECALL TEMPLATES (mensagens para randomização)
-- ============================================================
CREATE TABLE public.precall_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.precall_campaigns(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL DEFAULT COALESCE(public.current_tenant_id(), '00000000-0000-0000-0000-000000000001'::uuid),
  ordem integer NOT NULL DEFAULT 0,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX precall_templates_campaign_idx ON public.precall_templates(campaign_id, ordem);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.precall_templates TO authenticated;
GRANT ALL ON public.precall_templates TO service_role;

ALTER TABLE public.precall_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "precall_templates_tenant_isolation"
  ON public.precall_templates FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());

-- ============================================================
-- PRECALL LEADS
-- ============================================================
CREATE TABLE public.precall_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.precall_campaigns(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL DEFAULT COALESCE(public.current_tenant_id(), '00000000-0000-0000-0000-000000000001'::uuid),
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  telefone_e164 text NOT NULL,
  status text NOT NULL DEFAULT 'pendente',
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  responded_at timestamptz,
  called_at timestamptz,
  template_id_used uuid REFERENCES public.precall_templates(id) ON DELETE SET NULL,
  mensagem_enviada text,
  resposta_texto text,
  observacao text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT precall_leads_status_chk CHECK (status IN ('pendente','enviado','respondido','ligar_agora','ligado','sem_resposta','falhou','cancelado')),
  CONSTRAINT precall_leads_unique_player UNIQUE (campaign_id, player_id)
);
CREATE INDEX precall_leads_campaign_idx ON public.precall_leads(campaign_id, status);
CREATE INDEX precall_leads_due_idx ON public.precall_leads(campaign_id, scheduled_at) WHERE status = 'pendente';
CREATE INDEX precall_leads_phone_recent_idx ON public.precall_leads(telefone_e164, sent_at DESC) WHERE sent_at IS NOT NULL;
CREATE INDEX precall_leads_tenant_idx ON public.precall_leads(tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.precall_leads TO authenticated;
GRANT ALL ON public.precall_leads TO service_role;

ALTER TABLE public.precall_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "precall_leads_tenant_isolation"
  ON public.precall_leads FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());

-- updated_at triggers
CREATE TRIGGER precall_campaigns_set_updated_at BEFORE UPDATE ON public.precall_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER precall_leads_set_updated_at BEFORE UPDATE ON public.precall_leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
