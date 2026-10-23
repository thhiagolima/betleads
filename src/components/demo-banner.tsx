import { Sparkles } from "lucide-react";

import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { DEMO_ENVIRONMENT_BANNER_TEXT } from "@/lib/demo-tenant";

export function DemoBanner() {
  const isDemo = useIsDemoTenant();
  if (!isDemo) return null;

  return (
    <div className="mx-4 mt-3 flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/10 p-3 text-body sm:mx-6">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <p className="font-medium text-foreground">{DEMO_ENVIRONMENT_BANNER_TEXT}</p>
    </div>
  );
}
