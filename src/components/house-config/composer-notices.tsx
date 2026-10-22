// Shared amber warning banners for the composers' shortener-domain and
// e-mail-sender pickers. Gated on the `getComposerOptions` query's status so
// there's no flash of the warning while it's still loading, and a neutral
// "couldn't load" message (not the misleading "blocked"/"fallback" copy)
// when the query itself failed — a load error never permanently blocks
// sending, it's just unknown until the query succeeds or is retried.
import type { ReactNode } from "react";

import { SHORTENER_FALLBACK_WARNING } from "./short-domain-select";
import { EMAIL_BLOCKED_WARNING } from "./email-sender-select";

export const COMPOSER_OPTIONS_LOAD_ERROR = "Não foi possível carregar as opções de envio.";

function WarningBanner({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-500/35 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
      {children}
    </p>
  );
}

export function ShortenerFallbackNotice({
  isSuccess,
  isError,
  shortenerPending,
  hasVerifiedDomain,
}: {
  isSuccess: boolean;
  isError: boolean;
  shortenerPending: boolean;
  hasVerifiedDomain: boolean;
}) {
  if (isError) return <WarningBanner>{COMPOSER_OPTIONS_LOAD_ERROR}</WarningBanner>;
  if (!isSuccess) return null;
  if (shortenerPending || !hasVerifiedDomain) {
    return <WarningBanner>{SHORTENER_FALLBACK_WARNING}</WarningBanner>;
  }
  return null;
}

export function EmailBlockedNotice({
  isSuccess,
  isError,
  hasVerifiedSender,
}: {
  isSuccess: boolean;
  isError: boolean;
  hasVerifiedSender: boolean;
}) {
  if (isError) return <WarningBanner>{COMPOSER_OPTIONS_LOAD_ERROR}</WarningBanner>;
  if (!isSuccess) return null;
  if (!hasVerifiedSender) {
    return (
      <WarningBanner>
        {EMAIL_BLOCKED_WARNING}{" "}
        <a href="/configuracoes/casa" className="font-medium underline">
          Configurar
        </a>
      </WarningBanner>
    );
  }
  return null;
}
