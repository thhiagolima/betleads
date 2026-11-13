// Popups nas casas — código que roda no site da casa, embutido no loader do
// push (loader-script.ts). ES5 puro em string: o site da casa pode ser
// qualquer coisa, e nada aqui passa pelo bundler.
//
// POPUP_CORE_JS são só regras (página, frequência, escolha), sem DOM — os
// testes executam essa string direto. POPUP_RUNTIME_JS usa o core para buscar,
// desenhar (Shadow DOM, só textContent, nunca innerHTML com dado da casa) e
// contar eventos.

/**
 * Defines `betleadsPopupCore(storage, session)` → { matchPath, pageAllowed,
 * isDue, pick, markShown, markClicked }. `storage`/`session` are
 * localStorage/sessionStorage-like ({ getItem, setItem }); any storage error
 * is swallowed (private mode) and the popup still works for that page.
 */
export const POPUP_CORE_JS = `function betleadsPopupCore(storage, session) {
  var DAY = 86400000;

  function normPath(path) {
    var p = String(path || "/").split("?")[0].split("#")[0];
    if (p.charAt(0) !== "/") p = "/" + p;
    p = p.replace(/\\/{2,}/g, "/");
    if (p.length > 1 && p.charAt(p.length - 1) === "/") p = p.slice(0, -1);
    return p;
  }

  function matchPath(pattern, path) {
    var p = normPath(path);
    if (pattern === "/*") return true;
    if (pattern.length > 2 && pattern.slice(-2) === "/*") {
      var base = pattern.slice(0, -2);
      return p === base || p.indexOf(base + "/") === 0;
    }
    return p === pattern;
  }

  function pageAllowed(popup, path) {
    if (popup.paginasModo === "todas") return true;
    var hit = false;
    for (var i = 0; i < popup.paginas.length; i++) {
      if (matchPath(popup.paginas[i], path)) { hit = true; break; }
    }
    return popup.paginasModo === "incluir" ? hit : !hit;
  }

  function read(store, key) {
    try { var raw = store && store.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function write(store, key, value) {
    try { if (store) store.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function key(popup) { return "betleads_popup_" + popup.id; }

  function sameLocalDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  function isDue(popup, now) {
    var state = read(storage, key(popup)) || {};
    var shownThisSession = !!read(session, key(popup));
    switch (popup.frequencia) {
      case "sessao": return !shownThisSession;
      case "dia": return !state.last || !sameLocalDay(state.last, now);
      case "n_dias": return !state.last || now - state.last >= (popup.frequenciaDias || 1) * DAY;
      case "ate_clicar": return !state.clicked && !shownThisSession;
      default: return false;
    }
  }

  function pick(popups, path, now) {
    for (var i = 0; i < popups.length; i++) {
      if (pageAllowed(popups[i], path) && isDue(popups[i], now)) return popups[i];
    }
    return null;
  }

  function markShown(popup, now) {
    var state = read(storage, key(popup)) || {};
    state.last = now;
    write(storage, key(popup), state);
    write(session, key(popup), 1);
  }

  function markClicked(popup) {
    var state = read(storage, key(popup)) || {};
    state.clicked = true;
    write(storage, key(popup), state);
  }

  return { matchPath: matchPath, pageAllowed: pageAllowed, isDue: isDue, pick: pick, markShown: markShown, markClicked: markClicked };
}`;

