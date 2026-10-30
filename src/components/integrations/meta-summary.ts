import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getMetaConnectionSummary } from "@/lib/meta.functions";

/** Status de `marketing_integrations` (provider "meta"), usado só quando não há conexão. */
export type MarketingIntegration = {
  provider: string;
  status: string;
};

export type MetaAccount = {
  id: string;
  /** Conexão preferida: a chave que o worker tenta primeiro. */
  connection_id: string;
  /** Conexões (chaves) com acesso ativo a esta conta (MB1, tabela N:N). */
  access_connection_ids: string[];
  meta_ad_account_id: string;
  account_id: string | null;
  name: string | null;
  business_id: string | null;
  business_name: string | null;
  currency: string | null;
  selected: boolean | null;
  last_sync_at: string | null;
  sync_status: "never" | "queued" | "syncing" | "healthy" | "warning" | "error";
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_row_count: number;
};

export type MetaConnection = {
  id: string;
  meta_user_name: string | null;
  scopes: string[] | null;
  status: string;
  last_error: string | null;
  last_sync_at: string | null;
  token_hint: string | null;
  token_validated_at: string | null;
  permissions_checked_at: string | null;
  app_id: string | null;
  app_name: string | null;
  business_id: string | null;
  connection_label: string | null;
  /** Última leitura da lista de contas da chave na Meta. */
  accounts_discovered_at: string | null;
  auth_type: "legacy_oauth" | "system_user_token";
};

export type MetaSummary = {
  accounts: MetaAccount[];
  connections: MetaConnection[];
};

const META_CONNECTION_SUMMARY_KEY = ["meta-connection-summary"] as const;

/** Lê as conexões e contas Meta da casa (a mesma query de Aquisição e LTV). */
export function useMetaConnectionSummary() {
  const fetchMetaSummary = useServerFn(getMetaConnectionSummary);
  return useQuery({
    queryKey: META_CONNECTION_SUMMARY_KEY,
    queryFn: async () => (await fetchMetaSummary()) as unknown as MetaSummary,
    refetchInterval: 30000,
  });
}
