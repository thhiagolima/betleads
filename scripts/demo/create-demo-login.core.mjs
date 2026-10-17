// Demo login generator/revoker — testable core (Task 13, spec §7).
//
// create-demo-login.mjs is the CLI; this module holds the logic so a test
// can drive it against a mocked Supabase admin client (ruling R3 — this
// script must never run against production without the user's explicit
// authorization at the time; the live run happens in Task 14).
//
// A demo login is an Auth user with app_metadata.is_demo_user = true and a
// single `gestor` role in the `demo` tenant. `trg_user_roles_demo_user_guard`
// / `trg_auth_users_demo_user_guard` (Task 1) enforce the same rule in the
// database, so this is defense in depth, not the only guard.
import { randomBytes } from "node:crypto";

export const DEMO_SLUG = "demo";
const EMAIL_DOMAIN = "betleads.io";
const PASSWORD_LENGTH = 24;
const BAN_DURATION = "876000h"; // 100 years — same convention as admin.functions.ts

export function randomPassword(length = PASSWORD_LENGTH) {
  // base64url has 64 symbols/char (>=6 bits), so this is comfortably strong
  // at 24 chars (144+ bits of input).
  return randomBytes(length).toString("base64url").slice(0, length);
}

function slugifyLabel(label) {
  return (label ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `demo+<rótulo>-<8 hex>@betleads.io` (no inbox has to exist: the demo user
 * never receives a confirmation or recovery e-mail). */
export function demoEmail(label) {
  const slug = slugifyLabel(label);
  const suffix = randomBytes(4).toString("hex");
  const local = slug ? `demo+${slug}-${suffix}` : `demo+${suffix}`;
  return `${local}@${EMAIL_DOMAIN}`;
}

async function loadDemoTenant(client, demoSlug) {
  const { data, error } = await client.from("tenants").select("id,slug,is_demo").eq("slug", demoSlug).maybeSingle();
  if (error) throw new Error(`failed to load tenant '${demoSlug}': ${error.message}`);
  if (!data) throw new Error(`tenant '${demoSlug}' not found — refusing to create demo logins`);
  if (!data.is_demo) throw new Error(`tenant '${demoSlug}' is not flagged is_demo — refusing to create demo logins`);
  return data;
}

/** Creates one demo Auth user and grants it `gestor` in the demo tenant. */
export async function createDemoLogin(client, { label, expiresAt, demoSlug = DEMO_SLUG } = {}) {
  const tenant = await loadDemoTenant(client, demoSlug);
  const email = demoEmail(label);
  const password = randomPassword();
  const appMetadata = { is_demo_user: true };
  if (expiresAt) appMetadata.demo_expires_at = expiresAt;

  const { data: created, error: createError } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: appMetadata,
  });
  if (createError) throw new Error(`failed to create demo user ${email}: ${createError.message}`);
  const user = created?.user;
  if (!user?.id) throw new Error(`createUser for ${email} returned no user id`);

  const { error: roleError } = await client
    .from("user_roles")
    .insert({ user_id: user.id, tenant_id: tenant.id, role: "gestor" });
  if (roleError) {
    // Best-effort cleanup: don't leave an Auth user with no role at all.
    await client.auth.admin.deleteUser(user.id).catch(() => {});
    throw new Error(`failed to grant gestor role to ${email}: ${roleError.message}`);
  }

  return { email, password, userId: user.id, tenantId: tenant.id, expiresAt: expiresAt ?? null };
}

/** Creates `count` demo logins, all sharing `label`/`expiresAt`. */
export async function createDemoLogins(client, { count = 1, label, expiresAt, demoSlug = DEMO_SLUG } = {}) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--count must be a positive integer, got '${count}'`);
  const results = [];
  for (let i = 0; i < n; i += 1) results.push(await createDemoLogin(client, { label, expiresAt, demoSlug }));
  return results;
}

async function findUserByEmail(client, email) {
  const target = email.trim().toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`failed to list users: ${error.message}`);
    const users = data?.users ?? [];
    const found = users.find((u) => u.email?.toLowerCase() === target);
    if (found) return found;
    if (users.length < perPage) break;
  }
  return null;
}

/** Bans the Auth user (100 years — Supabase has no permanent ban) and drops
 * its `user_roles` rows. Refuses a user that isn't `is_demo_user` so a typo
 * in --revoke can't ban a real account. */
export async function revokeDemoLogin(client, { email } = {}) {
  if (!email) throw new Error("--revoke requires an email");
  const user = await findUserByEmail(client, email);
  if (!user) throw new Error(`no user found with email ${email}`);
  if (user.app_metadata?.is_demo_user !== true)
    throw new Error(`user ${email} is not a demo user (app_metadata.is_demo_user is not true) — refusing to revoke`);

  const { error: banError } = await client.auth.admin.updateUserById(user.id, { ban_duration: BAN_DURATION });
  if (banError) throw new Error(`failed to ban ${email}: ${banError.message}`);

  const { error: roleError } = await client.from("user_roles").delete().eq("user_id", user.id);
  if (roleError) throw new Error(`failed to remove roles for ${email}: ${roleError.message}`);

  return { email, userId: user.id };
}