const POPUP_STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.ov { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; padding: 16px; }
.card:focus { outline: none; }
.card { position: relative; background: #fff; color: #111827; border-radius: 14px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,.35); animation: in .18s ease-out; }
.central { width: 100%; max-width: 420px; max-height: calc(100vh - 32px); overflow-y: auto; }
.canto { position: fixed; right: 16px; bottom: 16px; width: 320px; max-width: calc(100vw - 32px); }
.rodape { position: fixed; left: 0; right: 0; bottom: 0; border-radius: 14px 14px 0 0; display: flex; align-items: center; gap: 12px; padding: 12px 48px 12px 12px; }
.rodape img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; flex: none; }
.rodape .body { padding: 0; flex: 1; min-width: 0; }
.rodape .btn { width: auto; flex: none; margin: 0; }
img.hero { display: block; width: 100%; height: auto; }
.body { padding: 16px; }
h2 { margin: 0 0 6px; padding-right: 28px; font-size: 18px; line-height: 1.3; font-weight: 700; }
p { margin: 0; font-size: 14px; line-height: 1.45; color: #374151; white-space: pre-line; }
.btn { display: block; width: 100%; margin-top: 14px; padding: 12px 16px; border: 0; border-radius: 10px; background: #111827; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; text-align: center; }
.btn:focus-visible, .x:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
.x { position: absolute; top: 8px; right: 8px; width: 32px; height: 32px; border: 0; border-radius: 999px; background: rgba(17,24,39,.65); color: #fff; font-size: 20px; line-height: 32px; cursor: pointer; padding: 0; }
@media (max-width: 480px) { .rodape { flex-wrap: wrap; } .rodape .btn { width: 100%; } }
@keyframes in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }
`;

/**
 * The popup runtime. Expects these vars in scope (the loader IIFE): TOKEN,
 * API_BASE, PUSH_PROMPT (true when the OneSignal invite may show on this
 * page). Runs once per page load; re-evaluates on SPA route changes.
 */
export const POPUP_RUNTIME_JS = `
  (function () {
    ${POPUP_CORE_JS}
    var CACHE_MS = 300000;
    var STYLES = ${JSON.stringify(POPUP_STYLES)};
    var ls = null, ss = null;
    try { ls = window.localStorage; } catch (e) {}
    try { ss = window.sessionStorage; } catch (e) {}
    var core = betleadsPopupCore(ls, ss);
    var open = false;
    var lastPath = null;
    var popupsPromise = null;

    function playerId() {
      var b = window.betleads;
      return b && b.playerId ? String(b.playerId) : "";
    }

    function loadPopups() {
      if (popupsPromise) return popupsPromise;
      var pid = playerId();
      var cacheKey = "betleads_popups_" + TOKEN.slice(0, 12) + "_" + pid;
      try {
        var cached = ss && JSON.parse(ss.getItem(cacheKey) || "null");
        if (cached && Date.now() - cached.at < CACHE_MS) {
          popupsPromise = Promise.resolve(cached.popups);
          return popupsPromise;
        }
      } catch (e) {}
      var url = API_BASE + "/api/public/popup/list?t=" + encodeURIComponent(TOKEN) + (pid ? "&p=" + encodeURIComponent(pid) : "");
      popupsPromise = fetch(url, { credentials: "omit" })
        .then(function (res) { return res.ok ? res.json() : { popups: [] }; })
        .then(function (data) {
          var list = (data && data.popups) || [];
          try { if (ss) ss.setItem(cacheKey, JSON.stringify({ at: Date.now(), popups: list })); } catch (e) {}
          return list;
        })
        .catch(function () { return []; });
      return popupsPromise;
    }

    function send(popup, kind) {
      var url = API_BASE + "/api/public/popup/event?t=" + encodeURIComponent(TOKEN);
      var body = JSON.stringify({ popupId: popup.id, kind: kind });
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
      } catch (e) {}
      try { fetch(url, { method: "POST", body: body, keepalive: true, credentials: "omit", headers: { "Content-Type": "text/plain" } }); } catch (e) {}
    }

    function safeHttps(url) {
      try { var u = new URL(url); return u.protocol === "https:" ? u.href : null; } catch (e) { return null; }
    }

    function el(tag, cls, text) {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text) node.textContent = text;
      return node;
    }

    function render(popup) {
      open = true;
      var host = document.createElement("div");
      host.setAttribute("data-betleads-popup", popup.id);
      host.style.cssText = "position:fixed;z-index:2147483646;inset:auto;";
      var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
      var style = document.createElement("style");
      style.textContent = STYLES;
      root.appendChild(style);

      var card = el("div", "card " + popup.formato);
      card.setAttribute("role", "dialog");
      if (popup.formato === "central") card.setAttribute("aria-modal", "true");
      card.tabIndex = -1;
      if (popup.titulo) card.setAttribute("aria-label", popup.titulo);

      var img = popup.imageUrl && safeHttps(popup.imageUrl);
      if (img) {
        var image = el("img", popup.formato === "rodape" ? "" : "hero");
        image.src = img;
        image.alt = popup.titulo || "";
        card.appendChild(image);
      }
      var body = el("div", "body");
      if (popup.titulo) body.appendChild(el("h2", "", popup.titulo));
      if (popup.texto) body.appendChild(el("p", "", popup.texto));
      var target = popup.botaoUrl && safeHttps(popup.botaoUrl);
      if (popup.titulo || popup.texto || (target && popup.formato !== "rodape")) card.appendChild(body);
      var button = null;
      if (target && popup.botaoLabel) {
        button = el("button", "btn", popup.botaoLabel);
        button.type = "button";
        button.addEventListener("click", function () {
          core.markClicked(popup);
          send(popup, "clique");
          window.location.href = target;
        });
        (popup.formato !== "rodape" && body.parentNode ? body : card).appendChild(button);
      }

      var close = el("button", "x", "\\u00d7");
      close.type = "button";
      close.setAttribute("aria-label", "Fechar");
      card.appendChild(close);

      var wrapper = card;
      if (popup.formato === "central") {
        wrapper = el("div", "ov");
        wrapper.appendChild(card);
        wrapper.addEventListener("click", function (ev) { if (ev.target === wrapper) dismiss(); });
      }
      root.appendChild(wrapper);

      function onKey(ev) {
        if (ev.key === "Escape") { dismiss(); return; }
        if (ev.key === "Tab" && popup.formato === "central") {
          var items = button ? [button, close] : [close];
          var active = root.activeElement || document.activeElement;
          var idx = items.indexOf(active);
          ev.preventDefault();
          items[(idx + (ev.shiftKey ? items.length - 1 : 1)) % items.length].focus();
        }
      }
      function dismiss() {
        send(popup, "fechamento");
        teardown();
      }
      function teardown() {
        document.removeEventListener("keydown", onKey, true);
        if (host.parentNode) host.parentNode.removeChild(host);
        open = false;
      }
      close.addEventListener("click", dismiss);
      document.addEventListener("keydown", onKey, true);

      document.body.appendChild(host);
      core.markShown(popup, Date.now());
      send(popup, "exibicao");
      if (popup.formato === "central") card.focus();
    }

    function pushInviteVisible() {
      return !!document.getElementById("onesignal-slidedown-container");
    }

    // The OneSignal invite and a popup never share the screen: when the invite
    // may show on this page, wait up to 8 s for it to appear, then until it closes.
    function afterPushInvite(cb) {
      var canPrompt = false;
      try { canPrompt = PUSH_PROMPT && typeof Notification !== "undefined" && Notification.permission === "default"; } catch (e) {}
      if (!canPrompt) return cb();
      var started = Date.now();
      var seen = false;
      var timer = setInterval(function () {
        var visible = pushInviteVisible();
        if (visible) seen = true;
        if ((seen && !visible) || (!seen && Date.now() - started > 8000)) {
          clearInterval(timer);
          cb();
        }
      }, 500);
    }

    function evaluate() {
      var path = window.location.pathname;
      if (open || path === lastPath) return;
      lastPath = path;
      loadPopups().then(function (popups) {
        var popup = core.pick(popups, path, Date.now());
        if (!popup) return;
        setTimeout(function () {
          afterPushInvite(function () {
            if (open || window.location.pathname !== path) return;
            if (!core.isDue(popup, Date.now())) return;
            render(popup);
          });
        }, (popup.atrasoSegundos || 0) * 1000);
      });
    }

    function hookHistory(name) {
      var original = history[name];
      if (typeof original !== "function") return;
      history[name] = function () {
        var result = original.apply(this, arguments);
        setTimeout(evaluate, 300);
        return result;
      };
    }

    function start() {
      if (!document.body) return setTimeout(start, 50);
      hookHistory("pushState");
      hookHistory("replaceState");
      window.addEventListener("popstate", function () { setTimeout(evaluate, 300); });
      evaluate();
    }
    start();
  })();
`;
