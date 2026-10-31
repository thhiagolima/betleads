import type {
  MetaAccount,
  MetaBackfillRun,
  MetaConnection,
  MetaSummary,
} from "@/components/integrations/meta-summary";

// Fixtures dos testes de componente da aba Meta Ads.

export const NOW = new Date("2026-10-30T15:00:00.000Z");

export function connection(overrides: Partial<MetaConnection> = {}): MetaConnection {
  return {
    id: "conn-1",
    meta_user_name: "Usuário Mídia",
    scopes: ["ads_read"],
    status: "connected",
    last_error: null,
    last_sync_at: null,
    token_hint: "EAAG••••a3f9",
    token_validated_at: "2026-10-29T12:00:00.000Z",
    permissions_checked_at: "2026-10-29T12:00:00.000Z",
    app_id: "app-1",
    app_name: "Betleads Ads",
    business_id: null,
    connection_label: "Mídia Interna",
    accounts_discovered_at: "2026-10-29T12:00:00.000Z",
    auth_type: "system_user_token",
    token_type: "SYSTEM_USER",
    token_expires_at: null,
    data_access_expires_at: null,
    health_checked_at: "2026-10-29T12:00:00.000Z",
    ...overrides,
  };
}

export function account(overrides: Partial<MetaAccount> = {}): MetaAccount {
  return {
    id: "acc-1",
    connection_id: "conn-1",
    access_connection_ids: ["conn-1"],
    meta_ad_account_id: "act_123",
    account_id: "123",
    name: "SA - Captação 01",
    business_id: "bm-1",
    business_name: "Sorte Alta",
    currency: "BRL",
    selected: false,
    last_sync_at: null,
    sync_status: "never",
    last_attempt_at: null,
    last_success_at: null,
    last_error: null,
    last_row_count: 0,
    created_at: "2026-09-01T12:00:00.000Z",
    account_status: 1,
    timezone_name: "America/Sao_Paulo",
    ...overrides,
  };
}

export function backfill(overrides: Partial<MetaBackfillRun> = {}): MetaBackfillRun {
  return {
    id: "run-1",
    status: "running",
    total_accounts: 5,
    processed_accounts: 2,
    successful_accounts: 2,
    failed_accounts: 0,
    created_at: "2026-10-30T14:00:00.000Z",
    finished_at: null,
    ...overrides,
  };
}

export function summary(overrides: Partial<MetaSummary> = {}): MetaSummary {
  return { connections: [], accounts: [], latestBackfill: null, ...overrides };
}
