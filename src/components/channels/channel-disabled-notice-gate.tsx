// Task 10: aviso "Ciente" quando um canal da casa é desligado. Design:
// docs/superpowers/specs/2026-11-05-contas-padrao-canais-por-casa-design.md,
// §4. Mounted next to OnboardingGate (src/routes/__root.tsx): one channel's
// notice at a time, overlay like OnboardingGate's wizard. The super admin
// never sees it (the server already returns `[]` for it; `enabled: false`
// here also skips the fetch).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { PROVIDER_CHANNEL_LABEL } from "@/lib/provider-accounts.shared";
import { ackChannelNotice, getPendingChannelNotices } from "@/lib/tenant-channel-notices.functions";
import type { ProviderChannel } from "@/lib/tenant-channels.shared";

const PENDING_CHANNEL_NOTICES_QUERY_KEY = ["pending-channel-notices"];

type PendingNotice = { channel: ProviderChannel; disabledAt: string };

export function ChannelDisabledNoticeGate({ children }: { children: React.ReactNode }) {
  const { active } = useActiveTenant();
  const isSuperAdmin = active?.role === "super_admin";
  const queryClient = useQueryClient();

  const fetchNotices = useServerFn(getPendingChannelNotices);
  const query = useQuery({
    queryKey: PENDING_CHANNEL_NOTICES_QUERY_KEY,
    queryFn: () => fetchNotices(),
    enabled: !isSuperAdmin,
  });

  const ack = useServerFn(ackChannelNotice);
  const mutation = useMutation({
    mutationFn: (notice: PendingNotice) =>
      ack({
        data: {
          tenantId: active?.id ?? "",
          channel: notice.channel,
          disabledAt: notice.disabledAt,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PENDING_CHANNEL_NOTICES_QUERY_KEY });
    },
  });

  const pending = (query.data as PendingNotice[] | undefined)?.[0] ?? null;
  if (isSuperAdmin || !pending) return <>{children}</>;

  return (
    <>
      {children}
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
        <div className="max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-lg">
          <p className="text-sm text-foreground">
            O canal {PROVIDER_CHANNEL_LABEL[pending.channel]} foi desabilitado para a sua casa pela
            BetLeads. Ele não aparece mais no painel, e os passos desse canal nas jornadas serão
            pulados.
          </p>
          <Button
            onClick={() => mutation.mutate(pending)}
            disabled={mutation.isPending}
          >
            Ciente
          </Button>
        </div>
      </div>
    </>
  );
}
