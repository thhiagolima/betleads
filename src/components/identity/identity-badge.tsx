import { cn } from "@/lib/utils";

import {
  CHANNEL_IDENTITY,
  CHANNEL_LABEL,
  channelKind,
  type ChannelKind,
  type IdentityTone,
} from "./identity";

/** Icon + label in the kind's colour, thin border, no fill ("E" style). Inline. */
export function IdentityBadge({
  tone,
  label,
  className,
  iconOnly = false,
}: {
  tone: IdentityTone;
  label: string;
  className?: string;
  /** Square badge with just the icon; the label stays for screen readers. */
  iconOnly?: boolean;
}) {
  const Icon = tone.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border text-meta font-semibold",
        iconOnly ? "size-7 justify-center" : "px-2 py-0.5",
        tone.border,
        tone.text,
        className,
      )}
      title={iconOnly ? label : undefined}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {iconOnly ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}

/** Big icon tile in the kind's colour (ficha header, timeline). */
export function IdentityIcon({
  tone,
  className,
  size = "md",
}: {
  tone: IdentityTone;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const Icon = tone.icon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center border",
        size === "lg"
          ? "size-10 rounded-xl"
          : size === "md"
            ? "size-9 rounded-lg"
            : "size-7 rounded-md",
        tone.border,
        tone.text,
        className,
      )}
    >
      <Icon className={size === "lg" ? "size-5" : "size-4"} />
    </span>
  );
}

/** Channel badge (SMS / E-mail / Voz / WhatsApp); unknown channels render their raw name. */
export function ChannelBadge({
  channel,
  className,
  iconOnly,
}: {
  channel: ChannelKind | string;
  className?: string;
  iconOnly?: boolean;
}) {
  const kind = channelKind(channel);
  if (!kind)
    return (
      <span className={cn("text-meta text-muted-foreground", className)}>{String(channel)}</span>
    );
  return (
    <IdentityBadge
      tone={CHANNEL_IDENTITY[kind]}
      label={CHANNEL_LABEL[kind]}
      className={className}
      iconOnly={iconOnly}
    />
  );
}
