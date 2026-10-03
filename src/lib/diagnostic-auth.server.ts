import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Protege diagnósticos que podem consultar provedores ou disparar testes reais. */
export async function requireDiagnosticSuperAdmin(request: Request): Promise<Response | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return Response.json({ error: "server misconfigured" }, { status: 500 });

  const token = authHeader.slice(7);
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getClaims(token);
  const userId = data?.claims?.sub;
  if (error || !userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { data: isSuper, error: roleError } = await supabaseAdmin.rpc("is_super_admin", {
    _user_id: userId,
  });
  if (roleError || !isSuper) return Response.json({ error: "forbidden" }, { status: 403 });
  return null;
}
