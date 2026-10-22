// Small "Bloqueada" badge shown next to an e-mail campaign's status when its
// last send attempt was blocked (email_campaigns.blocked_reason, e.g. the
// chosen sender's domain is no longer verified). The full reason is in the
// tooltip (title) and in the accessible label.
import { Badge } from "@/components/ui/badge";

export function CampaignBlockedBadge({ reason }: { reason: string | null | undefined }) {
  if (!reason) return null;
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-destructive/40 text-destructive"
      title={reason}
      aria-label={`Envio bloqueado: ${reason}`}
    >
      Bloqueada
    </Badge>
  );
}
