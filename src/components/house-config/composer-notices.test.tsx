import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  COMPOSER_OPTIONS_LOAD_ERROR,
  EmailBlockedNotice,
  ShortenerFallbackNotice,
} from "./composer-notices";
import { SHORTENER_FALLBACK_WARNING } from "./short-domain-select";
import { EMAIL_BLOCKED_WARNING } from "./email-sender-select";

describe("ShortenerFallbackNotice", () => {
  it("shows nothing while the composer options are still loading", () => {
    expect(
      renderToStaticMarkup(
        <ShortenerFallbackNotice
          isSuccess={false}
          isError={false}
          shortenerPending={false}
          hasVerifiedDomain={false}
        />,
      ),
    ).toBe("");
  });

  it("shows a neutral load-error notice, never the fallback copy, when the query failed", () => {
    const html = renderToStaticMarkup(
      <ShortenerFallbackNotice
        isSuccess={false}
        isError
        shortenerPending={false}
        hasVerifiedDomain={false}
      />,
    );
    expect(html).toContain(COMPOSER_OPTIONS_LOAD_ERROR);
    expect(html).not.toContain(SHORTENER_FALLBACK_WARNING);
  });

  it("shows nothing once loaded with a verified domain and nothing pending", () => {
    expect(
      renderToStaticMarkup(
        <ShortenerFallbackNotice
          isSuccess
          isError={false}
          shortenerPending={false}
          hasVerifiedDomain
        />,
      ),
    ).toBe("");
  });

  it("shows the fallback warning once loaded without a verified domain", () => {
    const html = renderToStaticMarkup(
      <ShortenerFallbackNotice
        isSuccess
        isError={false}
        shortenerPending={false}
        hasVerifiedDomain={false}
      />,
    );
    expect(html).toContain(SHORTENER_FALLBACK_WARNING);
  });
});

describe("EmailBlockedNotice", () => {
  it("shows nothing while the composer options are still loading", () => {
    expect(
      renderToStaticMarkup(
        <EmailBlockedNotice isSuccess={false} isError={false} hasVerifiedSender={false} />,
      ),
    ).toBe("");
  });

  it("shows a neutral load-error notice, never the blocked copy, when the query failed", () => {
    const html = renderToStaticMarkup(
      <EmailBlockedNotice isSuccess={false} isError hasVerifiedSender={false} />,
    );
    expect(html).toContain(COMPOSER_OPTIONS_LOAD_ERROR);
    expect(html).not.toContain(EMAIL_BLOCKED_WARNING);
  });

  it("shows nothing once loaded with a verified sender", () => {
    expect(
      renderToStaticMarkup(
        <EmailBlockedNotice isSuccess isError={false} hasVerifiedSender />,
      ),
    ).toBe("");
  });

  it("shows the blocked warning with a link to the house config once loaded without a verified sender", () => {
    const html = renderToStaticMarkup(
      <EmailBlockedNotice isSuccess isError={false} hasVerifiedSender={false} />,
    );
    expect(html).toContain(EMAIL_BLOCKED_WARNING);
    expect(html).toContain('href="/configuracoes/casa"');
  });
});
