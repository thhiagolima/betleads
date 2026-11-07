// Test-only: seeds two house-owned accounts (A, B) and one platform account
// in a fake db (sms-bulk.test-support.ts) and issues their real callback
// tokens, so the callback routes are exercised with the real token store.
import type { FakeDb } from "./sms-bulk.test-support";
import {
  __resetCallbackTokensForTests,
  ensureCallbackToken,
} from "./provider-callback-tokens.server";

export const CALLBACK_TENANT = "00000000-0000-4000-8000-000000000001";
export const OWN_A = "11111111-1111-4111-8111-111111111111";
export const OWN_B = "22222222-2222-4222-8222-222222222222";
export const PLATFORM_ACCOUNT = "00000000-0000-4000-a000-00000000a002";

/** Callers stub PROVIDER_CREDENTIALS_ENCRYPTION_KEY (>= 32 chars) first. */
export async function seedCallbackAccounts(db: FakeDb) {
  __resetCallbackTokensForTests();
  db.rows("provider_accounts").push(
    {
      id: OWN_A,
      owner_tenant_id: CALLBACK_TENANT,
      callback_token_encrypted: null,
      last_callback_at: null,
    },
    {
      id: OWN_B,
      owner_tenant_id: CALLBACK_TENANT,
      callback_token_encrypted: null,
      last_callback_at: null,
    },
    {
      id: PLATFORM_ACCOUNT,
      owner_tenant_id: null,
      callback_token_encrypted: null,
      last_callback_at: null,
    },
  );
  const tokenA = await ensureCallbackToken(OWN_A);
  const tokenB = await ensureCallbackToken(OWN_B);
  __resetCallbackTokensForTests();
  return { tokenA, tokenB };
}

export function lastCallbackAt(db: FakeDb, accountId: string): unknown {
  return db.rows("provider_accounts").find((row) => row.id === accountId)?.last_callback_at;
}
