// Web push (OneSignal) — Task 5: fetches the house site's OneSignal worker
// file and checks it is reachable, served as JS, and has the right content.
// Server-only.
import { WORKER_FILE_CONTENT, WORKER_PATH } from "./shared";

const TIMEOUT_MS = 10_000;
const EXPECTED_SNIPPET = "OneSignalSDK.sw.js";

export type WorkerCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: "nao_encontrado" | "html" | "tipo_errado" | "conteudo_errado" | "inacessivel";
    };

function evaluateResponse(response: Response, body: string): WorkerCheckResult {
  if (response.status === 404) return { ok: false, reason: "nao_encontrado" };
  if (!response.ok) return { ok: false, reason: "inacessivel" };

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("html")) return { ok: false, reason: "html" };
  if (!contentType.includes("javascript")) return { ok: false, reason: "tipo_errado" };
  if (!body.includes(EXPECTED_SNIPPET)) return { ok: false, reason: "conteudo_errado" };

  return { ok: true };
}

async function fetchOnce(url: string): Promise<Response> {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * GETs `origin + WORKER_PATH` without following a redirect to a different
 * host (only a same-host redirect may be followed, once). Any network error,
 * cross-host redirect or second redirect is reported as `inacessivel`.
 */
export async function checkWorkerFile(origin: string): Promise<WorkerCheckResult> {
  const url = `${origin}${WORKER_PATH}`;

  let response: Response;
  try {
    response = await fetchOnce(url);
  } catch {
    return { ok: false, reason: "inacessivel" };
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) return { ok: false, reason: "inacessivel" };

    let redirectUrl: URL;
    let requestHost: string;
    try {
      redirectUrl = new URL(location, url);
      requestHost = new URL(url).host;
    } catch {
      return { ok: false, reason: "inacessivel" };
    }

    if (redirectUrl.host !== requestHost) return { ok: false, reason: "inacessivel" };

    let followed: Response;
    try {
      followed = await fetchOnce(redirectUrl.toString());
    } catch {
      return { ok: false, reason: "inacessivel" };
    }
    if (followed.status >= 300 && followed.status < 400) {
      // Only one same-host redirect may be followed.
      return { ok: false, reason: "inacessivel" };
    }
    const followedBody = await followed.text();
    return evaluateResponse(followed, followedBody);
  }

  const body = await response.text();
  return evaluateResponse(response, body);
}
