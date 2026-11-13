// End user's IP for the request currently being served (server functions
// only). SpacePay forwards it to the PSP (`ip_address`, "required in practice
// by Monetipag"); Upper ignores it. `x-forwarded-for`'s first hop wins (the
// app sits behind a proxy), then `x-real-ip`, then the socket address. Outside
// a request (cron, tests) or on anything that doesn't look like an IP → null.
import { getRequestHeader, getRequestIP } from "@tanstack/react-start/server";

const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

function cleanIp(value: string | null | undefined): string | null {
  const ip = value?.trim();
  return ip && IP_PATTERN.test(ip) ? ip : null;
}

export function currentRequestIp(): string | null {
  try {
    const forwarded = getRequestHeader("x-forwarded-for")?.split(",")[0];
    return (
      cleanIp(forwarded) ?? cleanIp(getRequestHeader("x-real-ip")) ?? cleanIp(getRequestIP())
    );
  } catch {
    // No request context (cron, scripts, unit tests).
    return null;
  }
}
