import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuthSession } from "@/components/auth-gate";

export function useIsSuperAdmin() {
  const session = useAuthSession();
  const [state, setState] = useState<{ loading: boolean; isSuperAdmin: boolean }>({
    loading: true,
    isSuperAdmin: false,
  });

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id ?? null;

    async function check(userId: string | null) {
      if (!userId) {
        if (mounted) setState({ loading: false, isSuperAdmin: false });
        return;
      }
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("role", "super_admin")
        .limit(1);
      if (!mounted) return;
      setState({ loading: false, isSuperAdmin: !error && !!data && data.length > 0 });
    }

    setState({ loading: true, isSuperAdmin: false });
    void check(userId);

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  return state;
}