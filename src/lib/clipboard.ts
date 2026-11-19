/**
 * Copies text to the clipboard and says whether it really worked, so a screen
 * only shows "Copiado" when it is true.
 *
 * `text` may be a promise (text rendered by the server): Safari/iOS only
 * allows writing to the clipboard during the tap itself, so the write must
 * start right away — `ClipboardItem` accepts the pending text and fills it in
 * when it arrives. Without that, awaiting the server first and then copying
 * fails on iPhone ("Não foi possível copiar").
 *
 * Falls back to a hidden textarea + `execCommand("copy")` when the async
 * clipboard is missing or refuses (old browsers, in-app browsers, http).
 */
export async function copyToClipboard(text: string | Promise<string>): Promise<boolean> {
  if (typeof text !== "string") {
    if (canWriteItem()) {
      try {
        const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
        return true;
      } catch {
        // falls through: the text itself may still be copyable below
      }
    }
    let value: string;
    try {
      value = await text;
    } catch {
      return false;
    }
    return copyString(value);
  }
  return copyString(text);
}

function canWriteItem(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem !== "undefined"
  );
}

async function copyString(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // try the legacy path
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
