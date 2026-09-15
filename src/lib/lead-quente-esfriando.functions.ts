import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Retorna os IDs dos players que disparam o gatilho "Lead quente esfriando":
// sequência de 5+ dias seguidos depositando (contando de hoje pra trás, na
// timezone America/Sao_Paulo) E último login entre 3 e 7 dias atrás.
export const getLeadQuenteEsfriandoPlayerIds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ ids: string[] }> => {
    const now = Date.now();
    const iso60 = new Date(now - 60 * 86400000).toISOString();

    // 1. Players com login entre 3 e 7 dias atrás
    const PAGE = 1000;
    type P = { id: string; ultimo_login: string | null };
    const minLogin = new Date(now - 7 * 86400000).toISOString();
    const maxLogin = new Date(now - 3 * 86400000).toISOString();
    const candidates: P[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await context.supabase
        .from("players")
        .select("id,ultimo_login")
        .gte("ultimo_login", minLogin)
        .lt("ultimo_login", maxLogin)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as P[];
      candidates.push(...batch);
      if (batch.length < PAGE) break;
    }
    if (candidates.length === 0) return { ids: [] };
    const candidateSet = new Set(candidates.map((c) => c.id));

    // 2. Depósitos aprovados dos últimos 60d (todos, depois filtramos)
    type Row = { player_id: string | null; created_at: string };
    const deps: Row[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await context.supabase
        .from("deposits")
        .select("player_id,created_at")
        .eq("status", "aprovado")
        .gte("created_at", iso60)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as Row[];
      deps.push(...batch);
      if (batch.length < PAGE) break;
    }

    // 3. Para cada player candidato, calcular o set de dias (YYYY-MM-DD em SP)
    //    com depósito, e contar a maior sequência terminando em "hoje" ou
    //    voltando dia a dia. Regra: 5+ dias seguidos depositando.
    const dayByPlayer = new Map<string, Set<string>>();
    const TZ = "America/Sao_Paulo";
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    for (const d of deps) {
      if (!d.player_id || !candidateSet.has(d.player_id)) continue;
      const ymd = fmt.format(new Date(d.created_at)); // YYYY-MM-DD
      let s = dayByPlayer.get(d.player_id);
      if (!s) {
        s = new Set();
        dayByPlayer.set(d.player_id, s);
      }
      s.add(ymd);
    }

    // dia de hoje em SP
    const todayYmd = fmt.format(new Date());
    const ymdMinus = (base: string, n: number) => {
      // base é "YYYY-MM-DD"; subtrai n dias usando UTC pra evitar DST issues
      const [y, m, d] = base.split("-").map(Number);
      const t = Date.UTC(y, m - 1, d) - n * 86400000;
      const dt = new Date(t);
      const yy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(dt.getUTCDate()).padStart(2, "0");
      return `${yy}-${mm}-${dd}`;
    };

    const ids: string[] = [];
    for (const [pid, days] of dayByPlayer) {
      // maior sequência terminando em algum dia recente: começa em "hoje" e
      // se hoje não tem, tenta começar do dia mais recente com depósito.
      let seg = 0;
      // procura o primeiro dia (de hoje pra trás, até 30d) que tem depósito
      let start: string | null = null;
      for (let i = 0; i < 30; i++) {
        const day = ymdMinus(todayYmd, i);
        if (days.has(day)) {
          start = day;
          break;
        }
      }
      if (!start) continue;
      // conta sequência consecutiva a partir de start, indo pra trás
      let cursor = start;
      while (days.has(cursor)) {
        seg++;
        cursor = ymdMinus(cursor, 1);
        if (seg > 60) break;
      }
      if (seg >= 5) ids.push(pid);
    }

    return { ids };
  });