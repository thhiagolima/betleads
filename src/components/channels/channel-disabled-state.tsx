import { Mail, MessageSquare, Phone, Send, type LucideIcon } from "lucide-react";

import { EmptyState } from "@/components/ui-premium/empty-state";
import { PROVIDER_CHANNEL_LABEL } from "@/lib/provider-accounts.shared";
import { CHANNEL_DISABLED_MESSAGE, type ProviderChannel } from "@/lib/tenant-channels.shared";

const CHANNEL_ICON: Record<ProviderChannel, LucideIcon> = {
  sms: MessageSquare,
  email: Mail,
  voice: Phone,
  webpush: Send,
};

/**
 * Shown instead of the channel page when the house reaches a channel route
 * directly (link, bookmark, old automation) while the super admin has
 * turned that channel off (design §4). The one-time "Ciente" notice on
 * shell load is a separate piece (Task 10) — this is just the route guard.
 */
export function ChannelDisabledState({ channel }: { channel: ProviderChannel }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <EmptyState
      icon={<Icon aria-hidden="true" />}
      title={`Canal ${PROVIDER_CHANNEL_LABEL[channel]} desabilitado`}
      description={CHANNEL_DISABLED_MESSAGE(channel)}
    />
  );
}
