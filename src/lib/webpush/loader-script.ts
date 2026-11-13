// Web push (OneSignal) — Task 8: builds the public loader script served at
// GET /api/public/push/loader.js. Pure string builder: no `.server` imports,
// no node-only APIs (mirrors shared.ts — safe to unit test without a DB).
//
// Security: every tenant-controlled string (prompt text/labels, icon url,
// origins, app ids, token) is embedded via `safeJsonStringify`, never raw
// interpolation, so a house cannot break out of the generated <script> with
// `</script>` or script-terminator line separators.
import { POPUP_RUNTIME_JS } from "@/lib/popups/popup-runtime";
import type { PromptConfig } from "@/lib/webpush/shared";

export type LoaderScriptConfig = {
  token: string;
  apiBase: string;
  apps: Array<{ origin: string; appId: string }>;
  prompt: PromptConfig;
  /** The house has an active popup: embed the popup runtime (popups/popup-runtime.ts). */
  popups?: boolean;
};

/**
 * JSON.stringify that is also safe to embed inside an inline <script>: escapes
 * `<`, `>`, `&` (so `</script>`, `<!--` and HTML entities never form) and the
 * JS line terminators U+2028/U+2029 (which JSON allows raw but JS treats as
 * newlines, breaking string literals pre-ES2019 and confusing some parsers).
 */
function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(" ", "g"), "\\u2028")
    .replace(new RegExp(" ", "g"), "\\u2029");
}

/**
 * Builds the IIFE served as the house's loader.js: resolves the OneSignal app
 * for `location.origin` (no match → does nothing), injects the OneSignal page
 * SDK, and on init / PushSubscription "change" reports state to
 * `/api/public/push/subscribe`. Never calls `OneSignal.login` — sends only
 * `include_subscription_ids` style tagging via `addTag("blk", clickKey)`.
 *
 * Push and popups are independent: with no app for the origin the push part
 * does nothing, and the popup part runs only when `popups` is set (the
 * popup endpoint itself refuses origins the house never registered).
 */
export function buildLoaderScript(config: LoaderScriptConfig): string {
  const appsByOrigin: Record<string, string> = {};
  for (const app of config.apps) appsByOrigin[app.origin] = app.appId;

  const initOptions = {
    serviceWorkerPath: "push/onesignal/OneSignalSDKWorker.js",
    serviceWorkerParam: { scope: "/push/onesignal/" },
    notifyButton: { enable: false },
    welcomeNotification: { disable: true },
    promptOptions: {
      slidedown: {
        prompts: [
          {
            type: "push",
            autoPrompt: true,
            text: {
              actionMessage: config.prompt.promptText,
              acceptButton: config.prompt.acceptLabel,
              cancelButton: config.prompt.cancelLabel,
            },
            delay: { pageViews: 1, timeDelay: 0 },
          },
        ],
      },
    },
  };

  return `(function () {
  var APPS_BY_ORIGIN = ${safeJsonStringify(appsByOrigin)};
  var TOKEN = ${safeJsonStringify(config.token)};
  var API_BASE = ${safeJsonStringify(config.apiBase)};
  var INIT_OPTIONS = ${safeJsonStringify(initOptions)};

  var appId = APPS_BY_ORIGIN[window.location.origin];
  var PUSH_PROMPT = !!appId;
${config.popups ? POPUP_RUNTIME_JS : ""}
  if (!appId) return;

  var sdkScript = document.createElement("script");
  sdkScript.src = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";
  sdkScript.defer = true;
  document.head.appendChild(sdkScript);

  function report() {
    var subscriptionId = null;
    var optedIn = false;
    try {
      var sub = window.OneSignal && window.OneSignal.User && window.OneSignal.User.PushSubscription;
      subscriptionId = sub ? sub.id : null;
      optedIn = !!(sub && sub.optedIn);
    } catch (e) {}
    var playerId = (window.betleads && window.betleads.playerId) || null;

    try {
      fetch(API_BASE + "/api/public/push/subscribe?t=" + encodeURIComponent(TOKEN), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionId: subscriptionId, optedIn: optedIn, playerId: playerId }),
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.clickKey && window.OneSignal && window.OneSignal.User) {
            window.OneSignal.User.addTag("blk", data.clickKey);
          }
        })
        .catch(function () {});
    } catch (e) {}
  }

  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(function (OneSignal) {
    OneSignal.init(Object.assign({ appId: appId }, INIT_OPTIONS)).then(function () {
      report();
      OneSignal.User.PushSubscription.addEventListener("change", function () {
        report();
      });
    });
  });
})();
`;
}
